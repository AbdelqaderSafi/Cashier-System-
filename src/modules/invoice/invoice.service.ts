import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Invoice } from 'generated/prisma/client';
import { Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { InvoiceQueryDto } from './dto/invoice-query.dto';
import { paginate, paginatedResponse } from '../../common/utils/pagination';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';
import { buildInvoiceItem, stockPiecesOf, type BuiltInvoiceItem } from './invoice-item.util';
import { applyInvoiceDiscount } from './invoice-discount.util';

export type PaginatedInvoices = {
  data: Invoice[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

@Injectable()
export class InvoiceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cacheInvalidator: CacheInvalidationService,
  ) {}

  // ─── Create Invoice ────────────────────────────────────────────────────────────
  //
  // Atomicity:    one $transaction wraps stock deduction, invoice insert, and
  //               (optionally) debt creation. Any failure rolls back the lot.
  // Stock safety: a single conditional UPDATE deducts every line at once and
  //               refuses to go negative — protects against the TOCTOU race
  //               between "check stock" and "decrement stock" under load
  //               (last-item-in-stock sold twice).
  // Numbering:    `lastInvoiceNumber` on Store is incremented atomically — the
  //               classic `MAX(number)+1` would let two concurrent invoices
  //               grab the same number under a unique-index race.
  // Idempotency:  if `clientInvoiceId` is supplied, a per-(store,key) advisory
  //               lock + lookup short-circuits retries — the client can safely
  //               re-POST after a network drop without producing a duplicate
  //               invoice or double-charging stock.
  // Money:        all arithmetic uses Prisma.Decimal — no .toFixed round-trips.

  async create(sid: string, dto: CreateInvoiceDto): Promise<Invoice> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('الفاتورة يجب أن تحتوي على بند واحد على الأقل');
    }

    const needsCustomer = dto.paymentMethod === 'DEBT' || dto.paymentMethod === 'PARTIAL';

    if (needsCustomer && !dto.customerId) {
      throw new BadRequestException('معرّف العميل مطلوب عند الدفع بالآجل أو الجزئي');
    }

    // CASH / ONLINE = بيع مباشر بدون عميل
    const customerId =
      dto.paymentMethod === 'CASH' || dto.paymentMethod === 'ONLINE'
        ? null
        : dto.customerId ?? null;

    if (customerId) {
      const customer = await this.db.customer.findFirst({
        where: { id: customerId, storeId: sid, isDeleted: false },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('العميل غير موجود');
    }

    // Dedupe before the existence check — a carton line and a loose-piece
    // line of the SAME product are two separate dto.items entries. Without
    // this, `products` (deduped by the DB) and `productIds` (not deduped)
    // would never match in length, and a perfectly valid two-line sale would
    // 404 as "product not found".
    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.db.product.findMany({
      where: { id: { in: productIds }, storeId: sid, isActive: true },
    });

    if (products.length !== productIds.length) {
      const foundIds = new Set(products.map((p) => p.id));
      const missing = productIds.filter((id) => !foundIds.has(id));
      throw new NotFoundException(
        `المنتجات التالية غير موجودة أو غير نشطة: ${missing.join(', ')}`,
      );
    }

    const productMap = new Map(products.map((p) => [p.id, p]));

    // Build invoice items from the DB product rows — prices, costs and carton
    // sizes are never taken from the request. Decimal arithmetic throughout,
    // no float drift.
    const invoiceItems = dto.items.map((item) =>
      buildInvoiceItem(
        productMap.get(item.productId)!,
        item.quantity,
        item.saleUnit,
      ),
    );

    // The line sum is the GROSS. What gets stored as `total` is the net after
    // the invoice discount — invoice_balance_consistent enforces
    // paid + remaining = total, so paying the net against a gross total would
    // be rejected by the database.
    const grossTotal = invoiceItems.reduce(
      (acc, item) => acc.plus(item.total),
      new Prisma.Decimal(0),
    );
    const { discount, total } = applyInvoiceDiscount(grossTotal, dto.discount);

    let paid: Prisma.Decimal;
    let remaining: Prisma.Decimal;

    switch (dto.paymentMethod) {
      case 'CASH':
      case 'ONLINE':
        paid = total;
        remaining = new Prisma.Decimal(0);
        break;
      case 'DEBT':
        paid = new Prisma.Decimal(0);
        remaining = total;
        break;
      case 'PARTIAL': {
        const paidAmount = new Prisma.Decimal(dto.paid!);
        if (paidAmount.gte(total)) {
          throw new BadRequestException(
            `المبلغ المدفوع يجب أن يكون أقل من المبلغ المستحق بعد الخصم (${total.toString()}) عند الدفع الجزئي`,
          );
        }
        if (paidAmount.lte(0)) {
          throw new BadRequestException('المبلغ المدفوع يجب أن يكون أكبر من صفر');
        }
        paid = paidAmount;
        remaining = total.minus(paidAmount);
        break;
      }
      default:
        paid = total;
        remaining = new Prisma.Decimal(0);
    }

    const invoice = await this.db.$transaction(
      async (tx) => {
        // 0) Idempotency short-circuit — only when the client opted in by
        //    sending a stable key (the offline outbox does this; the regular
        //    online "ring up a sale" flow doesn't and falls through).
        //
        //    pg_advisory_xact_lock keyed by (storeId, clientInvoiceId)
        //    serializes concurrent retries of the *same* invoice without
        //    blocking unrelated sales. After the lock we check the table;
        //    if the row exists, return it as-is (stock was already deducted
        //    on the original commit, so we must NOT run the side effects
        //    below).
        if (dto.clientInvoiceId) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice:create:${sid}:${dto.clientInvoiceId}`}))`;
          const existing = await tx.invoice.findFirst({
            where: { storeId: sid, clientInvoiceId: dto.clientInvoiceId },
            include: {
              items: true,
              customer: { select: { id: true, name: true, phone: true } },
            },
          });
          if (existing) return existing;
        }

        // 1) Atomic stock deduction — single conditional UPDATE that refuses
        //    to go negative. Returns the number of rows updated; if any line
        //    couldn't be deducted (insufficient stock or product gone), we
        //    bail out and the transaction rolls back.
        // Per-item conditional updateMany — each one is a single atomic
        // UPDATE on the row with a `stock >= pieces` predicate, so two
        // concurrent sales of the last unit can't both pass. We iterate the
        // BUILT items, not the DTO, because only they carry stockQuantity
        // (pieces) — a carton line must move 24 pieces, not 1.
        for (const item of invoiceItems) {
          const { count } = await tx.product.updateMany({
            where: {
              id: item.productId,
              storeId: sid,
              isActive: true,
              stock: { gte: item.stockQuantity },
            },
            data: { stock: { decrement: item.stockQuantity } },
          });
          if (count === 0) {
            // Diagnose why the conditional failed.
            const live = await tx.product.findFirst({
              where: { id: item.productId, storeId: sid },
              select: { stock: true, name: true, isActive: true },
            });
            if (!live || !live.isActive) {
              throw new BadRequestException(
                `المنتج "${item.productName}" غير متوفر أو معطّل`,
              );
            }
            // Always report pieces. A carton line would otherwise read
            // "الكمية المطلوبة (1) تتجاوز المخزون المتوفر (20)", which makes
            // no sense to a cashier.
            throw new BadRequestException(
              `الكمية المطلوبة (${item.stockQuantity} قطعة) من "${live.name}" تتجاوز المخزون المتوفر (${live.stock} قطعة)`,
            );
          }
        }

        // 2) Atomic invoice-number allocation — increment the store counter
        //    and use the returned value.
        const store = await tx.store.update({
          where: { id: sid },
          data: { lastInvoiceNumber: { increment: 1 } },
          select: { lastInvoiceNumber: true },
        });
        const nextNumber = store.lastInvoiceNumber;

        // 3) Insert invoice + items. clientInvoiceId is persisted so the
        //    next retry hits the idempotency short-circuit above.
        const invoice = await tx.invoice.create({
          data: {
            number: nextNumber,
            total,
            discount,
            paid,
            remaining,
            paymentMethod: dto.paymentMethod,
            notes: dto.notes ?? null,
            clientInvoiceId: dto.clientInvoiceId ?? null,
            customerId,
            storeId: sid,
            items: {
              create: invoiceItems,
            },
          },
          include: {
            items: true,
            customer: { select: { id: true, name: true, phone: true } },
          },
        });

        // 4) Optional linked debt for DEBT / PARTIAL.
        if (needsCustomer) {
          await tx.debt.create({
            data: {
              amount: remaining,
              paid: new Prisma.Decimal(0),
              remaining,
              customerId: customerId!,
              invoiceId: invoice.id,
              storeId: sid,
            },
          });
        }

        return invoice;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        // Concurrent invoice creates serialise on the Store row's
        // lastInvoiceNumber increment — give the queue room to drain instead
        // of falling off Prisma's 2s default.
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    void this.cacheInvalidator.invalidateStoreData(sid);
    return invoice;
  }

  // ─── Update Invoice ────────────────────────────────────────────────────────────
  //
  // Concurrency: when the items list changes, restores old stock and deducts
  //              new stock atomically via single conditional SQL statements
  //              (no per-row TOCTOU window). When a debt row exists it is
  //              locked via SELECT FOR UPDATE before reading `paid`.
  // Money:       all arithmetic uses Prisma.Decimal.

  async update(sid: string, id: string, dto: UpdateInvoiceDto): Promise<Invoice> {
    // 1. Fetch current invoice with full details
    const invoice = await this.db.invoice.findFirst({
      where: { id, storeId: sid },
      include: {
        items: {
          select: {
            id: true,
            productId: true,
            quantity: true,
            stockQuantity: true,
          },
        },
        debt: {
          select: {
            id: true,
            amount: true,
            paid: true,
            remaining: true,
            isPaid: true,
            payments: { select: { id: true } },
          },
        },
      },
    });

    if (!invoice) throw new NotFoundException('الفاتورة غير موجودة');

    // 2. Determine final payment method
    const paymentMethod = dto.paymentMethod ?? invoice.paymentMethod;
    const needsCustomer = paymentMethod === 'DEBT' || paymentMethod === 'PARTIAL';
    const wasDebt =
      invoice.paymentMethod === 'DEBT' || invoice.paymentMethod === 'PARTIAL';

    // 3. Resolve customerId
    let customerId: string | null;
    if (dto.customerId !== undefined) {
      customerId = needsCustomer ? dto.customerId : null;
    } else {
      customerId = needsCustomer ? (invoice.customerId ?? null) : null;
    }

    if (needsCustomer && !customerId) {
      throw new BadRequestException('معرّف العميل مطلوب عند الدفع بالآجل أو الجزئي');
    }

    if (customerId) {
      const customer = await this.db.customer.findFirst({
        where: { id: customerId, storeId: sid, isDeleted: false },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('العميل غير موجود');
    }

    // 4. Build new invoice items (if provided)
    let newInvoiceItems: BuiltInvoiceItem[] | null = null;
    // Start from the stored values. `invoice.total` is already net, so the
    // gross it came from is total + discount.
    let discount: Prisma.Decimal = new Prisma.Decimal(invoice.discount);
    let grossTotal: Prisma.Decimal = new Prisma.Decimal(invoice.total).plus(discount);

    if (dto.items !== undefined) {
      if (dto.items.length === 0) {
        throw new BadRequestException('الفاتورة يجب أن تحتوي على بند واحد على الأقل');
      }

      // Dedupe before the existence check — a carton line and a loose-piece
      // line of the SAME product are two separate dto.items entries, and
      // `products` comes back deduped by the DB. Without this, a valid
      // two-line update 404s as "product not found". Mirrors create().
      const productIds = [...new Set(dto.items.map((i) => i.productId))];
      const products = await this.db.product.findMany({
        where: { id: { in: productIds }, storeId: sid, isActive: true },
      });

      if (products.length !== productIds.length) {
        const foundIds = new Set(products.map((p) => p.id));
        const missing = productIds.filter((pid) => !foundIds.has(pid));
        throw new NotFoundException(
          `المنتجات التالية غير موجودة أو غير نشطة: ${missing.join(', ')}`,
        );
      }

      const productMap = new Map(products.map((p) => [p.id, p]));

      newInvoiceItems = dto.items.map((item) =>
        buildInvoiceItem(
          productMap.get(item.productId)!,
          item.quantity,
          item.saleUnit,
        ),
      );

      grossTotal = newInvoiceItems.reduce(
        (acc, item) => acc.plus(item.total),
        new Prisma.Decimal(0),
      );
    }

    // An omitted discount keeps the stored one, re-applied to whatever the
    // gross is now — otherwise editing a discounted invoice would silently
    // revert its total to the gross and overcharge the customer.
    const applied = applyInvoiceDiscount(
      grossTotal,
      dto.discount !== undefined ? dto.discount : discount,
    );
    discount = applied.discount;
    const total = applied.total;

    // 5. Calculate paid / remaining
    let paid: Prisma.Decimal;
    let remaining: Prisma.Decimal;

    switch (paymentMethod) {
      case 'CASH':
      case 'ONLINE':
        paid = total;
        remaining = new Prisma.Decimal(0);
        break;
      case 'DEBT':
        paid = new Prisma.Decimal(0);
        remaining = total;
        break;
      case 'PARTIAL': {
        // Use the provided paid amount or fall back to the invoice's existing paid amount
        const paidAmount =
          dto.paid !== undefined
            ? new Prisma.Decimal(dto.paid)
            : new Prisma.Decimal(invoice.paid);
        if (paidAmount.gte(total)) {
          throw new BadRequestException(
            `المبلغ المدفوع يجب أن يكون أقل من المبلغ المستحق بعد الخصم (${total.toString()}) عند الدفع الجزئي`,
          );
        }
        if (paidAmount.lte(0)) {
          throw new BadRequestException('المبلغ المدفوع يجب أن يكون أكبر من صفر');
        }
        paid = paidAmount;
        remaining = total.minus(paidAmount);
        break;
      }
      default:
        paid = total;
        remaining = new Prisma.Decimal(0);
    }

    // 6. Debt constraints
    if (wasDebt && !needsCustomer) {
      // Switching from DEBT/PARTIAL → CASH/ONLINE: block if payments already recorded
      if (invoice.debt && invoice.debt.payments.length > 0) {
        throw new BadRequestException(
          'لا يمكن تغيير طريقة الدفع — الدين عليه دفعات مسجلة. قم بتسوية الدين أولاً.',
        );
      }
    }

    if (wasDebt && needsCustomer && invoice.debt) {
      // Updating existing debt: new remaining must not be less than payments already made
      const alreadyPaidOnDebt = new Prisma.Decimal(invoice.debt.paid);
      if (remaining.lt(alreadyPaidOnDebt)) {
        throw new BadRequestException(
          `لا يمكن تعديل الفاتورة — المبلغ المتبقي الجديد (${remaining.toString()}) أقل مما تم دفعه فعلاً على الدين (${alreadyPaidOnDebt.toString()})`,
        );
      }
    }

    // Changing the discount moves the invoice total, and the debt recompute
    // below cannot reconcile that against payments already recorded: a DEBT
    // invoice has its `paid` reset to 0 while debts.paid keeps them (the next
    // payment then trips invoice_balance_consistent and the debt becomes
    // unpayable), and a PARTIAL invoice subtracts them twice and silently
    // writes the balance off. Refuse instead, the same way a payment-method
    // change is refused.
    if (
      dto.discount !== undefined &&
      wasDebt &&
      invoice.debt &&
      invoice.debt.payments.length > 0
    ) {
      throw new BadRequestException(
        'لا يمكن تعديل الخصم — الدين عليه دفعات مسجلة. قم بتسوية الدين أولاً.',
      );
    }

    // 7. Execute everything in a single transaction
    const result = await this.db.$transaction(
      async (tx) => {
        if (newInvoiceItems !== null) {
          // a. Restore stock for all OLD items. updateMany per item — each
          //    one is a single atomic UPDATE. stockPiecesOf() covers lines
          //    written before carton support, whose stockQuantity is NULL.
          for (const oldItem of invoice.items) {
            if (oldItem.productId) {
              await tx.product.updateMany({
                where: { id: oldItem.productId, storeId: sid },
                data: { stock: { increment: stockPiecesOf(oldItem) } },
              });
            }
          }

          // b. Atomic per-item conditional deduction for the NEW items, in
          //    pieces.
          for (const newItem of newInvoiceItems) {
            const { count } = await tx.product.updateMany({
              where: {
                id: newItem.productId,
                storeId: sid,
                isActive: true,
                stock: { gte: newItem.stockQuantity },
              },
              data: { stock: { decrement: newItem.stockQuantity } },
            });
            if (count === 0) {
              const live = await tx.product.findFirst({
                where: { id: newItem.productId, storeId: sid },
                select: { stock: true, name: true, isActive: true },
              });
              if (!live || !live.isActive) {
                throw new BadRequestException(
                  `المنتج "${newItem.productName}" غير متوفر أو معطّل`,
                );
              }
              throw new BadRequestException(
                `الكمية المطلوبة (${newItem.stockQuantity} قطعة) من "${newItem.productName}" تتجاوز المخزون المتوفر (${live.stock} قطعة)`,
              );
            }
          }
        }

        // c. Update the invoice (replace items if provided)
        const updatedInvoice = await tx.invoice.update({
          where: { id },
          data: {
            paymentMethod,
            total,
            discount,
            paid,
            remaining,
            customerId,
            notes: dto.notes !== undefined ? (dto.notes ?? null) : invoice.notes,
            ...(newInvoiceItems !== null && {
              items: {
                deleteMany: {},
                create: newInvoiceItems,
              },
            }),
          },
          include: {
            items: true,
            customer: { select: { id: true, name: true, phone: true } },
            debt: {
              select: {
                id: true,
                amount: true,
                paid: true,
                remaining: true,
                isPaid: true,
              },
            },
          },
        });

        // d. Handle debt record changes — when modifying an existing debt
        //    row, lock it first so a concurrent debt-payment can't interleave.
        if (wasDebt && !needsCustomer) {
          // DEBT/PARTIAL → CASH/ONLINE: delete the debt (validated above: no payments)
          if (invoice.debt) {
            await tx.debt.delete({ where: { id: invoice.debt.id } });
          }
        } else if (!wasDebt && needsCustomer) {
          // CASH/ONLINE → DEBT/PARTIAL: create a new debt
          await tx.debt.create({
            data: {
              amount: remaining,
              paid: new Prisma.Decimal(0),
              remaining,
              customerId: customerId!,
              invoiceId: id,
              storeId: sid,
            },
          });
        } else if (wasDebt && needsCustomer && invoice.debt) {
          // DEBT/PARTIAL → DEBT/PARTIAL: lock and update existing debt.
          const lockedDebtRows = await tx.$queryRaw<
            { id: string; paid: Prisma.Decimal }[]
          >`
            SELECT id, paid
            FROM debts
            WHERE id = ${invoice.debt.id}
              AND "storeId" = ${sid}
            FOR UPDATE
          `;
          if (lockedDebtRows.length === 0) {
            throw new NotFoundException('الدين المرتبط بالفاتورة غير موجود');
          }
          const alreadyPaid = new Prisma.Decimal(lockedDebtRows[0].paid);
          // Re-check after locking — a payment could have landed between the
          // initial read and the lock.
          if (remaining.lt(alreadyPaid)) {
            throw new BadRequestException(
              `لا يمكن تعديل الفاتورة — المبلغ المتبقي الجديد (${remaining.toString()}) أقل مما تم دفعه فعلاً على الدين (${alreadyPaid.toString()})`,
            );
          }
          const newDebtRemaining = remaining.minus(alreadyPaid);
          await tx.debt.update({
            where: { id: invoice.debt.id },
            data: {
              amount: remaining,
              remaining: Prisma.Decimal.max(newDebtRemaining, new Prisma.Decimal(0)),
              isPaid: newDebtRemaining.lte(0),
              customerId: customerId!,
            },
          });
        }

        return updatedInvoice;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    void this.cacheInvalidator.invalidateStoreData(sid);
    return result;
  }

  // ─── List (paginated + filtered) ─────────────────────────────────────────────

  async findAll(sid: string, query: InvoiceQueryDto): Promise<PaginatedInvoices> {
    const { skip, take, page, limit } = paginate(query);

    const where: Prisma.InvoiceWhereInput = { storeId: sid };

    if (query.paymentMethod) {
      where.paymentMethod = query.paymentMethod;
    }

    if (query.dateFrom || query.dateTo) {
      where.date = {};
      if (query.dateFrom) where.date.gte = new Date(query.dateFrom);
      if (query.dateTo) {
        const end = new Date(query.dateTo);
        end.setHours(23, 59, 59, 999);
        where.date.lte = end;
      }
    }

    if (query.search) {
      const num = parseInt(query.search, 10);
      if (!isNaN(num)) {
        where.number = num;
      } else {
        where.customer = {
          name: { contains: query.search, mode: 'insensitive' },
        };
      }
    }

    const [data, total] = await this.db.$transaction([
      this.db.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          _count: { select: { items: true } },
        },
        orderBy: { date: 'desc' },
        skip,
        take,
      }),
      this.db.invoice.count({ where }),
    ]);

    return paginatedResponse(data, total, page, limit);
  }

  // ─── Find one by ID ──────────────────────────────────────────────────────────

  async findOne(sid: string, id: string) {

    const invoice = await this.db.invoice.findFirst({
      where: { id, storeId: sid },
      include: {
        items: {
          select: {
            id: true,
            productName: true,
            barcode: true,
            price: true,
            quantity: true,
            total: true,
            saleUnit: true,
            stockQuantity: true,
            productId: true,
          },
        },
        customer: { select: { id: true, name: true, phone: true } },
        debt: {
          select: {
            id: true,
            amount: true,
            paid: true,
            remaining: true,
            isPaid: true,
            payments: {
              select: { id: true, amount: true, date: true, notes: true },
              orderBy: { date: 'desc' },
            },
          },
        },
      },
    });

    if (!invoice) throw new NotFoundException('الفاتورة غير موجودة');

    return invoice;
  }

  // ─── Find by invoice number ──────────────────────────────────────────────────

  async findByNumber(sid: string, invoiceNumber: number) {

    const invoice = await this.db.invoice.findFirst({
      where: { number: invoiceNumber, storeId: sid },
      include: {
        items: {
          select: {
            id: true,
            productName: true,
            barcode: true,
            price: true,
            quantity: true,
            total: true,
            saleUnit: true,
            stockQuantity: true,
            productId: true,
          },
        },
        customer: { select: { id: true, name: true, phone: true } },
        debt: {
          select: {
            id: true,
            amount: true,
            paid: true,
            remaining: true,
            isPaid: true,
            payments: {
              select: { id: true, amount: true, date: true, notes: true },
              orderBy: { date: 'desc' },
            },
          },
        },
      },
    });

    if (!invoice) throw new NotFoundException('الفاتورة غير موجودة');

    return invoice;
  }

  // ─── Daily Sales Summary ─────────────────────────────────────────────────────

  async getDailySales(sid: string, dateStr?: string) {

    const target = dateStr ? new Date(dateStr) : new Date();
    const startOfDay = new Date(target);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(target);
    endOfDay.setHours(23, 59, 59, 999);

    const invoices = await this.db.invoice.findMany({
      where: {
        storeId: sid,
        date: { gte: startOfDay, lte: endOfDay },
      },
      select: {
        id: true,
        number: true,
        total: true,
        discount: true,
        paid: true,
        remaining: true,
        paymentMethod: true,
        date: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { date: 'desc' },
    });

    const zero = new Prisma.Decimal(0);
    const totalSales = invoices.reduce(
      (acc, inv) => acc.plus(new Prisma.Decimal(inv.total)),
      zero,
    );
    const totalCash = invoices
      .filter((inv) => inv.paymentMethod === 'CASH')
      .reduce((acc, inv) => acc.plus(new Prisma.Decimal(inv.paid)), zero);
    const totalOnline = invoices
      .filter((inv) => inv.paymentMethod === 'ONLINE')
      .reduce((acc, inv) => acc.plus(new Prisma.Decimal(inv.paid)), zero);
    const totalDebt = invoices
      .filter(
        (inv) => inv.paymentMethod === 'DEBT' || inv.paymentMethod === 'PARTIAL',
      )
      .reduce((acc, inv) => acc.plus(new Prisma.Decimal(inv.remaining)), zero);
    const totalPaid = invoices.reduce(
      (acc, inv) => acc.plus(new Prisma.Decimal(inv.paid)),
      zero,
    );

    return {
      date: startOfDay.toISOString().split('T')[0],
      summary: {
        invoiceCount: invoices.length,
        totalSales: totalSales.toString(),
        totalPaid: totalPaid.toString(),
        totalCash: totalCash.toString(),
        totalOnline: totalOnline.toString(),
        totalDebt: totalDebt.toString(),
      },
      invoices,
    };
  }

  // ─── Delete (Admin only, with stock restoration) ──────────────────────────────

  async remove(sid: string, id: string): Promise<void> {

    const invoice = await this.db.invoice.findFirst({
      where: { id, storeId: sid },
      include: {
        items: { select: { productId: true, quantity: true, stockQuantity: true } },
        debt: { select: { id: true, isPaid: true, payments: { select: { id: true } } } },
      },
    });

    if (!invoice) throw new NotFoundException('الفاتورة غير موجودة');

    if (invoice.debt && !invoice.debt.isPaid && invoice.debt.payments.length > 0) {
      throw new BadRequestException(
        'لا يمكن حذف فاتورة مرتبطة بدين عليه دفعات. قم بتسوية الدين أولاً.',
      );
    }

    await this.db.$transaction(
      async (tx) => {
        for (const item of invoice.items) {
          if (item.productId) {
            await tx.product.updateMany({
              where: { id: item.productId, storeId: sid },
              data: { stock: { increment: stockPiecesOf(item) } },
            });
          }
        }

        await tx.invoice.delete({ where: { id } });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    void this.cacheInvalidator.invalidateStoreData(sid);
  }
}
