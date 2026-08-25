import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import type {
  Debt,
  PaymentSource,
  CreditReason,
} from 'generated/prisma/client';
import { Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { PayDebtDto } from './dto/pay-debt.dto';
import { PayCustomerDebtDto } from './dto/pay-customer-debt.dto';
import { DebtQueryDto } from './dto/debt-query.dto';
import { paginate, paginatedResponse } from '../../common/utils/pagination';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';
import { dayRangeInZone } from '../../common/utils/day-range.util';
import { env } from '../../common/config/env';
import { signedBalance } from './credit.util';
import {
  lockCustomerForCredit,
  grantCredit,
  takeCredit,
  spendCreditOnDebt,
} from './credit.tx';

export type PaginatedDebts = {
  data: Debt[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

@Injectable()
export class DebtService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cacheInvalidator: CacheInvalidationService,
  ) {}

  // ─── List all debts (paginated + filtered) ────────────────────────────────────

  async findAll(sid: string, query: DebtQueryDto): Promise<PaginatedDebts> {
    const { skip, take, page, limit } = paginate(query);

    const where: Prisma.DebtWhereInput = { storeId: sid };

    if (query.customerId) {
      where.customerId = query.customerId;
    }

    if (query.isPaid !== undefined) {
      where.isPaid = query.isPaid;
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
      where.customer = {
        name: { contains: query.search, mode: 'insensitive' },
      };
    }

    const [data, total] = await this.db.$transaction([
      this.db.debt.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          invoice: { select: { id: true, number: true, date: true, paymentMethod: true } },
          _count: { select: { payments: true } },
        },
        orderBy: { date: 'desc' },
        skip,
        take,
      }),
      this.db.debt.count({ where }),
    ]);

    return paginatedResponse(data, total, page, limit);
  }

  // ─── Store-wide debt summary ──────────────────────────────────────────────────

  async getSummary(sid: string) {
    const [allDebts, unpaidDebts, perCustomer, credits] =
      await this.db.$transaction([
        this.db.debt.aggregate({
          where: { storeId: sid },
          _sum: { amount: true, paid: true, remaining: true },
          _count: { id: true },
        }),
        this.db.debt.aggregate({
          where: { storeId: sid, isPaid: false },
          _sum: { remaining: true },
          _count: { id: true },
        }),
        this.db.debt.groupBy({
          by: ['customerId'],
          where: { storeId: sid, isPaid: false },
          _sum: { remaining: true },
          // Prisma's groupBy types require orderBy whenever `by` is present.
          // The order is irrelevant here — the rows are folded into a single
          // sum below — but omitting it is a compile error, not a runtime one.
          orderBy: { customerId: 'asc' },
        }),
        this.db.customer.findMany({
          // No isDeleted filter, deliberately: the existing totalRemaining above
          // aggregates debts with no customer filter at all, so it already counts
          // archived customers. Filtering only the new fields would leave the two
          // numbers unable to reconcile.
          where: { storeId: sid },
          select: { id: true, creditBalance: true },
        }),
      ]);

    const zero = new Prisma.Decimal(0);
    const creditById = new Map(
      credits.map((c) => [c.id, new Prisma.Decimal(c.creditBalance)]),
    );
    const totalCredit = credits.reduce(
      (acc, c) => acc.plus(new Prisma.Decimal(c.creditBalance)),
      zero,
    );

    // Netted PER CUSTOMER. One customer's credit does not settle another
    // customer's debt, so subtracting the store-wide totals would understate
    // what is actually owed.
    const netRemaining = perCustomer.reduce((acc, row) => {
      const owed = new Prisma.Decimal(row._sum?.remaining ?? 0);
      const credit = creditById.get(row.customerId) ?? zero;
      return acc.plus(Prisma.Decimal.max(owed.minus(credit), zero));
    }, zero);

    return {
      totalDebts: allDebts._count.id,
      totalAmount: new Prisma.Decimal(allDebts._sum.amount ?? 0).toString(),
      totalPaid: new Prisma.Decimal(allDebts._sum.paid ?? 0).toString(),
      totalRemaining: new Prisma.Decimal(allDebts._sum.remaining ?? 0).toString(),
      unpaidCount: unpaidDebts._count.id,
      unpaidRemaining: new Prisma.Decimal(unpaidDebts._sum.remaining ?? 0).toString(),
      totalCredit: totalCredit.toString(),
      netRemaining: netRemaining.toString(),
    };
  }

  // ─── Find one debt by ID (with payments) ─────────────────────────────────────

  async findOne(sid: string, id: string) {

    const debt = await this.db.debt.findFirst({
      where: { id, storeId: sid },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        invoice: {
          select: {
            id: true,
            number: true,
            date: true,
            total: true,
            discount: true,
            paymentMethod: true,
            notes: true,
          },
        },
        payments: {
          select: { id: true, amount: true, date: true, notes: true },
          orderBy: { date: 'desc' },
        },
      },
    });

    if (!debt) throw new NotFoundException('الدين غير موجود');

    return debt;
  }

  // ─── Pay a debt (creates DebtPayment + updates Debt) ─────────────────────────
  //
  // Concurrency: locks the debt row with SELECT FOR UPDATE inside the
  // transaction so two concurrent pay() calls on the same debt cannot
  // overpay or race on the remaining balance. All arithmetic uses
  // Prisma.Decimal to avoid the 0.1 + 0.2 floating-point drift.

  async pay(sid: string, id: string, dto: PayDebtDto) {
    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.db.$transaction(
      async (tx) => {
        // Customer lock FIRST, before the debt — Store → Customer → Debts →
        // Invoices, the order every credit-touching transaction follows.
        // pay() itself never touches credit; this lock exists purely for
        // ordering, so a concurrent InvoiceService.update (which locks
        // Customer → Invoice → Debt) can't form a cycle with this method
        // locking Debt → Invoice the other way around — that's a 40P01,
        // unmapped by PrismaExceptionFilter, reaching the till as a 500. No
        // allowArchived: a new payment against an archived customer's debt
        // should still 404, same as it always has.
        const debtOwner = await tx.debt.findFirst({
          where: { id, storeId: sid },
          select: { customerId: true },
        });
        if (!debtOwner) throw new NotFoundException('الدين غير موجود');
        await lockCustomerForCredit(tx, sid, debtOwner.customerId);

        const rows = await tx.$queryRaw<
          {
            id: string;
            amount: Prisma.Decimal;
            paid: Prisma.Decimal;
            remaining: Prisma.Decimal;
            isPaid: boolean;
            invoiceId: string | null;
          }[]
        >`
          SELECT id, amount, paid, remaining, "isPaid", "invoiceId"
          FROM debts
          WHERE id = ${id} AND "storeId" = ${sid}
          FOR UPDATE
        `;

        if (rows.length === 0) throw new NotFoundException('الدين غير موجود');
        const debt = rows[0];

        if (debt.isPaid) {
          throw new BadRequestException('هذا الدين مسدد بالكامل بالفعل');
        }

        const currentRemaining = new Prisma.Decimal(debt.remaining);

        if (amount.gt(currentRemaining)) {
          throw new BadRequestException(
            `المبلغ المدفوع (${amount.toString()}) يتجاوز المبلغ المتبقي (${currentRemaining.toString()})`,
          );
        }

        const newPaid = new Prisma.Decimal(debt.paid).plus(amount);
        const newRemaining = currentRemaining.minus(amount);
        const isPaid = newRemaining.isZero();

        const payment = await tx.debtPayment.create({
          data: {
            amount,
            notes: dto.notes ?? null,
            debtId: id,
          },
        });

        await tx.debt.update({
          where: { id },
          data: { paid: newPaid, remaining: newRemaining, isPaid },
        });

        if (debt.invoiceId) {
          // Relative, not absolute: `newRemaining` is the DEBT's new
          // remaining, not the invoice's — sync/push lets the two diverge
          // (offline debt payments never mirror onto the invoice), and
          // writing it as the invoice's `remaining` directly desyncs
          // paid+remaining=total the moment that happens, tripping the
          // 23514 CHECK as an unmapped 500 on a later payment. decrement
          // keeps both columns computed from what THIS invoice already had,
          // same fix already applied in payForCustomer and deletePayment.
          await tx.invoice.update({
            where: { id: debt.invoiceId },
            data: {
              paid: { increment: amount },
              remaining: { decrement: amount },
            },
          });
        }

        return {
          payment,
          debt: {
            id,
            paid: newPaid,
            remaining: newRemaining,
            isPaid,
          },
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    void this.cacheInvalidator.invalidateSyncInit(sid);
    return result;
  }

  // ─── List payments for a specific debt ───────────────────────────────────────

  async getPayments(sid: string, debtId: string) {

    const debt = await this.db.debt.findFirst({
      where: { id: debtId, storeId: sid },
      select: {
        id: true,
        amount: true,
        paid: true,
        remaining: true,
        isPaid: true,
        customer: { select: { id: true, name: true, phone: true } },
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
    });

    if (!debt) throw new NotFoundException('الدين غير موجود');

    return debt;
  }

  // ─── Delete a single payment (Admin only — reverses the payment) ──────────────
  //
  // Three cases beyond the original cash reversal:
  //   - a CREDIT payment refunds the customer's balance;
  //   - a CASH payment whose operation produced an unspent surplus withdraws
  //     that surplus, exactly once across all the operation's sibling payments;
  //   - a CASH payment whose surplus was already spent is refused, because
  //     unwinding it would require clawing money back out of a later invoice.

  async deletePayment(sid: string, debtId: string, paymentId: string): Promise<void> {
    await this.db.$transaction(
      async (tx) => {
        // Store lock — first statement, always, even before the customer.
        // A CREDIT reversal or surplus withdrawal below writes a CreditEntry
        // row, which carries a storeId FK — Postgres takes a FOR KEY SHARE
        // lock on the referenced Store row to insert it, whether or not this
        // function ever says so explicitly. Without taking it FOR UPDATE up
        // front, this transaction's real order on that path is
        // Customer → Debt → Store, the mirror image of
        // InvoiceService.update/remove's Store → Customer — a textbook
        // 40P01 deadlock, unmapped by PrismaExceptionFilter and reaching an
        // admin as a 500. See the identical reasoning on payForCustomer.
        await tx.$executeRaw`SELECT id FROM stores WHERE id = ${sid} FOR UPDATE`;

        const debtOwner = await tx.debt.findFirst({
          where: { id: debtId, storeId: sid },
          select: { customerId: true },
        });
        if (!debtOwner) throw new NotFoundException('الدين غير موجود');

        // Customer lock first — same rule as every other credit path.
        // allowArchived: this is a reversal call site — a customer whose
        // debts are all settled can be archived, and deleting a payment on
        // one of those settled debts must keep working afterwards. See the
        // comment on lockCustomerForCredit.
        const locked = await lockCustomerForCredit(
          tx,
          sid,
          debtOwner.customerId,
          { allowArchived: true },
        );

        const debtRows = await tx.$queryRaw<
          {
            id: string;
            paid: Prisma.Decimal;
            remaining: Prisma.Decimal;
            invoiceId: string | null;
          }[]
        >`
          SELECT id, paid, remaining, "invoiceId"
          FROM debts
          WHERE id = ${debtId} AND "storeId" = ${sid}
          FOR UPDATE
        `;
        if (debtRows.length === 0) throw new NotFoundException('الدين غير موجود');
        const debt = debtRows[0];

        const payment = await tx.debtPayment.findFirst({
          where: { id: paymentId, debtId },
          select: { id: true, amount: true, source: true, operationId: true },
        });
        if (!payment) throw new NotFoundException('الدفعة غير موجودة');

        const paymentAmount = new Prisma.Decimal(payment.amount);
        let balance = locked.creditBalance;

        if (payment.source === 'CREDIT') {
          balance = await grantCredit(tx, {
            sid,
            customerId: debtOwner.customerId,
            currentBalance: balance,
            amount: paymentAmount,
            reason: 'APPLIED_REVERSED',
            notes: 'إرجاع رصيد — حذف دفعة ممولة من الرصيد',
          });
        } else if (payment.operationId) {
          // The surplus belongs to the OPERATION, not to this one payment: one
          // operation can hold N cash payments and a single OVERPAYMENT entry.
          const overpay = await tx.creditEntry.findFirst({
            where: { operationId: payment.operationId, reason: 'OVERPAYMENT' },
            select: { delta: true, date: true },
          });
          if (overpay) {
            const alreadyWithdrawn = await tx.creditEntry.findFirst({
              where: {
                operationId: payment.operationId,
                reason: 'OVERPAYMENT_REVERSED',
              },
              select: { id: true },
            });
            // Without this check, deleting a second payment from the same
            // operation withdraws the same surplus again.
            if (!alreadyWithdrawn) {
              // `balance.lt(surplus)` used to stand in for "has this
              // operation's surplus already been spent", but the customer's
              // balance is shared across every operation that ever granted
              // credit — a LATER operation's surplus can mask an EARLIER
              // one's having been spent, so the proxy withdraws money that
              // belongs to the later grant instead of refusing. Detect
              // consumption directly: if any APPLIED_TO_DEBT entry landed at
              // or after THIS operation's OVERPAYMENT entry, credit has been
              // spent since this surplus appeared and there is no way to
              // prove it wasn't this surplus that got spent — refuse.
              const spentSince = await tx.creditEntry.findFirst({
                where: {
                  customerId: debtOwner.customerId,
                  reason: 'APPLIED_TO_DEBT',
                  date: { gte: overpay.date },
                },
                select: { id: true },
              });
              if (spentSince) {
                throw new BadRequestException(
                  'لا يمكن حذف هذه الدفعة — الرصيد الناتج عنها تم استخدامه',
                );
              }
              const surplus = new Prisma.Decimal(overpay.delta);
              // Return value not captured: nothing after this reads the
              // customer's balance again in this transaction.
              await takeCredit(tx, {
                sid,
                customerId: debtOwner.customerId,
                currentBalance: balance,
                amount: surplus,
                reason: 'OVERPAYMENT_REVERSED',
                operationId: payment.operationId,
                notes: 'سحب رصيد — حذف الدفعة التي ولّدته',
              });
            }
          }
        }

        await tx.debtPayment.delete({ where: { id: paymentId } });

        await tx.debt.update({
          where: { id: debtId },
          data: {
            paid: { decrement: paymentAmount },
            remaining: { increment: paymentAmount },
            isPaid: false,
          },
        });

        if (debt.invoiceId) {
          await tx.invoice.update({
            where: { id: debt.invoiceId },
            data: {
              paid: { decrement: paymentAmount },
              remaining: { increment: paymentAmount },
            },
          });
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    await this.cacheInvalidator.invalidateStoreData(sid);
  }

  // ─── Pay toward a customer's total debt ───────────────────────────────────────
  //
  // Cash is allocated oldest-first; whatever the cash leaves open is settled
  // from stored credit; whatever the cash exceeds becomes new credit.
  //
  // Cash before credit is deliberate: the customer is handing over money now,
  // so the shop should settle from that and leave the balance it already holds
  // untouched. The reverse order nets out to the same number but churns the
  // ledger with credit movements that immediately reverse.
  //
  // Concurrency: the customer row is locked FIRST, unconditionally, then every
  // unpaid debt. Two concurrent calls serialise on the customer row, so the
  // same credit can never be spent twice.

  async payForCustomer(
    sid: string,
    customerId: string,
    dto: PayCustomerDebtDto,
  ) {
    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.db.$transaction(
      async (tx) => {
        // 0) Store lock — first statement, always, even before the customer.
        // This transaction always inserts a DebtPaymentOperation row (step 2
        // below — written even for a client with no surplus, "so the key
        // always has an anchor"), and that row carries a storeId FK: Postgres
        // takes a FOR KEY SHARE lock on the referenced Store row to insert
        // it, whether or not any code here ever says so explicitly. Without
        // taking that lock FOR UPDATE up front, this transaction's real order
        // is Customer → Debts → Store, while InvoiceService.update/remove
        // (which also unconditionally lock Store first, then Customer, for
        // the exact same FK-insert reason — CreditEntry carries storeId too)
        // lock Store → Customer. Two transactions locking the same two
        // resources in opposite orders is a textbook 40P01 deadlock,
        // unmapped by PrismaExceptionFilter and reaching the till as a 500.
        await tx.$executeRaw`SELECT id FROM stores WHERE id = ${sid} FOR UPDATE`;

        // 1) Customer lock — first statement after the store lock, always.
        // See credit.tx.ts.
        const locked = await lockCustomerForCredit(tx, sid, customerId);

        // 2) Idempotency short-circuit. No writes on a replay.
        if (dto.clientOperationId) {
          const existing = await tx.debtPaymentOperation.findFirst({
            where: { storeId: sid, clientOperationId: dto.clientOperationId },
            include: {
              payments: {
                select: { debtId: true, amount: true, source: true },
                // The original response was built oldest-debt-first (the `4)
                // Cash, oldest first` / `5) Stored credit` loops below both
                // walk `unpaidDebts` ordered by date ASC). Without this, a
                // replay of a multi-debt operation can hand the client
                // `affectedDebts` in a different order than the original
                // call did, breaking the contract that a replay is identical.
                orderBy: { debt: { date: 'asc' } },
              },
              creditEntries: { select: { delta: true, reason: true } },
            },
          });
          if (existing) {
            if (existing.customerId !== customerId) {
              throw new ConflictException('مُعرّف العملية مستخدم لعميل آخر');
            }
            return this.buildPayForCustomerResult(tx, sid, customerId, {
              paymentApplied: new Prisma.Decimal(existing.amount),
              payments: existing.payments,
              creditEntries: existing.creditEntries,
            });
          }
        }

        // 3) Lock every unpaid debt, oldest first.
        const unpaidDebts = await tx.$queryRaw<
          {
            id: string;
            paid: Prisma.Decimal;
            remaining: Prisma.Decimal;
            invoiceId: string | null;
          }[]
        >`
          SELECT id, paid, remaining, "invoiceId"
          FROM debts
          WHERE "customerId" = ${customerId}
            AND "storeId" = ${sid}
            AND "isPaid" = false
          ORDER BY date ASC
          FOR UPDATE
        `;

        // Written for every call, even with no surplus and no client key, so
        // the key always has an anchor and every payment has a parent.
        const operation = await tx.debtPaymentOperation.create({
          data: {
            amount,
            customerId,
            storeId: sid,
            clientOperationId: dto.clientOperationId ?? null,
          },
        });

        const zero = new Prisma.Decimal(0);
        const perDebt = new Map<
          string,
          { cash: Prisma.Decimal; credit: Prisma.Decimal; isPaid: boolean }
        >();
        const liveRemaining = new Map<string, Prisma.Decimal>();
        for (const d of unpaidDebts) {
          liveRemaining.set(d.id, new Prisma.Decimal(d.remaining));
        }

        // 4) Cash, oldest first.
        let budget = amount;
        for (const debt of unpaidDebts) {
          if (budget.lte(0)) break;
          const remaining = liveRemaining.get(debt.id)!;
          if (remaining.lte(0)) continue;

          const applyAmount = Prisma.Decimal.min(budget, remaining);
          budget = budget.minus(applyAmount);
          const newRemaining = remaining.minus(applyAmount);
          liveRemaining.set(debt.id, newRemaining);

          await tx.debtPayment.create({
            data: {
              amount: applyAmount,
              notes: dto.notes ?? null,
              debtId: debt.id,
              source: 'CASH',
              operationId: operation.id,
            },
          });
          await tx.debt.update({
            where: { id: debt.id },
            data: {
              paid: { increment: applyAmount },
              remaining: { decrement: applyAmount },
              isPaid: newRemaining.isZero(),
            },
          });
          if (debt.invoiceId) {
            await tx.invoice.update({
              where: { id: debt.invoiceId },
              data: {
                paid: { increment: applyAmount },
                remaining: { decrement: applyAmount },
              },
            });
          }

          perDebt.set(debt.id, {
            cash: applyAmount,
            credit: zero,
            isPaid: newRemaining.isZero(),
          });
        }

        // 5) Stored credit settles whatever the cash left open.
        let balance = locked.creditBalance;
        let creditApplied = zero;
        for (const debt of unpaidDebts) {
          if (balance.lte(0)) break;
          const remaining = liveRemaining.get(debt.id)!;
          if (remaining.lte(0)) continue;

          const { applied, newBalance } = await spendCreditOnDebt(tx, {
            sid,
            customerId,
            currentBalance: balance,
            debtId: debt.id,
            debtRemaining: remaining,
            invoiceId: debt.invoiceId,
            operationId: operation.id,
          });
          balance = newBalance;
          creditApplied = creditApplied.plus(applied);
          liveRemaining.set(debt.id, remaining.minus(applied));

          const prior = perDebt.get(debt.id) ?? {
            cash: zero,
            credit: zero,
            isPaid: false,
          };
          perDebt.set(debt.id, {
            cash: prior.cash,
            credit: prior.credit.plus(applied),
            isPaid: remaining.minus(applied).isZero(),
          });
        }

        // 6) Cash the debts could not absorb becomes credit.
        const excess = budget;
        if (excess.gt(0)) {
          balance = await grantCredit(tx, {
            sid,
            customerId,
            currentBalance: balance,
            amount: excess,
            reason: 'OVERPAYMENT',
            operationId: operation.id,
            notes: dto.notes ?? null,
          });
        }

        return this.buildPayForCustomerResult(tx, sid, customerId, {
          paymentApplied: amount,
          affectedDebts: [...perDebt.entries()].map(([debtId, v]) => ({
            debtId,
            amountPaid: v.cash.toString(),
            creditPaid: v.credit.toString(),
            isPaid: v.isPaid,
          })),
          creditApplied,
          excessToCredit: excess,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    // AFTER the transaction. Busting sync:init before COMMIT lets a concurrent
    // read re-pin the pre-commit balance for the full 30s TTL, and a rollback
    // would have bust it for nothing.
    await this.cacheInvalidator.invalidateStoreData(sid);
    return result;
  }

  /**
   * Assemble the pay response. `affectedDebts` and the credit figures are
   * facts about the operation; `summary` and `debts` are read fresh, so a
   * replayed request never hands the client a stale balance to sync from.
   */
  private async buildPayForCustomerResult(
    tx: Prisma.TransactionClient,
    sid: string,
    customerId: string,
    src: {
      paymentApplied: Prisma.Decimal;
      affectedDebts?: {
        debtId: string;
        amountPaid: string;
        creditPaid: string;
        isPaid: boolean;
      }[];
      creditApplied?: Prisma.Decimal;
      excessToCredit?: Prisma.Decimal;
      payments?: {
        debtId: string;
        amount: Prisma.Decimal;
        source: PaymentSource;
      }[];
      creditEntries?: { delta: Prisma.Decimal; reason: CreditReason }[];
    },
  ) {
    const zero = new Prisma.Decimal(0);

    // Replay path: rebuild the operation's facts from its stored rows.
    let affectedDebts = src.affectedDebts;
    let creditApplied = src.creditApplied ?? zero;
    let excessToCredit = src.excessToCredit ?? zero;

    if (!affectedDebts && src.payments) {
      const perDebt = new Map<
        string,
        { cash: Prisma.Decimal; credit: Prisma.Decimal }
      >();
      for (const p of src.payments) {
        const prior = perDebt.get(p.debtId) ?? { cash: zero, credit: zero };
        const amt = new Prisma.Decimal(p.amount);
        perDebt.set(
          p.debtId,
          p.source === 'CREDIT'
            ? { cash: prior.cash, credit: prior.credit.plus(amt) }
            : { cash: prior.cash.plus(amt), credit: prior.credit },
        );
      }
      const settled = await tx.debt.findMany({
        where: { id: { in: [...perDebt.keys()] } },
        select: { id: true, isPaid: true },
      });
      const isPaidById = new Map(settled.map((d) => [d.id, d.isPaid]));
      affectedDebts = [...perDebt.entries()].map(([debtId, v]) => ({
        debtId,
        amountPaid: v.cash.toString(),
        creditPaid: v.credit.toString(),
        isPaid: isPaidById.get(debtId) ?? false,
      }));

      for (const e of src.creditEntries ?? []) {
        const delta = new Prisma.Decimal(e.delta);
        if (e.reason === 'APPLIED_TO_DEBT') {
          creditApplied = creditApplied.plus(delta.abs());
        }
        if (e.reason === 'OVERPAYMENT') {
          excessToCredit = excessToCredit.plus(delta);
        }
      }
    }

    const customer = await tx.customer.findFirst({
      where: { id: customerId, storeId: sid },
      select: { id: true, name: true, phone: true, creditBalance: true },
    });

    const debts = await tx.debt.findMany({
      where: { customerId, storeId: sid },
      include: {
        invoice: {
          select: { id: true, number: true, date: true, paymentMethod: true },
        },
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
    });

    const totalAmount = debts.reduce(
      (a, d) => a.plus(new Prisma.Decimal(d.amount)),
      zero,
    );
    const totalPaid = debts.reduce(
      (a, d) => a.plus(new Prisma.Decimal(d.paid)),
      zero,
    );
    const totalRemaining = debts.reduce(
      (a, d) => a.plus(new Prisma.Decimal(d.remaining)),
      zero,
    );
    const creditBalance = new Prisma.Decimal(customer?.creditBalance ?? 0);

    return {
      customer: customer
        ? { id: customer.id, name: customer.name, phone: customer.phone }
        : null,
      paymentApplied: src.paymentApplied.toString(),
      affectedDebts: affectedDebts ?? [],
      creditApplied: creditApplied.toString(),
      excessToCredit: excessToCredit.toString(),
      debts,
      summary: {
        totalDebts: debts.length,
        unpaidCount: debts.filter((d) => !d.isPaid).length,
        totalAmount: totalAmount.toString(),
        totalPaid: totalPaid.toString(),
        totalRemaining: totalRemaining.toString(),
        totalDebt: totalAmount.toString(),
        creditBalance: creditBalance.toString(),
        balance: signedBalance(creditBalance, totalRemaining).toString(),
      },
    };
  }

  // ─── Get all debts for a specific customer ────────────────────────────────────

  async findByCustomer(sid: string, customerId: string) {

    const customer = await this.db.customer.findFirst({
      where: { id: customerId, storeId: sid, isDeleted: false },
      select: { id: true, name: true, phone: true, creditBalance: true },
    });

    if (!customer) throw new NotFoundException('العميل غير موجود');

    const debts = await this.db.debt.findMany({
      where: { customerId, storeId: sid },
      include: {
        invoice: { select: { id: true, number: true, date: true, paymentMethod: true } },
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
    });

    const zero = new Prisma.Decimal(0);
    const totalAmount = debts.reduce(
      (acc, d) => acc.plus(new Prisma.Decimal(d.amount)),
      zero,
    );
    const totalPaid = debts.reduce(
      (acc, d) => acc.plus(new Prisma.Decimal(d.paid)),
      zero,
    );
    const totalRemaining = debts.reduce(
      (acc, d) => acc.plus(new Prisma.Decimal(d.remaining)),
      zero,
    );
    const unpaidCount = debts.filter((d) => !d.isPaid).length;

    const creditBalance = new Prisma.Decimal(customer.creditBalance);

    return {
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      summary: {
        totalDebts: debts.length,
        unpaidCount,
        totalAmount: totalAmount.toString(),
        totalPaid: totalPaid.toString(),
        totalRemaining: totalRemaining.toString(),
        totalDebt: totalAmount.toString(),
        creditBalance: creditBalance.toString(),
        balance: signedBalance(creditBalance, totalRemaining).toString(),
      },
      debts,
    };
  }
}
