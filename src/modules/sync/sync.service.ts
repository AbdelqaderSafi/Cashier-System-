import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SyncPushDto } from './dto/sync-push.dto';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(private readonly db: DatabaseService) {}

  private requireStoreId(storeId: string | null): string {
    if (!storeId) throw new ForbiddenException('Store context is required for this operation');
    return storeId;
  }

  // ─── Initial Sync ─────────────────────────────────────────────────────────────
  // Called when the PWA loads online. Returns all data needed to seed IndexedDB.

  async getInitData(storeId: string | null) {
    const sid = this.requireStoreId(storeId);

    const [products, customers, debts] = await Promise.all([
      this.db.product.findMany({
        where: { storeId: sid, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.db.customer.findMany({
        where: { storeId: sid },
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
  // Idempotency: Each record is checked by its client-generated UUID before insert.
  //              Duplicates (from retried requests) are silently skipped.
  //
  // Timestamps:  Client-provided dates are used as-is so offline sales preserve
  //              the real transaction time instead of the sync time.
  //
  // Atomicity:   The entire batch is wrapped in a single $transaction so any
  //              failure rolls back every insert in the payload.

  async push(storeId: string | null, dto: SyncPushDto) {
    const sid = this.requireStoreId(storeId);

    return this.db.$transaction(async (tx) => {
      const report = {
        invoices: { inserted: 0, skipped: 0 },
        debts: { inserted: 0, skipped: 0 },
        debtPayments: { inserted: 0, skipped: 0 },
      };

      // ── Step 1 — Invoices ──────────────────────────────────────────────────
      for (const invoice of dto.invoices) {
        const exists = await tx.invoice.findUnique({
          where: { id: invoice.id },
          select: { id: true },
        });

        if (exists) {
          report.invoices.skipped++;
          this.logger.debug(`[sync/push] Invoice ${invoice.id} already exists — skipped`);
          continue;
        }

        // Assign the next sequential number within this store.
        // Computed inside the transaction on each iteration so concurrent
        // pushes of multiple invoices stay strictly monotonic.
        const lastInvoice = await tx.invoice.findFirst({
          where: { storeId: sid },
          orderBy: { number: 'desc' },
          select: { number: true },
        });
        const nextNumber = (lastInvoice?.number ?? 0) + 1;

        await tx.invoice.create({
          data: {
            id: invoice.id,
            number: nextNumber,
            // Use the client-provided offline timestamp — NOT the DB default.
            date: new Date(invoice.date),
            total: invoice.total,
            paid: invoice.paid,
            remaining: invoice.remaining,
            paymentMethod: invoice.paymentMethod,
            notes: invoice.notes ?? null,
            customerId: invoice.customerId ?? null,
            storeId: sid,
            items: {
              create: invoice.items.map((item) => ({
                id: item.id,
                productName: item.productName,
                barcode: item.barcode ?? null,
                price: item.price,
                quantity: item.quantity,
                total: item.total,
                productId: item.productId ?? null,
              })),
            },
          },
        });

        // Deduct stock for each item that is linked to a product.
        // Uses updateMany to gracefully handle products deleted after the
        // offline sale (no error — inventory discrepancy is logged instead).
        for (const item of invoice.items) {
          if (!item.productId) continue;

          const { count } = await tx.product.updateMany({
            where: { id: item.productId, storeId: sid },
            data: { stock: { decrement: item.quantity } },
          });

          if (count === 0) {
            this.logger.warn(
              `[sync/push] Product ${item.productId} not found during stock deduction for invoice ${invoice.id}`,
            );
          }
        }

        report.invoices.inserted++;
      }

      // ── Step 2 — Debts ────────────────────────────────────────────────────
      // Debts are sent separately (not auto-created from invoices) so the
      // frontend retains full control over the debt record contents.
      for (const debt of dto.debts) {
        const exists = await tx.debt.findUnique({
          where: { id: debt.id },
          select: { id: true },
        });

        if (exists) {
          report.debts.skipped++;
          this.logger.debug(`[sync/push] Debt ${debt.id} already exists — skipped`);
          continue;
        }

        await tx.debt.create({
          data: {
            id: debt.id,
            amount: debt.amount,
            paid: debt.paid,
            remaining: debt.remaining,
            isPaid: debt.isPaid,
            // Use the client-provided offline timestamp — NOT the DB default.
            date: new Date(debt.date),
            customerId: debt.customerId,
            invoiceId: debt.invoiceId,
            storeId: sid,
          },
        });

        report.debts.inserted++;
      }

      // ── Step 3 — Debt Payments ────────────────────────────────────────────
      // Payments are processed sequentially so multiple payments to the same
      // debt within one batch correctly compound (each iteration reads the
      // latest DB state from within the transaction).
      for (const payment of dto.debtPayments) {
        const exists = await tx.debtPayment.findUnique({
          where: { id: payment.id },
          select: { id: true },
        });

        if (exists) {
          report.debtPayments.skipped++;
          this.logger.debug(`[sync/push] DebtPayment ${payment.id} already exists — skipped`);
          continue;
        }

        const debt = await tx.debt.findUnique({
          where: { id: payment.debtId },
          select: { id: true, amount: true, paid: true, remaining: true, isPaid: true, storeId: true },
        });

        if (!debt) {
          throw new BadRequestException(
            `الدين بالمعرّف ${payment.debtId} غير موجود. تأكد من إرسال سجلات الديون قبل دفعاتها.`,
          );
        }

        // Guard: only process debts that belong to this store.
        if (debt.storeId !== sid) {
          throw new ForbiddenException(`الدين ${payment.debtId} لا ينتمي إلى متجرك`);
        }

        // If the debt is already fully paid, silently skip the payment to
        // avoid double-counting in retried sync scenarios.
        if (debt.isPaid) {
          report.debtPayments.skipped++;
          this.logger.debug(`[sync/push] Debt ${payment.debtId} is already fully paid — payment skipped`);
          continue;
        }

        const currentRemaining = Number(debt.remaining);

        // Cap the payment to the actual remaining balance to prevent the
        // paid total from ever exceeding the original debt amount.
        const appliedAmount = Math.min(payment.amount, currentRemaining);
        const newPaid = +(Number(debt.paid) + appliedAmount).toFixed(2);
        const newRemaining = +(currentRemaining - appliedAmount).toFixed(2);
        const newIsPaid = newRemaining <= 0;

        await tx.debtPayment.create({
          data: {
            id: payment.id,
            amount: appliedAmount,
            // Use the client-provided offline timestamp — NOT the DB default.
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

      this.logger.log(`[sync/push] storeId=${sid} → ${JSON.stringify(report)}`);
      return { message: 'تمت مزامنة البيانات بنجاح', report };
    });
  }
}
