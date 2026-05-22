import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import type { Product, Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { paginate, paginatedResponse } from '../../common/utils/pagination';
import { CacheKeys, CacheTtl } from '../../common/cache/cache-keys';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';

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
  constructor(
    private readonly db: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly cacheInvalidator: CacheInvalidationService,
  ) {}

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

  async create(sid: string, dto: CreateProductDto): Promise<Product> {

    if (dto.barcode) {
      await this.assertBarcodeUnique(sid, dto.barcode);
    }

    const created = await this.db.product.create({
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

    void this.cacheInvalidator.invalidateStoreData(sid, {
      barcode: created.barcode,
    });
    return created;
  }

  // ─── List (paginated + filtered) ─────────────────────────────────────────────

  async findAll(sid: string, query: ProductQueryDto): Promise<PaginatedProducts> {
    const { skip, take, page, limit } = paginate(query);

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
        take,
      }),
      this.db.product.count({ where }),
    ]);

    return paginatedResponse(data, total, page, limit);
  }

  // ─── Low-stock alert (stock < minStock) ──────────────────────────────────────

  async findLowStock(sid: string): Promise<Product[]> {

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

  async findByBarcode(sid: string, barcode: string): Promise<Product> {
    // Cashier hits this on every scan — hot path. Cache 5 min.
    const key = CacheKeys.productByBarcode(sid, barcode);
    const cached = await this.cache.get<Product>(key);
    if (cached) return cached;

    const product = await this.db.product.findFirst({
      where: { barcode, storeId: sid, isActive: true },
    });

    if (!product) throw new NotFoundException('Product not found for the given barcode');

    await this.cache.set(key, product, CacheTtl.PRODUCT_BARCODE);
    return product;
  }

  // ─── Find one by ID ───────────────────────────────────────────────────────────

  async findOne(sid: string, id: string): Promise<Product> {

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

  async update(sid: string, id: string, dto: UpdateProductDto): Promise<Product> {
    // Read existing row to learn the old barcode — we need to invalidate it
    // explicitly even if `dto.barcode` is undefined (any update can affect
    // the cached row's stock/price/isActive fields).
    const existing = await this.db.product.findFirst({
      where: { id, storeId: sid },
      select: { id: true, barcode: true },
    });
    if (!existing) throw new NotFoundException('Product not found');

    if (dto.barcode) {
      await this.assertBarcodeUnique(sid, dto.barcode, id);
    }

    const updated = await this.db.product.update({
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

    // Invalidate both the old and (possibly) new barcode entries.
    void this.cacheInvalidator.invalidateProductBarcode(sid, existing.barcode);
    if (updated.barcode && updated.barcode !== existing.barcode) {
      void this.cacheInvalidator.invalidateProductBarcode(sid, updated.barcode);
    }
    void this.cacheInvalidator.invalidateSyncInit(sid);
    return updated;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

  async remove(sid: string, id: string): Promise<void> {
    const product = await this.db.product.findFirst({
      where: { id, storeId: sid },
      select: { id: true, barcode: true },
    });

    if (!product) throw new NotFoundException('Product not found');

    // invoiceItems.productId will be set to null (onDelete: SetNull) — invoice history is preserved
    await this.db.product.delete({ where: { id } });

    void this.cacheInvalidator.invalidateStoreData(sid, {
      barcode: product.barcode,
    });
  }
}
