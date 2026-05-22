import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { SyncPushDto } from './dto/sync-push.dto';
import { CacheKeys, CacheTtl } from '../../common/cache/cache-keys';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly cacheInvalidator: CacheInvalidationService,
  ) {}

  // ─── Initial Sync ─────────────────────────────────────────────────────────────
  // Called when the PWA loads online. Returns all data needed to seed IndexedDB.

  async getInitData(sid: string, opts: { forceFresh?: boolean } = {}) {
    const key = CacheKeys.syncInit(sid);

    if (!opts.forceFresh) {
      const cached = await this.cache.get<{
        products: unknown[];
        customers: unknown[];
        debts: unknown[];
      }>(key);
      if (cached) return cached;
    }

    const fresh = await this.fetchInitData(sid);
    await this.cache.set(key, fresh, CacheTtl.SYNC_INIT);
    return fresh;
  }

  private async fetchInitData(sid: string) {
    const [products, customers, debts] = await Promise.all([
      this.db.product.findMany({
        where: { storeId: sid, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.db.customer.findMany({
        where: { storeId: sid, isDeleted: false },
        orderBy: { name: 'asc' },
      }),
      this.db.debt.findMany({
        where: { storeId: sid, isPaid: false },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          invoice: { select: { id: true, number: true, date: true } },
          payments: {
            select: { id: true, amount: true, date: true, notes: true },
            orderBy: { date: 'desc' },
          },
        },
        orderBy: { date: 'desc' },
      }),
    ]);

    return { products, customers, debts };
  }

  // ─── Bulk Push ────────────────────────────────────────────────────────────────
  // Receives offline-created records in a single atomic transaction.
  //
  // Cross-tenant: every customer/product/invoice referenced in the payload is
  //               verified against `storeId = sid` *before* any write — closes
  //               the IDOR that allowed pushing rows attached to a foreign
  //               store's customer or product.
  // Idempotency:  pre-fetched existing IDs are filtered out, then `createMany`
  //               with `skipDuplicates: true` handles any remaining race.
  // Numbering:    one atomic `lastInvoiceNumber: { increment: N }` allocates N
  //               consecutive numbers for the whole batch (vs. N round-trips).
  // Money:        all arithmetic uses Prisma.Decimal. Debt overpayment is a
  //               hard reject (4xx) — no more silent capping.
  // Atomicity:    one `$transaction` wraps everything; any failure rolls back.

  async push(sid: string, dto: SyncPushDto) {
    // Collect every referenced ID once so the validation queries are batched.
    const inPayloadInvoiceIds = new Set(dto.invoices.map((i) => i.id));

    const customerIdsReferenced = new Set<string>();
    for (const inv of dto.invoices) {
      if (inv.customerId) customerIdsReferenced.add(inv.customerId);
    }
    for (const d of dto.debts) {
      customerIdsReferenced.add(d.customerId);
    }

    const productIdsReferenced = new Set<string>();
    for (const inv of dto.invoices) {
      for (const item of inv.items) {
        if (item.productId) productIdsReferenced.add(item.productId);
      }
    }

    // Debts may reference invoices that are NOT in this payload (e.g. paying
    // off an older invoice). Those must already live under this store.
    const externalInvoiceIds = new Set<string>();
    for (const d of dto.debts) {
      if (d.invoiceId && !inPayloadInvoiceIds.has(d.invoiceId)) {
        externalInvoiceIds.add(d.invoiceId);
      }
    }

    const result = await this.db.$transaction(
      async (tx) => {
        // ── Step 0 — Cross-tenant validation ──────────────────────────────────
        if (customerIdsReferenced.size > 0) {
          const valid = await tx.customer.count({
            where: {
              id: { in: [...customerIdsReferenced] },
              storeId: sid,
            },
          });
          if (valid !== customerIdsReferenced.size) {
            throw new ForbiddenException(
              'أحد العملاء في الـ payload لا ينتمي إلى متجرك',
            );
          }
        }

        if (productIdsReferenced.size > 0) {
          const valid = await tx.product.count({
            where: {
              id: { in: [...productIdsReferenced] },
              storeId: sid,
            },
          });
          if (valid !== productIdsReferenced.size) {
            throw new ForbiddenException(
              'أحد المنتجات في الـ payload لا ينتمي إلى متجرك',
            );
          }
        }

        if (externalInvoiceIds.size > 0) {
          const valid = await tx.invoice.count({
            where: {
              id: { in: [...externalInvoiceIds] },
              storeId: sid,
            },
          });
          if (valid !== externalInvoiceIds.size) {
            throw new ForbiddenException(
              'إحدى الفواتير المرجعية في الـ payload لا تنتمي إلى متجرك',
            );
          }
        }

        const report = {
          invoices: { inserted: 0, skipped: 0 },
          debts: { inserted: 0, skipped: 0 },
          debtPayments: { inserted: 0, skipped: 0 },
        };

        // ── Step 1 — Invoices ──────────────────────────────────────────────────
        if (dto.invoices.length > 0) {
          const existingInvoiceIds = new Set(
            (
              await tx.invoice.findMany({
                where: { id: { in: dto.invoices.map((i) => i.id) } },
                select: { id: true },
              })
            ).map((r) => r.id),
          );
          const newInvoices = dto.invoices.filter(
            (i) => !existingInvoiceIds.has(i.id),
          );
          report.invoices.skipped = existingInvoiceIds.size;

          if (newInvoices.length > 0) {
            // One atomic counter bump allocates all N numbers at once.
            // The block we own is (lastInvoiceNumber - N + 1 .. lastInvoiceNumber).
            const store = await tx.store.update({
              where: { id: sid },
              data: { lastInvoiceNumber: { increment: newInvoices.length } },
              select: { lastInvoiceNumber: true },
            });
            const firstNumber =
              store.lastInvoiceNumber - newInvoices.length + 1;

            await tx.invoice.createMany({
              data: newInvoices.map((invoice, idx) => ({
                id: invoice.id,
                number: firstNumber + idx,
                date: new Date(invoice.date),
                total: new Prisma.Decimal(invoice.total),
                paid: new Prisma.Decimal(invoice.paid),
                remaining: new Prisma.Decimal(invoice.remaining),
                paymentMethod: invoice.paymentMethod,
                notes: invoice.notes ?? null,
                customerId: invoice.customerId ?? null,
                storeId: sid,
              })),
              skipDuplicates: true,
            });

            // Flatten every item from every new invoice into a single
            // bulk insert.
            const allItems = newInvoices.flatMap((invoice) =>
              invoice.items.map((item) => ({
                id: item.id,
                productName: item.productName,
                barcode: item.barcode ?? null,
                price: new Prisma.Decimal(item.price),
                unitCost: new Prisma.Decimal(item.unitCost ?? 0),
                quantity: item.quantity,
                total: new Prisma.Decimal(item.total),
                productId: item.productId ?? null,
                invoiceId: invoice.id,
              })),
            );
            if (allItems.length > 0) {
              await tx.invoiceItem.createMany({
                data: allItems,
                skipDuplicates: true,
              });
            }

            // Atomic per-item stock deduction. Offline-sync semantics: if
            // online stock has drifted too low, the row is left untouched
            // and the discrepancy is logged — the sale itself still
            // persists (it really happened).
            for (const invoice of newInvoices) {
              for (const item of invoice.items) {
                if (!item.productId) continue;
                const { count } = await tx.product.updateMany({
                  where: {
                    id: item.productId,
                    storeId: sid,
                    stock: { gte: item.quantity },
                  },
                  data: { stock: { decrement: item.quantity } },
                });
                if (count === 0) {
                  this.logger.warn(
                    `[sync/push] Stock-deduction skipped for product ${item.productId} on invoice ${invoice.id}. ` +
                      'Likely cause: product deleted/disabled or stock fell below the offline sale quantity. ' +
                      'Flag inventory discrepancy out-of-band.',
                  );
                }
              }
            }

            report.invoices.inserted = newInvoices.length;
          }
        }

        // ── Step 2 — Debts ────────────────────────────────────────────────────
        // Debts are sent separately (not auto-created from invoices) so the
        // frontend retains full control over the debt record contents.
        if (dto.debts.length > 0) {
          const existingDebtIds = new Set(
            (
              await tx.debt.findMany({
                where: { id: { in: dto.debts.map((d) => d.id) } },
                select: { id: true },
              })
            ).map((r) => r.id),
          );
          const newDebts = dto.debts.filter((d) => !existingDebtIds.has(d.id));
          report.debts.skipped = existingDebtIds.size;

          if (newDebts.length > 0) {
            await tx.debt.createMany({
              data: newDebts.map((debt) => ({
                id: debt.id,
                amount: new Prisma.Decimal(debt.amount),
                paid: new Prisma.Decimal(debt.paid),
                remaining: new Prisma.Decimal(debt.remaining),
                isPaid: debt.isPaid,
                date: new Date(debt.date),
                customerId: debt.customerId,
                invoiceId: debt.invoiceId ?? null,
                storeId: sid,
              })),
              skipDuplicates: true,
            });
            report.debts.inserted = newDebts.length;
          }
        }

        // ── Step 3 — Debt Payments ────────────────────────────────────────────
        // Sequential because two payments to the same debt in one batch must
        // compound. Each debt row is locked with SELECT FOR UPDATE before
        // mutation. Overpayment is a HARD reject — the client must re-sync.
        if (dto.debtPayments.length > 0) {
          const existingPaymentIds = new Set(
            (
              await tx.debtPayment.findMany({
                where: { id: { in: dto.debtPayments.map((p) => p.id) } },
                select: { id: true },
              })
            ).map((r) => r.id),
          );

          for (const payment of dto.debtPayments) {
            if (existingPaymentIds.has(payment.id)) {
              report.debtPayments.skipped++;
              continue;
            }

            const debtRows = await tx.$queryRaw<
              {
                id: string;
                paid: Prisma.Decimal;
                remaining: Prisma.Decimal;
                isPaid: boolean;
                storeId: string;
              }[]
            >`
              SELECT id, paid, remaining, "isPaid", "storeId"
              FROM debts
              WHERE id = ${payment.debtId}
              FOR UPDATE
            `;

            if (debtRows.length === 0) {
              throw new BadRequestException(
                `الدين بالمعرّف ${payment.debtId} غير موجود. تأكد من إرسال سجلات الديون قبل دفعاتها.`,
              );
            }
            const debt = debtRows[0];

            if (debt.storeId !== sid) {
              throw new ForbiddenException(
                `الدين ${payment.debtId} لا ينتمي إلى متجرك`,
              );
            }

            if (debt.isPaid) {
              report.debtPayments.skipped++;
              continue;
            }

            const currentRemaining = new Prisma.Decimal(debt.remaining);
            const requested = new Prisma.Decimal(payment.amount);

            // Phase 4.5: hard reject overpayment. Silent capping hid real
            // client bugs and let the ledger drift away from the client's
            // view of reality. Force a fresh sync instead.
            if (requested.gt(currentRemaining)) {
              throw new BadRequestException(
                `الدفعة ${payment.id}: المبلغ (${requested.toString()}) يتجاوز المتبقي على الدين (${currentRemaining.toString()}). أعد المزامنة بعد جلب آخر الحالة.`,
              );
            }

            const newPaid = new Prisma.Decimal(debt.paid).plus(requested);
            const newRemaining = currentRemaining.minus(requested);
            const newIsPaid = newRemaining.lte(0);

            await tx.debtPayment.create({
              data: {
                id: payment.id,
                amount: requested,
                date: new Date(payment.date),
                notes: payment.notes ?? null,
                debtId: payment.debtId,
              },
            });

            await tx.debt.update({
              where: { id: payment.debtId },
              data: { paid: newPaid, remaining: newRemaining, isPaid: newIsPaid },
            });

            report.debtPayments.inserted++;
          }
        }

        this.logger.log(`[sync/push] storeId=${sid} → ${JSON.stringify(report)}`);
        return { message: 'تمت مزامنة البيانات بنجاح', report };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    // Cache invalidation runs after the transaction commits — never block the
    // critical path on a cache failure. (Inside the .then() we don't await
    // the result because callers already have their response.)
    void this.cacheInvalidator.invalidateStoreData(sid).then(undefined, (err) => {
      this.logger.warn(`Post-push cache invalidation failed: ${err}`);
    });

    return result;
  }
}
