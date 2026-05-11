import {
  Injectable,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Product, Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';

export type PaginatedProducts = {
  data: Product[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

@Injectable()
export class ProductService {
  constructor(private readonly db: DatabaseService) {}

  private requireStoreId(storeId: string | null): string {
    if (!storeId) throw new ForbiddenException('Store context is required for this operation');
    return storeId;
  }

  private async assertBarcodeUnique(
    storeId: string,
    barcode: string,
    excludeProductId?: string,
  ): Promise<void> {
    const existing = await this.db.product.findUnique({
      where: { barcode_storeId: { barcode, storeId } },
      select: { id: true },
    });

    if (existing && existing.id !== excludeProductId) {
      throw new ConflictException('A product with this barcode already exists in your store');
    }
  }

  // ─── Create ──────────────────────────────────────────────────────────────────

  async create(storeId: string | null, dto: CreateProductDto): Promise<Product> {
    const sid = this.requireStoreId(storeId);

    if (dto.barcode) {
      await this.assertBarcodeUnique(sid, dto.barcode);
    }

    return this.db.product.create({
      data: {
        name: dto.name,
        barcode: dto.barcode ?? null,
        price: dto.price,
        wholesalePrice: dto.wholesalePrice ?? 0,
        stock: dto.stock ?? 0,
        minStock: dto.minStock ?? 5,
        storeId: sid,
      },
    });
  }

  // ─── List (paginated + filtered) ─────────────────────────────────────────────

  async findAll(storeId: string | null, query: ProductQueryDto): Promise<PaginatedProducts> {
    const sid = this.requireStoreId(storeId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      storeId: sid,
    };

    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { barcode: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await this.db.$transaction([
      this.db.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.db.product.count({ where }),
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

  // ─── Low-stock alert (stock < minStock) ──────────────────────────────────────

  async findLowStock(storeId: string | null): Promise<Product[]> {
    const sid = this.requireStoreId(storeId);

    // Column-to-column comparison — Prisma doesn't support it natively, use raw SQL
    return this.db.$queryRaw<Product[]>`
      SELECT *
      FROM products
      WHERE "storeId" = ${sid}
        AND "isActive" = true
        AND stock < "minStock"
      ORDER BY stock ASC
    `;
  }

  // ─── Find by barcode ─────────────────────────────────────────────────────────

  async findByBarcode(storeId: string | null, barcode: string): Promise<Product> {
    const sid = this.requireStoreId(storeId);

    const product = await this.db.product.findFirst({
      where: { barcode, storeId: sid, isActive: true },
    });

    if (!product) throw new NotFoundException('Product not found for the given barcode');

    return product;
  }

  // ─── Find one by ID ───────────────────────────────────────────────────────────

  async findOne(storeId: string | null, id: string): Promise<Product> {
    const sid = this.requireStoreId(storeId);

    const product = await this.db.product.findFirst({
      where: { id, storeId: sid },
      include: {
        invoiceItems: {
          select: {
            id: true,
            quantity: true,
            price: true,
            total: true,
            invoice: {
              select: { id: true, number: true, date: true },
            },
          },
          orderBy: { invoice: { date: 'desc' } },
          take: 10,
        },
      },
    });

    if (!product) throw new NotFoundException('Product not found');

    return product as Product;
  }

  // ─── Update ───────────────────────────────────────────────────────────────────

  async update(storeId: string | null, id: string, dto: UpdateProductDto): Promise<Product> {
    const sid = this.requireStoreId(storeId);

    const existing = await this.db.product.findFirst({
      where: { id, storeId: sid },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Product not found');

    if (dto.barcode) {
      await this.assertBarcodeUnique(sid, dto.barcode, id);
    }

    return this.db.product.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.barcode !== undefined && { barcode: dto.barcode }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.wholesalePrice !== undefined && { wholesalePrice: dto.wholesalePrice }),
        ...(dto.stock !== undefined && { stock: dto.stock }),
        ...(dto.minStock !== undefined && { minStock: dto.minStock }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

  async remove(storeId: string | null, id: string): Promise<void> {
    const sid = this.requireStoreId(storeId);

    const product = await this.db.product.findFirst({
      where: { id, storeId: sid },
      select: { id: true },
    });

    if (!product) throw new NotFoundException('Product not found');

    // invoiceItems.productId will be set to null (onDelete: SetNull) — invoice history is preserved
    await this.db.product.delete({ where: { id } });
  }
}
