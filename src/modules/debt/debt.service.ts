import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Debt } from 'generated/prisma/client';
import { Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { PayDebtDto } from './dto/pay-debt.dto';
import { DebtQueryDto } from './dto/debt-query.dto';
import { paginate, paginatedResponse } from '../../common/utils/pagination';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';

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
      if (query.dateFrom) where.date.gte = new Date(query.dateFrom);
      if (query.dateTo) {
        const end = new Date(query.dateTo);
        end.setHours(23, 59, 59, 999);
        where.date.lte = end;
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

    const [allDebts, unpaidDebts] = await this.db.$transaction([
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
    ]);

    return {
      totalDebts: allDebts._count.id,
      totalAmount: new Prisma.Decimal(allDebts._sum.amount ?? 0).toString(),
      totalPaid: new Prisma.Decimal(allDebts._sum.paid ?? 0).toString(),
      totalRemaining: new Prisma.Decimal(allDebts._sum.remaining ?? 0).toString(),
      unpaidCount: unpaidDebts._count.id,
      unpaidRemaining: new Prisma.Decimal(unpaidDebts._sum.remaining ?? 0).toString(),
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
          await tx.invoice.update({
            where: { id: debt.invoiceId },
            data: {
              paid: { increment: amount },
              remaining: newRemaining,
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
          select: { id: true, amount: true, date: true, notes: true },
          orderBy: { date: 'desc' },
        },
      },
    });

    if (!debt) throw new NotFoundException('الدين غير موجود');

    return debt;
  }

  // ─── Delete a single payment (Admin only — reverses the payment) ──────────────
  //
  // Concurrency: locks the debt row before reading paid/remaining to prevent
  // racing with concurrent pay() calls. Arithmetic uses Prisma.Decimal.

  async deletePayment(sid: string, debtId: string, paymentId: string): Promise<void> {
    await this.db.$transaction(
      async (tx) => {
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
          select: { id: true, amount: true },
        });
        if (!payment) throw new NotFoundException('الدفعة غير موجودة');

        const paymentAmount = new Prisma.Decimal(payment.amount);
        const newPaid = new Prisma.Decimal(debt.paid).minus(paymentAmount);
        const newRemaining = new Prisma.Decimal(debt.remaining).plus(paymentAmount);

        await tx.debtPayment.delete({ where: { id: paymentId } });

        await tx.debt.update({
          where: { id: debtId },
          data: { paid: newPaid, remaining: newRemaining, isPaid: false },
        });

        if (debt.invoiceId) {
          await tx.invoice.update({
            where: { id: debt.invoiceId },
            data: { paid: { decrement: paymentAmount }, remaining: newRemaining },
          });
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    void this.cacheInvalidator.invalidateSyncInit(sid);
  }

  // ─── Pay toward a customer's total debt (distributes oldest-first) ───────────
  //
  // Concurrency: locks every unpaid debt row for the customer inside the
  // transaction before distributing. Two concurrent payForCustomer calls will
  // serialise on these locks, preventing the same balance from being consumed
  // twice. Arithmetic uses Prisma.Decimal end-to-end.

  async payForCustomer(sid: string, customerId: string, dto: PayDebtDto) {
    const customer = await this.db.customer.findFirst({
      where: { id: customerId, storeId: sid, isDeleted: false },
      select: { id: true, name: true, phone: true },
    });
    if (!customer) throw new NotFoundException('العميل غير موجود');

    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.db.$transaction(
      async (tx) => {
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

        if (unpaidDebts.length === 0) {
          throw new BadRequestException('لا توجد ديون غير مسددة لهذا العميل');
        }

        const totalRemaining = unpaidDebts.reduce(
          (acc, d) => acc.plus(new Prisma.Decimal(d.remaining)),
          new Prisma.Decimal(0),
        );

        if (amount.gt(totalRemaining)) {
          throw new BadRequestException(
            `المبلغ المدفوع (${amount.toString()}) يتجاوز إجمالي الديون المتبقية (${totalRemaining.toString()})`,
          );
        }

        let budget = amount;
        const affectedDebts: {
          debtId: string;
          amountPaid: string;
          isPaid: boolean;
        }[] = [];

        for (const debt of unpaidDebts) {
          if (budget.lte(0)) break;

          const debtRemaining = new Prisma.Decimal(debt.remaining);
          const applyAmount = Prisma.Decimal.min(budget, debtRemaining);
          budget = budget.minus(applyAmount);

          const newPaid = new Prisma.Decimal(debt.paid).plus(applyAmount);
          const newRemaining = debtRemaining.minus(applyAmount);
          const isPaid = newRemaining.isZero();

          await tx.debtPayment.create({
            data: {
              amount: applyAmount,
              notes: dto.notes ?? null,
              debtId: debt.id,
            },
          });

          await tx.debt.update({
            where: { id: debt.id },
            data: { paid: newPaid, remaining: newRemaining, isPaid },
          });

          // Opening-balance debts have no linked invoice — skip the invoice sync
          if (debt.invoiceId) {
            await tx.invoice.update({
              where: { id: debt.invoiceId },
              data: { paid: { increment: applyAmount }, remaining: newRemaining },
            });
          }

          affectedDebts.push({
            debtId: debt.id,
            amountPaid: applyAmount.toString(),
            isPaid,
          });
        }

        // Recalculate customer summary after payments
        const updatedDebts = await tx.debt.aggregate({
          where: { customerId, storeId: sid },
          _sum: { paid: true, remaining: true, amount: true },
          _count: { id: true },
        });
        const unpaidCount = await tx.debt.count({
          where: { customerId, storeId: sid, isPaid: false },
        });

        return {
          customer,
          paymentApplied: amount.toString(),
          affectedDebts,
          summary: {
            totalDebts: updatedDebts._count.id,
            unpaidCount,
            totalAmount: new Prisma.Decimal(updatedDebts._sum.amount ?? 0).toString(),
            totalPaid: new Prisma.Decimal(updatedDebts._sum.paid ?? 0).toString(),
            totalRemaining: new Prisma.Decimal(updatedDebts._sum.remaining ?? 0).toString(),
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

  // ─── Get all debts for a specific customer ────────────────────────────────────

  async findByCustomer(sid: string, customerId: string) {

    const customer = await this.db.customer.findFirst({
      where: { id: customerId, storeId: sid, isDeleted: false },
      select: { id: true, name: true, phone: true },
    });

    if (!customer) throw new NotFoundException('العميل غير موجود');

    const debts = await this.db.debt.findMany({
      where: { customerId, storeId: sid },
      include: {
        invoice: { select: { id: true, number: true, date: true, paymentMethod: true } },
        payments: {
          select: { id: true, amount: true, date: true, notes: true },
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

    return {
      customer,
      summary: {
        totalDebts: debts.length,
        unpaidCount,
        totalAmount: totalAmount.toString(),
        totalPaid: totalPaid.toString(),
        totalRemaining: totalRemaining.toString(),
      },
      debts,
    };
  }
}
