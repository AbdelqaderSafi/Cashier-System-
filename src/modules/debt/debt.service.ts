import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Debt, Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { PayDebtDto } from './dto/pay-debt.dto';
import { DebtQueryDto } from './dto/debt-query.dto';

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
  constructor(private readonly db: DatabaseService) {}

  private requireStoreId(storeId: string | null): string {
    if (!storeId) throw new ForbiddenException('Store context is required for this operation');
    return storeId;
  }

  // ─── List all debts (paginated + filtered) ────────────────────────────────────

  async findAll(storeId: string | null, query: DebtQueryDto): Promise<PaginatedDebts> {
    const sid = this.requireStoreId(storeId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

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
        take: limit,
      }),
      this.db.debt.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─── Store-wide debt summary ──────────────────────────────────────────────────

  async getSummary(storeId: string | null) {
    const sid = this.requireStoreId(storeId);

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
      totalAmount: Number(allDebts._sum.amount ?? 0),
      totalPaid: Number(allDebts._sum.paid ?? 0),
      totalRemaining: Number(allDebts._sum.remaining ?? 0),
      unpaidCount: unpaidDebts._count.id,
      unpaidRemaining: Number(unpaidDebts._sum.remaining ?? 0),
    };
  }

  // ─── Find one debt by ID (with payments) ─────────────────────────────────────

  async findOne(storeId: string | null, id: string) {
    const sid = this.requireStoreId(storeId);

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

  async pay(storeId: string | null, id: string, dto: PayDebtDto) {
    const sid = this.requireStoreId(storeId);

    const debt = await this.db.debt.findFirst({
      where: { id, storeId: sid },
      select: { id: true, amount: true, paid: true, remaining: true, isPaid: true, invoiceId: true },
    });

    if (!debt) throw new NotFoundException('الدين غير موجود');

    if (debt.isPaid) {
      throw new BadRequestException('هذا الدين مسدد بالكامل بالفعل');
    }

    const currentRemaining = Number(debt.remaining);

    if (dto.amount > currentRemaining) {
      throw new BadRequestException(
        `المبلغ المدفوع (${dto.amount}) يتجاوز المبلغ المتبقي (${currentRemaining})`,
      );
    }

    const newPaid = +(Number(debt.paid) + dto.amount).toFixed(2);
    const newRemaining = +(currentRemaining - dto.amount).toFixed(2);
    const isPaid = newRemaining === 0;

    return this.db.$transaction(async (tx) => {
      const payment = await tx.debtPayment.create({
        data: {
          amount: dto.amount,
          notes: dto.notes ?? null,
          debtId: id,
        },
      });

      await tx.debt.update({
        where: { id },
        data: { paid: newPaid, remaining: newRemaining, isPaid },
      });

      await tx.invoice.update({
        where: { id: debt.invoiceId },
        data: {
          paid: { increment: dto.amount },
          remaining: newRemaining,
        },
      });

      return {
        payment,
        debt: {
          id,
          paid: newPaid,
          remaining: newRemaining,
          isPaid,
        },
      };
    });
  }

  // ─── List payments for a specific debt ───────────────────────────────────────

  async getPayments(storeId: string | null, debtId: string) {
    const sid = this.requireStoreId(storeId);

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

  async deletePayment(storeId: string | null, debtId: string, paymentId: string): Promise<void> {
    const sid = this.requireStoreId(storeId);

    const debt = await this.db.debt.findFirst({
      where: { id: debtId, storeId: sid },
      select: { id: true, paid: true, remaining: true, isPaid: true, invoiceId: true },
    });

    if (!debt) throw new NotFoundException('الدين غير موجود');

    const payment = await this.db.debtPayment.findFirst({
      where: { id: paymentId, debtId },
      select: { id: true, amount: true },
    });

    if (!payment) throw new NotFoundException('الدفعة غير موجودة');

    const newPaid = +(Number(debt.paid) - Number(payment.amount)).toFixed(2);
    const newRemaining = +(Number(debt.remaining) + Number(payment.amount)).toFixed(2);

    await this.db.$transaction(async (tx) => {
      await tx.debtPayment.delete({ where: { id: paymentId } });

      await tx.debt.update({
        where: { id: debtId },
        data: { paid: newPaid, remaining: newRemaining, isPaid: false },
      });

      await tx.invoice.update({
        where: { id: debt.invoiceId },
        data: { paid: { decrement: Number(payment.amount) }, remaining: newRemaining },
      });
    });
  }

  // ─── Pay toward a customer's total debt (distributes oldest-first) ───────────

  async payForCustomer(storeId: string | null, customerId: string, dto: PayDebtDto) {
    const sid = this.requireStoreId(storeId);

    const customer = await this.db.customer.findFirst({
      where: { id: customerId, storeId: sid },
      select: { id: true, name: true, phone: true },
    });
    if (!customer) throw new NotFoundException('العميل غير موجود');

    // Fetch all unpaid debts for this customer, oldest first
    const unpaidDebts = await this.db.debt.findMany({
      where: { customerId, storeId: sid, isPaid: false },
      select: { id: true, paid: true, remaining: true, invoiceId: true },
      orderBy: { date: 'asc' },
    });

    if (unpaidDebts.length === 0) {
      throw new BadRequestException('لا توجد ديون غير مسددة لهذا العميل');
    }

    const totalRemaining = unpaidDebts.reduce((s, d) => s + Number(d.remaining), 0);

    if (dto.amount > +totalRemaining.toFixed(2)) {
      throw new BadRequestException(
        `المبلغ المدفوع (${dto.amount}) يتجاوز إجمالي الديون المتبقية (${totalRemaining.toFixed(2)})`,
      );
    }

    return this.db.$transaction(async (tx) => {
      let budget = dto.amount;
      const affectedDebts: { debtId: string; amountPaid: number; isPaid: boolean }[] = [];

      for (const debt of unpaidDebts) {
        if (budget <= 0) break;

        const debtRemaining = Number(debt.remaining);
        const applyAmount = +(Math.min(budget, debtRemaining)).toFixed(2);
        budget = +(budget - applyAmount).toFixed(2);

        const newPaid = +(Number(debt.paid) + applyAmount).toFixed(2);
        const newRemaining = +(debtRemaining - applyAmount).toFixed(2);
        const isPaid = newRemaining === 0;

        // Create a payment record for this debt
        await tx.debtPayment.create({
          data: {
            amount: applyAmount,
            notes: dto.notes ?? null,
            debtId: debt.id,
          },
        });

        // Update the debt
        await tx.debt.update({
          where: { id: debt.id },
          data: { paid: newPaid, remaining: newRemaining, isPaid },
        });

        // Update the linked invoice
        await tx.invoice.update({
          where: { id: debt.invoiceId },
          data: { paid: { increment: applyAmount }, remaining: newRemaining },
        });

        affectedDebts.push({ debtId: debt.id, amountPaid: applyAmount, isPaid });
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
        paymentApplied: dto.amount,
        affectedDebts,
        summary: {
          totalDebts: updatedDebts._count.id,
          unpaidCount,
          totalAmount: +(Number(updatedDebts._sum.amount ?? 0)).toFixed(2),
          totalPaid: +(Number(updatedDebts._sum.paid ?? 0)).toFixed(2),
          totalRemaining: +(Number(updatedDebts._sum.remaining ?? 0)).toFixed(2),
        },
      };
    });
  }

  // ─── Get all debts for a specific customer ────────────────────────────────────

  async findByCustomer(storeId: string | null, customerId: string) {
    const sid = this.requireStoreId(storeId);

    const customer = await this.db.customer.findFirst({
      where: { id: customerId, storeId: sid },
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

    const totalAmount = debts.reduce((s, d) => s + Number(d.amount), 0);
    const totalPaid = debts.reduce((s, d) => s + Number(d.paid), 0);
    const totalRemaining = debts.reduce((s, d) => s + Number(d.remaining), 0);
    const unpaidCount = debts.filter((d) => !d.isPaid).length;

    return {
      customer,
      summary: {
        totalDebts: debts.length,
        unpaidCount,
        totalAmount: +totalAmount.toFixed(2),
        totalPaid: +totalPaid.toFixed(2),
        totalRemaining: +totalRemaining.toFixed(2),
      },
      debts,
    };
  }
}
