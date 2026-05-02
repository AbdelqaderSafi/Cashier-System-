import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Invoice, Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InvoiceQueryDto } from './dto/invoice-query.dto';

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
  constructor(private readonly db: DatabaseService) {}

  private requireStoreId(storeId: string | null): string {
    if (!storeId) throw new ForbiddenException('Store context is required for this operation');
    return storeId;
  }

  // ─── Create Invoice ────────────────────────────────────────────────────────────

  async create(storeId: string | null, dto: CreateInvoiceDto): Promise<Invoice> {
    const sid = this.requireStoreId(storeId);

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
        where: { id: customerId, storeId: sid },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('العميل غير موجود');
    }

    const productIds = dto.items.map((i) => i.productId);
    const products = await this.db.product.findMany({
      where: { id: { in: productIds }, storeId: sid, isActive: true },
    });

    if (products.length !== productIds.length) {
      const foundIds = new Set(products.map((p) => p.id));
      const missing = productIds.filter((id) => !foundIds.has(id));
      throw new NotFoundException(`المنتجات التالية غير موجودة أو غير نشطة: ${missing.join(', ')}`);
    }

    const productMap = new Map(products.map((p) => [p.id, p]));

    for (const item of dto.items) {
      const product = productMap.get(item.productId)!;
      if (product.stock < item.quantity) {
        throw new BadRequestException(
          `الكمية المطلوبة (${item.quantity}) من "${product.name}" تتجاوز المخزون المتوفر (${product.stock})`,
        );
      }
    }

    const invoiceItems = dto.items.map((item) => {
      const product = productMap.get(item.productId)!;
      const price = Number(product.price);
      const itemTotal = +(price * item.quantity).toFixed(2);
      return {
        productName: product.name,
        barcode: product.barcode,
        price,
        quantity: item.quantity,
        total: itemTotal,
        productId: product.id,
      };
    });

    const total = +invoiceItems.reduce((sum, item) => sum + item.total, 0).toFixed(2);

    let paid: number;
    let remaining: number;

    switch (dto.paymentMethod) {
      case 'CASH':
      case 'ONLINE':
        // بيع مباشر — مدفوع بالكامل
        paid = total;
        remaining = 0;
        break;
      case 'DEBT':
        // آجل بالكامل — المبلغ الكامل دين
        paid = 0;
        remaining = total;
        break;
      case 'PARTIAL': {
        // جزئي — الكاشير يحدد المبلغ المدفوع والباقي يصبح دين
        const paidAmount = dto.paid!;
        if (paidAmount >= total) {
          throw new BadRequestException(
            'المبلغ المدفوع يجب أن يكون أقل من إجمالي الفاتورة عند الدفع الجزئي',
          );
        }
        if (paidAmount <= 0) {
          throw new BadRequestException('المبلغ المدفوع يجب أن يكون أكبر من صفر');
        }
        paid = paidAmount;
        remaining = +(total - paidAmount).toFixed(2);
        break;
      }
      default:
        paid = total;
        remaining = 0;
    }

    return this.db.$transaction(async (tx) => {
      const lastInvoice = await tx.invoice.findFirst({
        where: { storeId: sid },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const nextNumber = (lastInvoice?.number ?? 0) + 1;

      const invoice = await tx.invoice.create({
        data: {
          number: nextNumber,
          total,
          paid,
          remaining,
          paymentMethod: dto.paymentMethod,
          notes: dto.notes ?? null,
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

      for (const item of dto.items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      if (needsCustomer) {
        await tx.debt.create({
          data: {
            amount: remaining,
            paid: 0,
            remaining,
            customerId: customerId!,
            invoiceId: invoice.id,
            storeId: sid,
          },
        });
      }

      return invoice;
    });
  }

  // ─── List (paginated + filtered) ─────────────────────────────────────────────

  async findAll(storeId: string | null, query: InvoiceQueryDto): Promise<PaginatedInvoices> {
    const sid = this.requireStoreId(storeId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.InvoiceWhereInput = { storeId: sid };

    if (query.paymentMethod) {
      where.paymentMethod = query.paymentMethod;
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
        take: limit,
      }),
      this.db.invoice.count({ where }),
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

  // ─── Find one by ID ──────────────────────────────────────────────────────────

  async findOne(storeId: string | null, id: string) {
    const sid = this.requireStoreId(storeId);

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

  async findByNumber(storeId: string | null, invoiceNumber: number) {
    const sid = this.requireStoreId(storeId);

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

  async getDailySales(storeId: string | null, dateStr?: string) {
    const sid = this.requireStoreId(storeId);

    const target = dateStr ? new Date(dateStr) : new Date();
    const startOfDay = new Date(target);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(target);
    endOfDay.setHours(23, 59, 59, 999);

    const invoices = await this.db.invoice.findMany({
      where: {
        storeId: sid,
        date: { gte: startOfDay, lte: endOfDay },
      },
      select: {
        id: true,
        number: true,
        total: true,
        paid: true,
        remaining: true,
        paymentMethod: true,
        date: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { date: 'desc' },
    });

    const totalSales = invoices.reduce((sum, inv) => sum + Number(inv.total), 0);
    const totalCash = invoices
      .filter((inv) => inv.paymentMethod === 'CASH')
      .reduce((sum, inv) => sum + Number(inv.paid), 0);
    const totalOnline = invoices
      .filter((inv) => inv.paymentMethod === 'ONLINE')
      .reduce((sum, inv) => sum + Number(inv.paid), 0);
    const totalDebt = invoices
      .filter((inv) => inv.paymentMethod === 'DEBT' || inv.paymentMethod === 'PARTIAL')
      .reduce((sum, inv) => sum + Number(inv.remaining), 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + Number(inv.paid), 0);

    return {
      date: startOfDay.toISOString().split('T')[0],
      summary: {
        invoiceCount: invoices.length,
        totalSales,
        totalPaid,
        totalCash,
        totalOnline,
        totalDebt,
      },
      invoices,
    };
  }

  // ─── Delete (Admin only, with stock restoration) ──────────────────────────────

  async remove(storeId: string | null, id: string): Promise<void> {
    const sid = this.requireStoreId(storeId);

    const invoice = await this.db.invoice.findFirst({
      where: { id, storeId: sid },
      include: {
        items: { select: { productId: true, quantity: true } },
        debt: { select: { id: true, isPaid: true, payments: { select: { id: true } } } },
      },
    });

    if (!invoice) throw new NotFoundException('الفاتورة غير موجودة');

    if (invoice.debt && !invoice.debt.isPaid && invoice.debt.payments.length > 0) {
      throw new BadRequestException(
        'لا يمكن حذف فاتورة مرتبطة بدين عليه دفعات. قم بتسوية الدين أولاً.',
      );
    }

    await this.db.$transaction(async (tx) => {
      for (const item of invoice.items) {
        if (item.productId) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } },
          });
        }
      }

      await tx.invoice.delete({ where: { id } });
    });
  }
}
