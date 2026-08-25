import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Customer } from 'generated/prisma/client';
import { Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { paginate, paginatedResponse } from '../../common/utils/pagination';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';
import { signedBalance } from '../debt/credit.util';
import { lockCustomerForCredit, takeCredit } from '../debt/credit.tx';
import {
  toCustomerPayment,
  CUSTOMER_PAYMENT_INCLUDE,
} from '../debt/debt.service';

export type CustomerWithBalance = Customer & { balance: string };

export type PaginatedCustomers = {
  data: CustomerWithBalance[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

@Injectable()
export class CustomerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cacheInvalidator: CacheInvalidationService,
  ) {}

  // ─── Create ──────────────────────────────────────────────────────────────────
  //
  // Idempotency: if `clientCustomerId` is supplied, a per-(store,key) advisory
  //              lock + lookup short-circuits retries — the offline outbox can
  //              safely re-POST after a network drop (or after the user spam-
  //              refreshes the page) without creating a duplicate customer or
  //              duplicating the initial-debt opening balance.

  async create(sid: string, dto: CreateCustomerDto): Promise<Customer> {
    const customer = await this.db.$transaction(async (tx) => {
      // Idempotency short-circuit — only when the client opted in.
      // The advisory lock is scoped to (storeId, clientCustomerId) so two
      // concurrent retries of the *same* customer serialize, but unrelated
      // customer creations stay parallel.
      if (dto.clientCustomerId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer:create:${sid}:${dto.clientCustomerId}`}))`;
        const existing = await tx.customer.findFirst({
          where: { storeId: sid, clientCustomerId: dto.clientCustomerId },
        });
        // Return the original even if it was soft-deleted later — the client
        // sent this key thinking the record was new; the dedupe is what they
        // actually need (not a resurrection).
        if (existing) return existing;
      }

      const created = await tx.customer.create({
        data: {
          name: dto.name,
          phone: dto.phone ?? null,
          clientCustomerId: dto.clientCustomerId ?? null,
          storeId: sid,
        },
      });

      if (dto.initialDebt && dto.initialDebt > 0) {
        await tx.debt.create({
          data: {
            amount: dto.initialDebt,
            paid: 0,
            remaining: dto.initialDebt,
            isPaid: false,
            invoiceId: null,
            notes: 'دين سابق - رصيد افتتاحي عند التأسيس',
            customerId: created.id,
            storeId: sid,
          },
        });
      }

      return created;
    });

    void this.cacheInvalidator.invalidateStoreData(sid);
    return customer;
  }

  // ─── List (paginated + search) ────────────────────────────────────────────────

  async findAll(sid: string, query: CustomerQueryDto): Promise<PaginatedCustomers> {
    const { skip, take, page, limit } = paginate(query);

    const where: Prisma.CustomerWhereInput = {
      storeId: sid,
      isDeleted: false,
    };

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await this.db.$transaction([
      this.db.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.db.customer.count({ where }),
    ]);

    // One groupBy for the whole page, not a query per row.
    const owed = await this.db.debt.groupBy({
      by: ['customerId'],
      where: {
        storeId: sid,
        isPaid: false,
        customerId: { in: data.map((c) => c.id) },
      },
      _sum: { remaining: true },
    });
    const owedById = new Map(
      owed.map((o) => [
        o.customerId,
        new Prisma.Decimal(o._sum.remaining ?? 0),
      ]),
    );
    const zero = new Prisma.Decimal(0);

    const withBalance = data.map((c) => ({
      ...c,
      balance: signedBalance(
        new Prisma.Decimal(c.creditBalance),
        owedById.get(c.id) ?? zero,
      ).toString(),
    }));

    return paginatedResponse(withBalance, total, page, limit);
  }

  // ─── Find one by ID (with invoices + debts) ───────────────────────────────────

  async findOne(sid: string, id: string) {

    const customer = await this.db.customer.findFirst({
      where: { id, storeId: sid, isDeleted: false },
      include: {
        invoices: {
          select: {
            id: true,
            number: true,
            date: true,
            total: true,
            discount: true,
            paid: true,
            remaining: true,
            paymentMethod: true,
            notes: true,
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
              },
            },
          },
          orderBy: { date: 'desc' },
          take: 20,
        },
        debts: {
          select: {
            id: true,
            amount: true,
            paid: true,
            remaining: true,
            isPaid: true,
            date: true,
            invoice: {
              select: { id: true, number: true, date: true },
            },
            payments: {
              select: {
                id: true,
                amount: true,
                date: true,
                notes: true,
              },
              orderBy: { date: 'desc' },
            },
          },
          orderBy: { date: 'desc' },
        },
      },
    });

    if (!customer) throw new NotFoundException('Customer not found');

    const owed = await this.db.debt.aggregate({
      where: { customerId: id, storeId: sid, isPaid: false },
      _sum: { remaining: true },
    });
    const totalRemaining = new Prisma.Decimal(owed._sum.remaining ?? 0);

    // The record of cash actually taken across the counter, newest first.
    //
    // This is NOT debts[].payments. That array is the ALLOCATION — how one
    // payment was spread over individual debts — so a 150 taken against a 100
    // debt shows there as 100. Only this list carries the 150.
    //
    // Spending stored credit on a later invoice creates no row here, because
    // no new cash was received; it is the customer's own money moving.
    const operations = await this.db.debtPaymentOperation.findMany({
      where: { customerId: id, storeId: sid },
      include: CUSTOMER_PAYMENT_INCLUDE,
      // `id` breaks the tie: `date` defaults to CURRENT_TIMESTAMP, so two
      // payments taken in the same instant would otherwise order at random.
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      // Capped like the sibling `invoices` list on this same response — a
      // long-standing customer's history should not grow the till payload
      // without bound.
      take: 50,
    });

    return {
      ...customer,
      balance: signedBalance(
        new Prisma.Decimal(customer.creditBalance),
        totalRemaining,
      ).toString(),
      customerPayments: operations.map(toCustomerPayment),
    };
  }

  // ─── Update ───────────────────────────────────────────────────────────────────

  async update(sid: string, id: string, dto: UpdateCustomerDto): Promise<Customer> {

    const existing = await this.db.customer.findFirst({
      where: { id, storeId: sid, isDeleted: false },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Customer not found');

    const updated = await this.db.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
      },
    });

    void this.cacheInvalidator.invalidateStoreData(sid);
    return updated;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

  // `forfeitCredit`: an explicit, audited escape hatch for the customer who
  // holds credit with no route left to clear it — e.g. an overpayment on a
  // customer who owed nothing (no debt, so no debt_payments row ever
  // existed) or an invoice void that cascaded the originating debt away.
  // Defaults to false so every existing caller keeps today's behaviour.
  async remove(sid: string, id: string, forfeitCredit = false): Promise<void> {

    // Without the lock, the creditBalance > 0 check and the isDeleted write
    // are two unlocked statements — a payForCustomer/pay/spendCreditOnDebt
    // committing between them can archive a customer who holds credit at the
    // moment of the write, exactly what this guard exists to prevent: a
    // customer the shop owes money to, hidden from /customers and
    // /sync/init. lockCustomerForCredit first (no allowArchived — this is a
    // fresh check against a customer who must still be live) serialises
    // against every other credit-touching transaction, all of which take the
    // same lock first.
    await this.db.$transaction(async (tx) => {
      const locked = await lockCustomerForCredit(tx, sid, id);

      const debts = await tx.debt.findMany({
        where: { customerId: id, storeId: sid },
        select: { id: true, isPaid: true },
      });

      const hasUnpaidDebts = debts.some((d) => !d.isPaid);
      if (hasUnpaidDebts) {
        throw new BadRequestException(
          'لا يمكن حذف العميل — لديه ديون غير مسددة. يجب تسوية جميع الديون أولاً.',
        );
      }

      // Archiving hides the row from /customers and /sync/init (both filter
      // isDeleted: false) while the shop still owes the money. Without
      // forfeitCredit, a customer who genuinely has no route to clear the
      // balance (no debt to spend it on, no debt_payments row to delete) is
      // stuck here forever — that is exactly what forfeitCredit is for.
      if (locked.creditBalance.gt(0)) {
        if (!forfeitCredit) {
          throw new BadRequestException(
            'لا يمكن أرشفة العميل — لديه رصيد لم يُستخدم بعد. اصرف الرصيد على فاتورة أو دين جديد له، أو أرشفه مع إسقاط الرصيد بإرسال forfeitCredit=true.',
          );
        }

        // Audited forfeit, same transaction as the archive: a real
        // credit_entries row (reason OVERPAYMENT_REVERSED — a forfeit is a
        // withdrawal, same direction as an ordinary surplus clawback) so an
        // auditor can see the balance was deliberately zeroed at archive
        // time, not silently dropped.
        await takeCredit(tx, {
          sid,
          customerId: id,
          currentBalance: locked.creditBalance,
          amount: locked.creditBalance,
          reason: 'OVERPAYMENT_REVERSED',
          notes:
            'إسقاط الرصيد عند أرشفة العميل — لا يوجد دين أو دفعة لصرفه عليها',
        });
      }

      // Soft delete (archive): keep historical invoices/debts intact and just
      // hide the customer from the cashier's UI. Avoids FK constraint
      // violations on related debts/invoices.
      await tx.customer.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() },
      });
    });

    await this.cacheInvalidator.invalidateStoreData(sid);
  }

  // ─── Summary: total outstanding debts for a customer ─────────────────────────

  async getDebtSummary(sid: string, id: string) {

    const customer = await this.db.customer.findFirst({
      where: { id, storeId: sid, isDeleted: false },
      select: { id: true, name: true, phone: true, creditBalance: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const debts = await this.db.debt.findMany({
      where: { customerId: id, storeId: sid },
      select: {
        id: true,
        amount: true,
        paid: true,
        remaining: true,
        isPaid: true,
        date: true,
        invoice: { select: { id: true, number: true, date: true } },
      },
      orderBy: { date: 'desc' },
    });

    const zero = new Prisma.Decimal(0);
    const totalDebt = debts.reduce(
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
        totalDebt: totalDebt.toString(),
        totalPaid: totalPaid.toString(),
        totalRemaining: totalRemaining.toString(),
        unpaidCount,
        totalDebts: debts.length,
        totalAmount: totalDebt.toString(),
        creditBalance: creditBalance.toString(),
        balance: signedBalance(creditBalance, totalRemaining).toString(),
      },
      debts,
    };
  }
}
