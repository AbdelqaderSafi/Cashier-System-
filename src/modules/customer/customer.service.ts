import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Customer, Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerQueryDto } from './dto/customer-query.dto';

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
  constructor(private readonly db: DatabaseService) {}

  private requireStoreId(storeId: string | null): string {
    if (!storeId) throw new ForbiddenException('Store context is required for this operation');
    return storeId;
  }

  // ─── Create ──────────────────────────────────────────────────────────────────

  async create(storeId: string | null, dto: CreateCustomerDto): Promise<Customer> {
    const sid = this.requireStoreId(storeId);

    return this.db.customer.create({
      data: {
        name: dto.name,
        phone: dto.phone ?? null,
        storeId: sid,
      },
    });
  }

  // ─── List (paginated + search) ────────────────────────────────────────────────

  async findAll(storeId: string | null, query: CustomerQueryDto): Promise<PaginatedCustomers> {
    const sid = this.requireStoreId(storeId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.CustomerWhereInput = {
      storeId: sid,
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
        take: limit,
      }),
      this.db.customer.count({ where }),
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

  // ─── Find one by ID (with invoices + debts) ───────────────────────────────────

  async findOne(storeId: string | null, id: string) {
    const sid = this.requireStoreId(storeId);

    const customer = await this.db.customer.findFirst({
      where: { id, storeId: sid },
      include: {
        invoices: {
          select: {
            id: true,
            number: true,
            date: true,
            total: true,
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

  async update(storeId: string | null, id: string, dto: UpdateCustomerDto): Promise<Customer> {
    const sid = this.requireStoreId(storeId);

    const existing = await this.db.customer.findFirst({
      where: { id, storeId: sid },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Customer not found');

    return this.db.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
      },
    });
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

  async remove(storeId: string | null, id: string): Promise<void> {
    const sid = this.requireStoreId(storeId);

    const customer = await this.db.customer.findFirst({
      where: { id, storeId: sid },
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

    await this.db.customer.delete({ where: { id } });
  }

  // ─── Summary: total outstanding debts for a customer ─────────────────────────

  async getDebtSummary(storeId: string | null, id: string) {
    const sid = this.requireStoreId(storeId);

    const customer = await this.db.customer.findFirst({
      where: { id, storeId: sid },
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

    const totalDebt = debts.reduce((sum, d) => sum + Number(d.amount), 0);
    const totalPaid = debts.reduce((sum, d) => sum + Number(d.paid), 0);
    const totalRemaining = debts.reduce((sum, d) => sum + Number(d.remaining), 0);
    const unpaidCount = debts.filter((d) => !d.isPaid).length;

    return {
      customer,
      summary: {
        totalDebt,
        totalPaid,
        totalRemaining,
        unpaidCount,
        totalDebts: debts.length,
      },
      debts,
    };
  }
}
