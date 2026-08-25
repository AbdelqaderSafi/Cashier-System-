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
import { SyncPushDto, SyncInvoiceItemDto } from './dto/sync-push.dto';
import { CacheKeys, CacheTtl } from '../../common/cache/cache-keys';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';

// Keep the first occurrence of each id in input order. Defensive against a
// client that ships the same record twice in one payload (a retry that didn't
// dedupe its outbox, two open tabs pushing the same queue, etc.).
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

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
            select: {
              id: true,
              amount: true,
              date: true,
              notes: true,
              source: true,
            },
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
  // Idempotency:  defensive in-payload dedup + per-store advisory xact lock +
  //               scoped pre-fetch of existing ids. The lock collapses the
  //               race window that previously let two concurrent pushes both
  //               pre-fetch "nothing exists", both proceed to insert, and
  //               both run side effects for the same UUIDs.
  // Numbering:    one atomic `lastInvoiceNumber: { increment: N }` allocates N
  //               consecutive numbers for the whole batch (vs. N round-trips).
  //               Under the advisory lock N == genuinely-new count, so no
  //               numbers leak when a replay arrives.
  // Money:        all arithmetic uses Prisma.Decimal. Debt overpayment is a
  //               hard reject (4xx) — no more silent capping.
  // Atomicity:    one `$transaction` wraps everything; any failure rolls back.

  /**
   * Pieces to deduct for one offline line.
   *
   * Priority: a `UNIT` line's `quantity` IS its piece count by definition, so
   * that is decided first and a client-sent `stockQuantity` is never
   * consulted for it — honouring it there could only be wrong. For a
   * `CARTON` line, an explicit `stockQuantity` from the device wins (it is
   * what the device actually reserved against its local copy), then a
   * server-side recompute from the product's carton size, then the raw
   * quantity.
   *
   * A CARTON line on a product with no carton size means the product was
   * converted back to piece-only while the device was offline. The sale
   * already happened on the ground, so we log the discrepancy and deduct
   * pieces rather than rejecting and losing the record — the same policy the
   * stock-drift warning below already applies.
   */
  private syncStockPieces(
    item: SyncInvoiceItemDto,
    cartonSizeByProductId: Map<string, number | null>,
  ): number {
    // A piece line's quantity IS its piece count, so a client-sent
    // stockQuantity can only be wrong here — honouring it would let an
    // outbox bug that computes stockQuantity without checking saleUnit
    // silently deduct a whole carton for a single-piece sale.
    if (item.saleUnit !== 'CARTON') return item.quantity;
    if (item.stockQuantity != null) return item.stockQuantity;

    const piecesPerCarton = item.productId
      ? cartonSizeByProductId.get(item.productId)
      : null;
    if (piecesPerCarton == null) {
      this.logger.warn(
        `[sync/push] Carton line for product ${item.productId ?? 'unknown'} has no ` +
          'piecesPerCarton and no client stockQuantity — deducting raw quantity. ' +
          'Flag inventory discrepancy out-of-band.',
      );
      return item.quantity;
    }
    return item.quantity * piecesPerCarton;
  }

  async push(sid: string, dto: SyncPushDto) {
    // ── Defensive in-payload dedup ──────────────────────────────────────────
    // A buggy/retry-happy client could ship the same record twice inside one
    // payload. Without this step, a duplicated invoice id would slip past the
    // pre-fetch filter (id not in DB yet), get two slots in the
    // lastInvoiceNumber bump, and double-decrement stock — even though only
    // one row would actually land thanks to the PK conflict at INSERT time.
    const invoices = dedupeById(dto.invoices);
    const debts = dedupeById(dto.debts);
    const debtPayments = dedupeById(dto.debtPayments);

    // Collect every referenced ID once so the validation queries are batched.
    const inPayloadInvoiceIds = new Set(invoices.map((i) => i.id));

    const customerIdsReferenced = new Set<string>();
    for (const inv of invoices) {
      if (inv.customerId) customerIdsReferenced.add(inv.customerId);
    }
    for (const d of debts) {
      customerIdsReferenced.add(d.customerId);
    }

    const productIdsReferenced = new Set<string>();
    for (const inv of invoices) {
      for (const item of inv.items) {
        if (item.productId) productIdsReferenced.add(item.productId);
      }
    }

    // Debts may reference invoices that are NOT in this payload (e.g. paying
    // off an older invoice). Those must already live under this store.
    const externalInvoiceIds = new Set<string>();
    for (const d of debts) {
      if (d.invoiceId && !inPayloadInvoiceIds.has(d.invoiceId)) {
        externalInvoiceIds.add(d.invoiceId);
      }
    }

    const result = await this.db.$transaction(
      async (tx) => {
        // ── Serialize concurrent pushes for this store ────────────────────────
        // Without this lock, two pushes that race (e.g. the user spam-refreshes
        // the page when connectivity returns and the sync queue fires twice in
        // parallel) both pre-fetch existing IDs and see nothing, both proceed
        // to insert. `skipDuplicates: true` keeps the invoices table itself
        // clean, but the side effects — `lastInvoiceNumber` bump and per-item
        // stock decrement — run in BOTH transactions for the SAME UUIDs, so
        // stock is over-deducted and the report lies about what was inserted.
        // pg_advisory_xact_lock is per-transaction (auto-released at COMMIT /
        // ROLLBACK), keyed by store id so unrelated tenants stay parallel.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sync:push:${sid}`}))`;

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

        // Same ownership check as before, but we keep the carton size while
        // we're here — an offline carton line has to be converted to pieces
        // and there is no reason to pay for a second round-trip.
        const cartonSizeByProductId = new Map<string, number | null>();
        if (productIdsReferenced.size > 0) {
          const rows = await tx.product.findMany({
            where: {
              id: { in: [...productIdsReferenced] },
              storeId: sid,
            },
            select: { id: true, piecesPerCarton: true },
          });
          if (rows.length !== productIdsReferenced.size) {
            throw new ForbiddenException(
              'أحد المنتجات في الـ payload لا ينتمي إلى متجرك',
            );
          }
          for (const row of rows) {
            cartonSizeByProductId.set(row.id, row.piecesPerCarton);
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
        if (invoices.length > 0) {
          // Scope to storeId so a (cosmically unlikely) cross-store UUID
          // collision doesn't make us treat a foreign invoice as "already
          // done" and silently drop ours.
          const existingInvoiceIds = new Set(
            (
              await tx.invoice.findMany({
                where: {
                  id: { in: invoices.map((i) => i.id) },
                  storeId: sid,
                },
                select: { id: true },
              })
            ).map((r) => r.id),
          );
          const newInvoices = invoices.filter(
            (i) => !existingInvoiceIds.has(i.id),
          );
          report.invoices.skipped = existingInvoiceIds.size;

          if (newInvoices.length > 0) {
            // Lock order: Store → Customer → Debts → Invoices. This update
            // takes the store row first; the invoice/debt createMany calls
            // below reference customerId by FK, and each FK insert takes
            // FOR KEY SHARE on the referenced customer row — which conflicts
            // with a customer-first FOR UPDATE. Anything that locks a
            // customer before touching invoices/debts (e.g.
            // InvoiceService.create) must lock the store first too, or the
            // two paths can deadlock. Comment only — no behaviour change.
            //
            // One atomic counter bump allocates all N numbers at once.
            // The block we own is (lastInvoiceNumber - N + 1 .. lastInvoiceNumber).
            const store = await tx.store.update({
              where: { id: sid },
              data: { lastInvoiceNumber: { increment: newInvoices.length } },
              select: { lastInvoiceNumber: true },
            });
            const firstNumber =
              store.lastInvoiceNumber - newInvoices.length + 1;

            // Unlike total/paid/remaining, nothing at the DB layer polices
            // discount (only `@Min(0)` on the DTO), and it feeds
            // daily-profit directly — a device bug pushing a discount larger
            // than the invoice's own line sum would make reported revenue
            // negative with no error and no trace. The sale already
            // happened offline, so warn rather than reject and lose the
            // whole batch.
            for (const invoice of newInvoices) {
              const lineSum = invoice.items.reduce(
                (acc, item) => acc.plus(new Prisma.Decimal(item.total)),
                new Prisma.Decimal(0),
              );
              const discount = new Prisma.Decimal(invoice.discount ?? 0);
              if (discount.gt(lineSum)) {
                this.logger.warn(
                  `[sync/push] Invoice ${invoice.id} discount (${discount.toString()}) exceeds its line sum (${lineSum.toString()}).`,
                );
              }
            }

            // No `skipDuplicates` — with the advisory lock + scoped pre-fetch
            // above, every id in `newInvoices` is guaranteed not to exist for
            // this store. If a duplicate somehow reached this INSERT it would
            // mean either lock acquisition was bypassed or the input wasn't
            // deduped: fail loudly (transaction rolls back) rather than
            // silently skip and leave stock double-decremented below.
            await tx.invoice.createMany({
              data: newInvoices.map((invoice, idx) => ({
                id: invoice.id,
                number: firstNumber + idx,
                date: new Date(invoice.date),
                total: new Prisma.Decimal(invoice.total),
                paid: new Prisma.Decimal(invoice.paid),
                remaining: new Prisma.Decimal(invoice.remaining),
                discount: new Prisma.Decimal(invoice.discount ?? 0),
                paymentMethod: invoice.paymentMethod,
                notes: invoice.notes ?? null,
                customerId: invoice.customerId ?? null,
                storeId: sid,
              })),
            });

            // Flatten every item from every new invoice into a single
            // bulk insert. stockQuantity is resolved once here and reused for
            // the deduction below, so the row and the ledger can never
            // disagree.
            const allItems = newInvoices.flatMap((invoice) =>
              invoice.items.map((item) => ({
                id: item.id,
                productName: item.productName,
                barcode: item.barcode ?? null,
                price: new Prisma.Decimal(item.price),
                unitCost: new Prisma.Decimal(item.unitCost ?? 0),
                quantity: item.quantity,
                total: new Prisma.Decimal(item.total),
                saleUnit: item.saleUnit ?? 'UNIT',
                stockQuantity: this.syncStockPieces(item, cartonSizeByProductId),
                productId: item.productId ?? null,
                invoiceId: invoice.id,
              })),
            );
            if (allItems.length > 0) {
              // Same reasoning as the invoices INSERT: no skipDuplicates so
              // a stray collision can't silently drop an item while its
              // parent invoice was just created.
              await tx.invoiceItem.createMany({ data: allItems });
            }

            // Atomic per-item stock deduction, in pieces. Offline-sync
            // semantics: if online stock has drifted too low, the row is left
            // untouched and the discrepancy is logged — the sale itself still
            // persists (it really happened).
            for (const item of allItems) {
              if (!item.productId) continue;
              const { count } = await tx.product.updateMany({
                where: {
                  id: item.productId,
                  storeId: sid,
                  stock: { gte: item.stockQuantity },
                },
                data: { stock: { decrement: item.stockQuantity } },
              });
              if (count === 0) {
                this.logger.warn(
                  `[sync/push] Stock-deduction skipped for product ${item.productId} on invoice ${item.invoiceId}. ` +
                    'Likely cause: product deleted/disabled or stock fell below the offline sale quantity. ' +
                    'Flag inventory discrepancy out-of-band.',
                );
              }
            }

            report.invoices.inserted = newInvoices.length;
          }
        }

        // ── Step 2 — Debts ────────────────────────────────────────────────────
        // Debts are sent separately (not auto-created from invoices) so the
        // frontend retains full control over the debt record contents.
        if (debts.length > 0) {
          const existingDebtIds = new Set(
            (
              await tx.debt.findMany({
                where: {
                  id: { in: debts.map((d) => d.id) },
                  storeId: sid,
                },
                select: { id: true },
              })
            ).map((r) => r.id),
          );
          const newDebts = debts.filter((d) => !existingDebtIds.has(d.id));
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
            });
            report.debts.inserted = newDebts.length;
          }
        }

        // ── Step 3 — Debt Payments ────────────────────────────────────────────
        // Sequential because two payments to the same debt in one batch must
        // compound. Each debt row is locked with SELECT FOR UPDATE before
        // mutation. Overpayment is a HARD reject — the client must re-sync.
        if (debtPayments.length > 0) {
          // Scope to this store via the parent debt — same reasoning as the
          // invoice/debt pre-fetches: a UUID that happens to exist for some
          // other store mustn't trick us into marking ours as "already done".
          const existingPaymentIds = new Set(
            (
              await tx.debtPayment.findMany({
                where: {
                  id: { in: debtPayments.map((p) => p.id) },
                  debt: { storeId: sid },
                },
                select: { id: true },
              })
            ).map((r) => r.id),
          );

          for (const payment of debtPayments) {
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
