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

export type PaginatedCustomers = {
  data: Customer[];
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

    return paginatedResponse(data, total, page, limit);
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

    return customer;
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

  async remove(sid: string, id: string): Promise<void> {

    const customer = await this.db.customer.findFirst({
      where: { id, storeId: sid, isDeleted: false },
      select: {
        id: true,
        debts: { select: { id: true, isPaid: true } },
      },
    });

    if (!customer) throw new NotFoundException('Customer not found');

    const hasUnpaidDebts = customer.debts.some((d) => !d.isPaid);
    if (hasUnpaidDebts) {
      throw new BadRequestException(
        'Cannot delete customer with outstanding unpaid debts. Settle all debts first.',
      );
    }

    // Soft delete (archive): keep historical invoices/debts intact and just hide
    // the customer from the cashier's UI. Avoids FK constraint violations on
    // related debts/invoices.
    await this.db.customer.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    void this.cacheInvalidator.invalidateStoreData(sid);
  }

  // ─── Summary: total outstanding debts for a customer ─────────────────────────

  async getDebtSummary(sid: string, id: string) {

    const customer = await this.db.customer.findFirst({
      where: { id, storeId: sid, isDeleted: false },
      select: { id: true, name: true, phone: true },
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

    return {
      customer,
      summary: {
        totalDebt: totalDebt.toString(),
        totalPaid: totalPaid.toString(),
        totalRemaining: totalRemaining.toString(),
        unpaidCount,
        totalDebts: debts.length,
      },
      debts,
    };
  }
}
