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
import { dayRangeInZone } from '../../common/utils/day-range.util';
import { env } from '../../common/config/env';
import {
  lockCustomerForCredit,
  spendCreditOnDebt,
  reverseCreditOnDebt,
  type LockedCustomer,
} from '../debt/credit.tx';
import { cashPaidOf, paidAtSaleOf } from '../debt/credit.util';

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
        // Lock order: Store → Customer → Debts → Invoices. Store first, then
        // Customer — the order every credit-touching transaction follows.
        // `create` serialises on this row anyway via the lastInvoiceNumber
        // increment below; taking it explicitly here just makes the order
        // true at the top instead of three steps in, so a concurrent
        // sync/push (which locks the store first and then touches customer
        // rows through FK inserts) cannot form a cycle. A 40P01 deadlock is
        // unmapped by PrismaExceptionFilter and would reach the till as a
        // 500.
        await tx.$executeRaw`SELECT id FROM stores WHERE id = ${sid} FOR UPDATE`;

        let lockedCustomer: LockedCustomer | null = null;
        if (customerId) {
          lockedCustomer = await lockCustomerForCredit(tx, sid, customerId);
        }

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

        // 4) Optional linked debt for DEBT / PARTIAL, then spend any credit
        //    the customer is holding against it.
        //
        //    This fires for PARTIAL too, and that is intended: credit settles
        //    the deferred portion exactly as a later cash payment would. The
        //    resulting `paymentMethod = PARTIAL, paid = total` state is not
        //    new — a partial invoice reaches it today the moment the customer
        //    clears the debt through DebtService.pay. The create-time
        //    `paidAmount.gte(total)` check validates the SUBMITTED paid, and
        //    runs before any of this.
        if (needsCustomer) {
          const debt = await tx.debt.create({
            data: {
              amount: remaining,
              paid: new Prisma.Decimal(0),
              remaining,
              customerId: customerId!,
              invoiceId: invoice.id,
              storeId: sid,
            },
          });

          // spendCreditOnDebt is itself a no-op when there is nothing to
          // apply — this guard only exists to skip the call on the common
          // path where the customer holds no credit at all.
          if (lockedCustomer && lockedCustomer.creditBalance.gt(0)) {
            const { applied } = await spendCreditOnDebt(tx, {
              sid,
              customerId: customerId!,
              currentBalance: lockedCustomer.creditBalance,
              debtId: debt.id,
              debtRemaining: remaining,
              invoiceId: invoice.id,
            });

            if (applied.gt(0)) {
              // spendCreditOnDebt updated the invoice's paid/remaining and
              // discarded the result — re-read so what we return (and what
              // the controller sends to the till) reflects the credit that
              // was just applied, not the pre-credit snapshot from step 3.
              return tx.invoice.findUniqueOrThrow({
                where: { id: invoice.id },
                include: {
                  items: true,
                  customer: { select: { id: true, name: true, phone: true } },
                },
              });
            }
          }
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

    // Awaited, not fire-and-forget: this path can move a customer's credit,
    // and a 30s stale balance is what the cashier decides how much cash to
    // take against.
    await this.cacheInvalidator.invalidateStoreData(sid);
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
            // `source` is load-bearing here, not diagnostic: these rows feed the
            // three pre-transaction guards below, and a CREDIT payment must not
            // count as "someone has paid this".
            payments: { select: { id: true, amount: true, source: true } },
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
        // Use the provided paid amount, or recover what was actually paid AT
        // THE TILL from the invoice.
        //
        // Raw `invoice.paid` is the wrong number: DebtService.pay,
        // payForCustomer and spendCreditOnDebt all mirror repayments onto it,
        // so it climbs toward `total` as the debt is settled. Since `remaining`
        // below becomes the debt's new principal, every repayment left inside
        // this figure gets subtracted from the principal a second time — a
        // notes-only PATCH would forgive exactly what the customer had already
        // handed over, and once the debt was fully repaid `invoice.paid` hit
        // `total` and the gte(total) guard froze the invoice against any edit.
        //
        // paidAtSaleOf strips ALL repayments (cash and credit alike), which is
        // what makes it the at-sale amount. Deliberately not cashPaidOf: that
        // answers a different question about `debts.paid` and strips only
        // CREDIT rows, which is precisely how the cash case stayed broken.
        const paidAmount =
          dto.paid !== undefined
            ? new Prisma.Decimal(dto.paid)
            : paidAtSaleOf(invoice.paid, invoice.debt?.payments ?? []);
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
    // Payments funded from the customer's own credit are reversible, so they
    // must not count as "someone has paid this". Only cash locks an invoice.
    const cashPayments =
      invoice.debt?.payments.filter((p) => p.source === 'CASH') ?? [];

    if (wasDebt && !needsCustomer) {
      // Switching from DEBT/PARTIAL → CASH/ONLINE: block if cash was recorded
      if (cashPayments.length > 0) {
        throw new BadRequestException(
          'لا يمكن تغيير طريقة الدفع — الدين عليه دفعات مسجلة. قم بتسوية الدين أولاً.',
        );
      }
    }

    if (wasDebt && needsCustomer && invoice.debt) {
      // The new remaining must not fall below what was paid in CASH. Comparing
      // against debt.paid would be wrong: credit makes it non-zero from the
      // moment the debt is created, so a fully credit-covered invoice could
      // never be corrected downward.
      const alreadyPaidInCash = cashPaidOf(
        invoice.debt.paid,
        invoice.debt.payments,
      );
      if (remaining.lt(alreadyPaidInCash)) {
        throw new BadRequestException(
          `لا يمكن تعديل الفاتورة — المبلغ المتبقي الجديد (${remaining.toString()}) أقل مما تم دفعه فعلاً على الدين (${alreadyPaidInCash.toString()})`,
        );
      }
    }

    if (
      dto.discount !== undefined &&
      wasDebt &&
      invoice.debt &&
      cashPayments.length > 0
    ) {
      throw new BadRequestException(
        'لا يمكن تعديل الخصم — الدين عليه دفعات مسجلة. قم بتسوية الدين أولاً.',
      );
    }

    // 7. Execute everything in a single transaction
    const result = await this.db.$transaction(
      async (tx) => {
        // Lock order: Store → Customer → Debts → Invoices. Store first — see
        // create()'s comment. This transaction touches Products (stock
        // restore/deduct, below) after the customer lock, and SyncService.push
        // locks the store first, then reaches customer rows via FOR KEY SHARE
        // through debt.createMany — without taking the store lock here first
        // too, this transaction (Customer → Product) and a concurrent push
        // (Store → Product → Customer) can cycle. A 40P01 deadlock is unmapped
        // by PrismaExceptionFilter and would reach the till as a 500.
        await tx.$executeRaw`SELECT id FROM stores WHERE id = ${sid} FOR UPDATE`;

        // Lock order: customer first, always. When the invoice is being moved
        // to a different customer both rows are locked, ordered by id, so two
        // opposite reassignments cannot deadlock.
        const lockIds = [
          ...new Set(
            [invoice.customerId, customerId].filter((c): c is string => !!c),
          ),
        ].sort();
        const lockedById = new Map<
          string,
          Awaited<ReturnType<typeof lockCustomerForCredit>>
        >();
        for (const cid of lockIds) {
          // allowArchived: NOT what makes general editing of an archived
          // customer's invoice work — a plain PATCH already 404s earlier, at
          // the pre-transaction customer-existence check (`isDeleted: false`)
          // above, before this transaction ever opens, and this option can't
          // undo that. What it buys is the two paths that DO reach here for
          // an archived customer specifically because that check doesn't
          // apply to them: reassigning the invoice away (dto.customerId
          // points at someone else, so the pre-tx check only validates the
          // NEW customer) and converting a credit-covered DEBT/PARTIAL
          // invoice to CASH/ONLINE (needsCustomer becomes false, so customerId
          // is null and the pre-tx check never runs at all). Both still have
          // to reverse the archived customer's credit inside this
          // transaction. See the comment on lockCustomerForCredit.
          lockedById.set(
            cid,
            await lockCustomerForCredit(tx, sid, cid, { allowArchived: true }),
          );
        }

        // Reverse every credit this invoice consumed, back to the customer
        // who funded it — NOT to whoever the invoice is being moved to.
        // Crediting the new customer would transfer one person's money to
        // another with no ledger trace.
        //
        // `invoice.debt.payments` (the pre-transaction read at the top of
        // update()) is stale the moment we reach here: a concurrent
        // DebtService.payForCustomer/pay could have inserted a CREDIT payment
        // after that read but before this lock. Reading it live — now that
        // the customer lock makes the debt's payment set stand still — is
        // what makes the reversal (and the invoice.paid it writes) agree with
        // debt.paid instead of silently diverging into an unpayable,
        // permanently-500ing invoice.
        if (invoice.debt && invoice.customerId) {
          const livePayments = await tx.debtPayment.findMany({
            where: { debtId: invoice.debt.id },
            select: { id: true, amount: true, source: true },
          });
          const original = lockedById.get(invoice.customerId)!;
          original.creditBalance = await reverseCreditOnDebt(tx, {
            sid,
            customerId: invoice.customerId,
            currentBalance: original.creditBalance,
            debtId: invoice.debt.id,
            invoiceId: id,
            invoiceNumber: invoice.number,
            payments: livePayments,
            notesLabel: 'تعديل الفاتورة',
          });
        }

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
        //
        //    `debtTouched` records whether this step wrote the debt row at
        //    all. `updatedInvoice.debt` above (step c) was read AFTER the
        //    reversal but BEFORE this step runs, so it's stale the moment
        //    any of these three branches fires — independent of whether the
        //    credit re-application below applies anything.
        let debtTouched = false;
        if (wasDebt && !needsCustomer) {
          // DEBT/PARTIAL → CASH/ONLINE: delete the debt (validated above: no payments)
          if (invoice.debt) {
            await tx.debt.delete({ where: { id: invoice.debt.id } });
            debtTouched = true;
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
          debtTouched = true;
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
          debtTouched = true;

          // Re-mirror the invoice onto the debt. Step c wrote the AT-SALE
          // figures (paid = what was handed over at the till), which is right
          // for deriving the principal but drops the repayments the customer
          // has since made — leaving the invoice claiming more is outstanding
          // than the debt does. Every other money path keeps these two in
          // step (DebtService.pay, payForCustomer and spendCreditOnDebt all
          // mirror onto the invoice), so restore that here.
          //
          // paid + remaining still sums to total, so invoice_balance_consistent
          // holds; the credit re-application below then increments on top.
          const mirroredRemaining = Prisma.Decimal.max(
            newDebtRemaining,
            new Prisma.Decimal(0),
          );
          await tx.invoice.update({
            where: { id },
            data: {
              paid: total.minus(mirroredRemaining),
              remaining: mirroredRemaining,
            },
          });
        }

        // Re-apply credit to whatever the recomputed debt still owes, from the
        // customer the invoice now belongs to.
        let finalInvoice = updatedInvoice;
        let creditApplied = new Prisma.Decimal(0);
        if (needsCustomer && customerId) {
          const freshDebt = await tx.debt.findFirst({
            where: { invoiceId: id },
            select: { id: true, remaining: true },
          });
          const holder = lockedById.get(customerId);
          if (freshDebt && holder && holder.creditBalance.gt(0)) {
            const debtRemaining = new Prisma.Decimal(freshDebt.remaining);
            if (debtRemaining.gt(0)) {
              const { applied, newBalance } = await spendCreditOnDebt(tx, {
                sid,
                customerId,
                currentBalance: holder.creditBalance,
                debtId: freshDebt.id,
                debtRemaining,
                invoiceId: id,
              });
              // Write the fresh balance back onto the locked holder —
              // symmetric with the reversal above (`original.creditBalance
              // = await reverseCreditOnDebt(...)`). Nothing re-reads this
              // particular local copy later in this function today, but
              // leaving it stale here while keeping it fresh there is
              // exactly the kind of asymmetry that bites the next person
              // who adds a read after this block.
              holder.creditBalance = newBalance;
              creditApplied = applied;
            }
          }
        }

        // `updatedInvoice.debt` (step c) reflects the row AFTER the reversal
        // above but BEFORE step d's write and any credit just re-applied —
        // so it's stale whenever EITHER one touched the debt row, not only
        // when credit was re-applied. The gate used to be `applied.gt(0)`
        // alone: a PARTIAL/DEBT edit whose reversal-then-reapply round trip
        // nets to zero credit movement (e.g. cash already covers the new
        // total) still rewrites paid/remaining/isPaid in step d, and the
        // till would be told about a debt the database no longer agrees
        // with — see the fix-1 regression test below for the exact case.
        if (debtTouched || creditApplied.gt(0)) {
          finalInvoice = await tx.invoice.findUniqueOrThrow({
            where: { id },
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
        }

        return finalInvoice;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    await this.cacheInvalidator.invalidateStoreData(sid);
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
      if (query.dateFrom) {
        where.date.gte = dayRangeInZone(query.dateFrom, env.STORE_TIMEZONE).start;
      }
      if (query.dateTo) {
        // `end` is the next local midnight, so this stays exclusive.
        where.date.lt = dayRangeInZone(query.dateTo, env.STORE_TIMEZONE).end;
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
    // Day boundaries follow the shop's clock, not the container's. The
    // container runs UTC, so slicing on its clock hid every sale rung up
    // between local midnight and the zone offset.
    const { start: startOfDay, end: endOfDay, dayIso } = dayRangeInZone(
      dateStr,
      env.STORE_TIMEZONE,
    );

    const invoices = await this.db.invoice.findMany({
      where: {
        storeId: sid,
        date: { gte: startOfDay, lt: endOfDay },
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

    // Credit movements are cash-vs-revenue, not sales. Two separate lines
    // because they mean opposite things: money that entered the drawer but is
    // not revenue, and revenue recognised without any cash arriving.
    //
    // Both are NET of their reversals — the CreditReason enum is directional
    // precisely so a same-day void nets out instead of leaving a phantom.
    const creditEntries = await this.db.creditEntry.findMany({
      where: { storeId: sid, date: { gte: startOfDay, lt: endOfDay } },
      select: { delta: true, reason: true },
    });

    const totalCreditReceived = creditEntries
      .filter(
        (e) =>
          e.reason === 'OVERPAYMENT' || e.reason === 'OVERPAYMENT_REVERSED',
      )
      .reduce(
        (acc, e) => acc.plus(new Prisma.Decimal(e.delta)),
        new Prisma.Decimal(0),
      );

    const totalCreditApplied = creditEntries
      .filter(
        (e) =>
          e.reason === 'APPLIED_TO_DEBT' || e.reason === 'APPLIED_REVERSED',
      )
      .reduce(
        (acc, e) => acc.minus(new Prisma.Decimal(e.delta)),
        new Prisma.Decimal(0),
      );

    // Cash a customer hands over LATER to pay down a debt never shows up
    // above: totalCash/totalOnline filter by invoice.paymentMethod and
    // totalPaid sums invoice.paid, but a debt repayment (POST
    // /debts/:id/pay or /debts/customer/:id/pay) is not an invoice at all —
    // it writes a debt_payments row directly. Without this, that cash is
    // real money in the drawer with no line item reporting it.
    //
    // debt_payments has no storeId column, so scope through the debt
    // relation instead. CREDIT-sourced payments are excluded on purpose —
    // that money never crossed the drawer today, it was already banked as
    // credit on an earlier day (or the same day, already counted in
    // totalCreditReceived above).
    //
    // Actual cash in the drawer for the day = totalCash + totalCashDebtRepayments.
    const debtRepaymentsCash = await this.db.debtPayment.aggregate({
      where: {
        source: 'CASH',
        date: { gte: startOfDay, lt: endOfDay },
        debt: { storeId: sid },
      },
      _sum: { amount: true },
    });
    const totalCashDebtRepayments = new Prisma.Decimal(
      debtRepaymentsCash._sum.amount ?? 0,
    );

    return {
      date: dayIso,
      summary: {
        invoiceCount: invoices.length,
        totalSales: totalSales.toString(),
        totalPaid: totalPaid.toString(),
        totalCash: totalCash.toString(),
        totalOnline: totalOnline.toString(),
        totalDebt: totalDebt.toString(),
        totalCreditReceived: totalCreditReceived.toString(),
        totalCreditApplied: totalCreditApplied.toString(),
        totalCashDebtRepayments: totalCashDebtRepayments.toString(),
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
        debt: {
          select: {
            id: true,
            isPaid: true,
            payments: { select: { id: true, amount: true, source: true } },
          },
        },
      },
    });

    if (!invoice) throw new NotFoundException('الفاتورة غير موجودة');

    // Only CASH locks an invoice. A credit-funded payment is reversible and is
    // refunded below — the old guard let a fully credit-covered invoice through
    // (isPaid was true) and cascade-deleted the customer's money with it.
    const cashPayments =
      invoice.debt?.payments.filter((p) => p.source === 'CASH') ?? [];
    if (invoice.debt && !invoice.debt.isPaid && cashPayments.length > 0) {
      throw new BadRequestException(
        'لا يمكن حذف فاتورة مرتبطة بدين عليه دفعات مسجّلة. الرجاء تصحيح الفاتورة بدلاً من حذفها.',
      );
    }

    await this.db.$transaction(
      async (tx) => {
        // Lock order: Store → Customer → Debts → Invoices. Store first — see
        // create()'s comment. This transaction touches Products (stock
        // restoration, below) after the customer lock, and a concurrent
        // sync/push locks Store → Product → Customer (via FOR KEY SHARE on
        // debt.createMany) — without the store lock here first too, the two
        // can cycle. A 40P01 deadlock is unmapped by PrismaExceptionFilter
        // and would reach the till as a 500.
        await tx.$executeRaw`SELECT id FROM stores WHERE id = ${sid} FOR UPDATE`;

        // Customer lock first — same rule as create/update. allowArchived:
        // this is a reversal call site — see the comment on
        // lockCustomerForCredit.
        if (invoice.customerId) {
          const locked = await lockCustomerForCredit(
            tx,
            sid,
            invoice.customerId,
            { allowArchived: true },
          );

          // The pre-transaction `invoice` read (findFirst above) is stale by
          // the time we hold this lock: a concurrent DebtService.deletePayment
          // could have deleted the very payment this snapshot lists, or
          // payForCustomer/pay could have added a new one. Re-reading here —
          // now that the lock makes the debt's payment set stand still — is
          // what stops the CASH guard from missing a payment that landed in
          // the gap (TOCTOU) and stops the credit reversal from granting
          // money back for a payment that no longer exists (double-grant).
          //
          // isPaid is re-read live alongside the payments for the same
          // reason, and the guard below mirrors the pre-transaction one
          // exactly (`!isPaid && has a CASH payment`), not just the CASH
          // check alone — dropping the isPaid half would block deleting a
          // fully-settled historical invoice (its debt.isPaid is true) even
          // though that CASH payment is never coming back and there is
          // nothing left to lose track of. See "allows deleting a historical
          // invoice after its settled customer is archived" below.
          const liveDebt = invoice.debt
            ? await tx.debt.findFirst({
                where: { id: invoice.debt.id },
                select: {
                  isPaid: true,
                  payments: { select: { id: true, amount: true, source: true } },
                },
              })
            : null;
          const livePayments = liveDebt?.payments ?? [];
          const liveCashPayments = livePayments.filter((p) => p.source === 'CASH');

          if (liveDebt && !liveDebt.isPaid && liveCashPayments.length > 0) {
            throw new BadRequestException(
              'لا يمكن حذف فاتورة مرتبطة بدين عليه دفعات مسجّلة. الرجاء تصحيح الفاتورة بدلاً من حذفها.',
            );
          }

          // debtId/invoiceId omitted — the invoice (and its debt/payments,
          // which cascade via the FK) is deleted below in this same
          // transaction, so only the credit grant matters.
          await reverseCreditOnDebt(tx, {
            sid,
            customerId: invoice.customerId,
            currentBalance: locked.creditBalance,
            invoiceNumber: invoice.number,
            payments: livePayments,
            notesLabel: 'حذف الفاتورة',
          });
        }

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

    await this.cacheInvalidator.invalidateStoreData(sid);
  }
}
