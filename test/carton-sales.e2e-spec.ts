import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { Prisma } from 'generated/prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/modules/database/database.service';
import { env } from '../src/common/config/env';

/**
 * Carton sales (e2e).
 *
 * Same isolation pattern as ledger-integrity.e2e-spec.ts: each describe block
 * gets its own throwaway store (`carton-test-*` subdomain) and tears it down
 * in afterAll, so a crash leaves a recognisable footprint.
 */

export type Ctx = {
  app: INestApplication;
  server: Server;
  db: DatabaseService;
  storeId: string;
  token: string;
};

export async function bootstrap(): Promise<Ctx> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const db = app.get(DatabaseService);
  const jwt = app.get(JwtService);

  const subdomain = `carton-test-${randomUUID().slice(0, 8)}`;
  const store = await db.store.create({
    data: { name: `Carton Test ${subdomain}`, subdomain, status: 'APPROVED' },
  });
  const user = await db.user.create({
    data: {
      username: `tester-${subdomain}`,
      email: `${subdomain}@carton.test`,
      password: 'x', // not used — the JWT is minted directly
      role: 'ADMIN',
      storeId: store.id,
      isEmailVerified: true,
    },
  });

  const token = await jwt.signAsync(
    { sub: user.id, storeId: store.id, role: 'ADMIN' },
    { secret: env.JWT_SECRET, expiresIn: '10m' },
  );

  return { app, server: app.getHttpServer() as Server, db, storeId: store.id, token };
}

export async function teardown(ctx: Ctx): Promise<void> {
  const { db, storeId } = ctx;
  await db.debtPayment.deleteMany({ where: { debt: { storeId } } });
  await db.debt.deleteMany({ where: { storeId } });
  await db.invoiceItem.deleteMany({ where: { invoice: { storeId } } });
  await db.invoice.deleteMany({ where: { storeId } });
  await db.product.deleteMany({ where: { storeId } });
  await db.customer.deleteMany({ where: { storeId } });
  await db.user.deleteMany({ where: { storeId } });
  await db.store.delete({ where: { id: storeId } });
  await ctx.app.close();
}

describe('Carton sales — backward compatibility', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('creates a product with no carton fields — carton columns stay NULL', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Legacy Product', price: 10, wholesalePrice: 6, stock: 40 });

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(40);
    expect(Number(res.body.wholesalePrice)).toBe(6);
    expect(res.body.piecesPerCarton).toBeNull();
    expect(res.body.cartonPurchasePrice).toBeNull();
    expect(res.body.cartonSalePrice).toBeNull();
  });

  it('creates an invoice with no saleUnit — line defaults to UNIT and deducts pieces', async () => {
    const product = await ctx.db.product.create({
      data: {
        name: 'Legacy Sale',
        price: new Prisma.Decimal(10),
        wholesalePrice: new Prisma.Decimal(6),
        stock: 40,
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 3 }] });

    expect(res.status).toBe(201);

    const line = await ctx.db.invoiceItem.findFirst({
      where: { invoiceId: res.body.id },
    });
    expect(line!.saleUnit).toBe('UNIT');

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(37);
  });

  it('restores stock correctly when deleting a pre-migration line (stockQuantity NULL)', async () => {
    // Simulate a row written before this migration: saleUnit defaulted, and
    // stockQuantity forced back to NULL exactly as the legacy data looks.
    const product = await ctx.db.product.create({
      data: {
        name: 'Legacy Restore',
        price: new Prisma.Decimal(10),
        wholesalePrice: new Prisma.Decimal(6),
        stock: 37,
        storeId: ctx.storeId,
      },
    });
    const invoice = await ctx.db.invoice.create({
      data: {
        number: 90001,
        total: new Prisma.Decimal(30),
        paid: new Prisma.Decimal(30),
        remaining: new Prisma.Decimal(0),
        paymentMethod: 'CASH',
        storeId: ctx.storeId,
        items: {
          create: {
            productName: 'Legacy Restore',
            price: new Prisma.Decimal(10),
            unitCost: new Prisma.Decimal(6),
            quantity: 3,
            total: new Prisma.Decimal(30),
            productId: product.id,
          },
        },
      },
      include: { items: true },
    });
    await ctx.db.$executeRaw`
      UPDATE invoice_items SET "stockQuantity" = NULL WHERE "invoiceId" = ${invoice.id}
    `;

    const res = await request(ctx.server)
      .delete(`/api/invoices/${invoice.id}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    expect([200, 204]).toContain(res.status);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(40); // 37 + 3, from the quantity fallback
  });
});

describe('Carton sales — product create', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('derives stock from cartons plus loose pieces, and unit cost from the carton price', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'Pepsi 330ml',
        price: 3,
        stock: 5, // loose pieces
        piecesPerCarton: 24,
        cartonCount: 2,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      });

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(53); // 2 × 24 + 5
    expect(Number(res.body.wholesalePrice)).toBe(2); // 48 / 24
    expect(Number(res.body.price)).toBe(3); // untouched
    expect(res.body.piecesPerCarton).toBe(24);
    expect(Number(res.body.cartonPurchasePrice)).toBe(48);
    expect(Number(res.body.cartonSalePrice)).toBe(60);
  });

  it('ignores a client-sent wholesalePrice in carton mode', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'Ignored Wholesale',
        price: 3,
        wholesalePrice: 999,
        piecesPerCarton: 24,
        cartonCount: 1,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      });

    expect(res.status).toBe(201);
    expect(Number(res.body.wholesalePrice)).toBe(2);
    expect(res.body.stock).toBe(24);
  });

  it('defaults stock to the carton pieces when no loose pieces are sent', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'No Loose Pieces',
        price: 3,
        piecesPerCarton: 24,
        cartonCount: 2,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      });

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(48);
  });

  it('rejects a partial carton group', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'Partial Carton',
        price: 3,
        piecesPerCarton: 24,
        cartonPurchasePrice: 48,
      });

    expect(res.status).toBe(400);
  });

  it('rejects cartonCount without piecesPerCarton', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Orphan Count', price: 3, cartonCount: 2 });

    expect(res.status).toBe(400);
  });

  it('rejects a zero carton sale price', async () => {
    // A zero carton price yields a zero-total invoice, which violates the
    // invoice_balance_consistent CHECK (total > 0) and surfaces as an
    // unmapped 500 at the till. Reject it at entry, like the piece price.
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'Zero Carton Price',
        price: 3,
        piecesPerCarton: 24,
        cartonCount: 1,
        cartonPurchasePrice: 48,
        cartonSalePrice: 0,
      });

    expect(res.status).toBe(400);
  });
});

describe('Carton sales — product update', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  async function makePlainProduct(name: string, stock = 30) {
    return ctx.db.product.create({
      data: {
        name,
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(1.5),
        stock,
        storeId: ctx.storeId,
      },
    });
  }

  it('converts an existing plain product into a carton product without touching stock', async () => {
    const product = await makePlainProduct('Convert Me');

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ piecesPerCarton: 24, cartonPurchasePrice: 48, cartonSalePrice: 60 });

    expect(res.status).toBe(200);
    expect(res.body.piecesPerCarton).toBe(24);
    expect(Number(res.body.wholesalePrice)).toBe(2); // recomputed from 48 / 24
    expect(res.body.stock).toBe(30); // NOT recomputed — pieces may already be sold
  });

  it('recomputes wholesalePrice when the carton purchase price changes', async () => {
    const product = await ctx.db.product.create({
      data: {
        name: 'Reprice',
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock: 48,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ cartonPurchasePrice: 72 });

    expect(res.status).toBe(200);
    expect(Number(res.body.wholesalePrice)).toBe(3); // 72 / 24
  });

  it('clears carton mode when all three fields are set to null', async () => {
    const product = await ctx.db.product.create({
      data: {
        name: 'Clear Carton',
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock: 48,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        piecesPerCarton: null,
        cartonPurchasePrice: null,
        cartonSalePrice: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.piecesPerCarton).toBeNull();
    expect(res.body.cartonPurchasePrice).toBeNull();
    expect(res.body.cartonSalePrice).toBeNull();
  });

  it('rejects an update that would leave a partial carton group', async () => {
    const product = await makePlainProduct('Partial Update');

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ piecesPerCarton: 24 });

    expect(res.status).toBe(400);
  });

  it('rejects cartonCount on update — stock is never recomputed from cartons', async () => {
    const product = await makePlainProduct('No Carton Count');

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ cartonCount: 5 });

    expect(res.status).toBe(400); // forbidNonWhitelisted — not on the DTO
  });
});

describe('Carton sales — invoice create', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  async function makeCartonProduct(name: string, stock: number) {
    return ctx.db.product.create({
      data: {
        name,
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });
  }

  it('sells one carton — deducts 24 pieces and freezes the carton snapshot', async () => {
    const product = await makeCartonProduct('Carton Sale', 48);

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }],
      });

    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(60);

    const line = res.body.items[0];
    expect(line.saleUnit).toBe('CARTON');
    expect(line.stockQuantity).toBe(24);
    expect(line.quantity).toBe(1);
    expect(Number(line.price)).toBe(60);
    expect(Number(line.unitCost)).toBe(48);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(24); // 48 − 24
  });

  it('sells a carton and loose pieces of the same product as two lines', async () => {
    const product = await makeCartonProduct('Mixed Sale', 30);

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [
          { productId: product.id, quantity: 1, saleUnit: 'CARTON' },
          { productId: product.id, quantity: 3, saleUnit: 'UNIT' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    expect(Number(res.body.total)).toBe(69); // 60 + (3 × 3)

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(3); // 30 − 24 − 3
  });

  it('rejects the second line when the first line already consumed the stock', async () => {
    // 26 pieces: the carton line takes 24, leaving 2 — so the 3-piece line
    // must fail. This is what proves each line's conditional deduction sees
    // the previous line's write; with stock to spare the test would pass
    // even if the lines were evaluated against the original stock.
    const product = await makeCartonProduct('Intra Invoice Oversell', 26);

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [
          { productId: product.id, quantity: 1, saleUnit: 'CARTON' },
          { productId: product.id, quantity: 3, saleUnit: 'UNIT' },
        ],
      });

    expect(res.status).toBe(400);

    // The whole transaction must roll back — not just the failing line.
    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(26);
  });

  it('rejects a carton sale that exceeds stock, reporting pieces not cartons', async () => {
    const product = await makeCartonProduct('Short Stock', 20);

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }],
      });

    expect(res.status).toBe(400);
    // The message must talk in pieces — "(1) تتجاوز المخزون المتوفر (20)" would
    // read as nonsense to a cashier.
    expect(res.body.message).toContain('24');
    expect(res.body.message).toContain('20');

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(20); // rolled back
  });

  it('rejects a carton sale of a product with no carton data', async () => {
    const product = await ctx.db.product.create({
      data: {
        name: 'Not A Carton Product',
        price: new Prisma.Decimal(10),
        wholesalePrice: new Prisma.Decimal(6),
        stock: 40,
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('غير معرّف كمنتج كرتونة');
  });

  it('rejects an unrecognised saleUnit rather than falling back to piece pricing', async () => {
    // Guards the DTO's @IsEnum: without it, an unrecognised value would fall
    // through buildInvoiceItem's CARTON check into the UNIT branch and sell a
    // carton at the piece price.
    const product = await makeCartonProduct('Bad Sale Unit', 48);

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 1, saleUnit: 'carton' }],
      });

    expect(res.status).toBe(400);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(48); // nothing sold
  });

  it('reports carton profit correctly (carton price × cartons − carton cost × cartons)', async () => {
    // Isolated store: /reports/daily-profit sums every invoice the store
    // made today. The sibling tests above already put a successful 60-total
    // invoice in `ctx`'s store, so reusing it here would let that revenue
    // leak into this assertion (60 + 120 = 180, exactly the contamination
    // observed before this fix) — hence a dedicated store, same as every
    // other describe block in this file.
    const local = await bootstrap();
    try {
      const product = await local.db.product.create({
        data: {
          name: 'Profit Check',
          price: new Prisma.Decimal(3),
          wholesalePrice: new Prisma.Decimal(2),
          stock: 48,
          piecesPerCarton: 24,
          cartonPurchasePrice: new Prisma.Decimal(48),
          cartonSalePrice: new Prisma.Decimal(60),
          storeId: local.storeId,
        },
      });

      await request(local.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${local.token}`)
        .send({
          paymentMethod: 'CASH',
          items: [{ productId: product.id, quantity: 2, saleUnit: 'CARTON' }],
        })
        .expect(201);

      const res = await request(local.server)
        .get('/api/reports/daily-profit')
        .set('Authorization', `Bearer ${local.token}`);

      expect(res.status).toBe(200);
      // Only this store's invoices count: revenue 2 × 60, cost 2 × 48.
      expect(res.body.totalRevenue).toBe(120);
      expect(res.body.totalCost).toBe(96);
      expect(res.body.netProfit).toBe(24);
    } finally {
      await teardown(local);
    }
  });
});

describe('Carton sales — invoice update and delete', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  async function makeCartonProduct(name: string, stock: number) {
    return ctx.db.product.create({
      data: {
        name,
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });
  }

  async function sellCartons(productId: string, cartons: number) {
    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId, quantity: cartons, saleUnit: 'CARTON' }],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('restores full carton pieces when the invoice is deleted', async () => {
    const product = await makeCartonProduct('Delete Restore', 48);
    const invoiceId = await sellCartons(product.id, 1);

    const mid = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(mid!.stock).toBe(24);

    const res = await request(ctx.server)
      .delete(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    expect([200, 204]).toContain(res.status);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(48); // 24 restored, not 1
  });

  it('restores carton pieces and deducts the new line when items are replaced', async () => {
    const product = await makeCartonProduct('Update Swap', 48);
    const invoiceId = await sellCartons(product.id, 1); // stock 24

    const res = await request(ctx.server)
      .patch(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ items: [{ productId: product.id, quantity: 5, saleUnit: 'UNIT' }] });

    expect(res.status).toBe(200);
    expect(Number(res.body.total)).toBe(15); // 5 × 3

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(43); // 24 + 24 restored − 5 deducted
  });

  it('upgrades a piece line to a carton line on update', async () => {
    const product = await makeCartonProduct('Upgrade To Carton', 48);

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 2 }],
      });
    expect(created.status).toBe(201); // stock 46

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }] });

    expect(res.status).toBe(200);
    expect(res.body.items[0].saleUnit).toBe('CARTON');
    expect(res.body.items[0].stockQuantity).toBe(24);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(24); // 46 + 2 restored − 24 deducted
  });

  it('updates an invoice to a carton line plus a loose-piece line of the same product', async () => {
    // Guards InvoiceService.update's productIds dedup: two dto.items entries
    // for the SAME product must not false-fire the "products not found" 404
    // that `products.length !== productIds.length` would throw without the
    // dedupe (products comes back deduped by the DB; productIds did not).
    const product = await makeCartonProduct('Update Dedup', 60);
    const invoiceId = await sellCartons(product.id, 1); // stock 60 − 24 = 36

    const res = await request(ctx.server)
      .patch(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        items: [
          { productId: product.id, quantity: 1, saleUnit: 'CARTON' },
          { productId: product.id, quantity: 3, saleUnit: 'UNIT' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(Number(res.body.total)).toBe(69); // 60 + (3 × 3)

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    // 36 (stock after the initial 1-carton sale: 60 − 24) + 24 (restore old
    // carton line) − 24 (new carton line) − 3 (new unit line) = 33
    expect(after!.stock).toBe(33);
  });

  it('rejects an update whose new carton line exceeds stock, in pieces', async () => {
    // Stock 20, piecesPerCarton 24. After restoring the old 3-piece line the
    // product holds 20 pieces, so a 1-carton line needs 24 and must be
    // refused. This is what pins the deduction predicate to stockQuantity:
    // with `gte: quantity` the check reads 20 >= 1, passes, drives stock
    // negative and surfaces as a 500 from the stock_non_negative constraint.
    const product = await makeCartonProduct('Update Oversell', 20);

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 3 }],
      });
    expect(created.status).toBe(201); // stock 17

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }] });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('24');

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(17); // rolled back
  });

  it('restores a pre-migration line by its quantity when items are replaced', async () => {
    // Mirrors the delete-path legacy test, for update. A line written before
    // the carton migration has stockQuantity NULL and was always a piece
    // sale, so quantity is its correct piece count. Without the ?? quantity
    // fallback this restores 0 and the product silently loses 3 pieces.
    const product = await ctx.db.product.create({
      data: {
        name: 'Legacy Update Restore',
        price: new Prisma.Decimal(10),
        wholesalePrice: new Prisma.Decimal(6),
        stock: 37,
        storeId: ctx.storeId,
      },
    });
    const invoice = await ctx.db.invoice.create({
      data: {
        number: 90002,
        total: new Prisma.Decimal(30),
        paid: new Prisma.Decimal(30),
        remaining: new Prisma.Decimal(0),
        paymentMethod: 'CASH',
        storeId: ctx.storeId,
        items: {
          create: {
            productName: 'Legacy Update Restore',
            price: new Prisma.Decimal(10),
            unitCost: new Prisma.Decimal(6),
            quantity: 3,
            total: new Prisma.Decimal(30),
            productId: product.id,
          },
        },
      },
    });
    await ctx.db.$executeRaw`
      UPDATE invoice_items SET "stockQuantity" = NULL WHERE "invoiceId" = ${invoice.id}
    `;

    const res = await request(ctx.server)
      .patch(`/api/invoices/${invoice.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ items: [{ productId: product.id, quantity: 5 }] });

    expect(res.status).toBe(200);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(35); // 37 + 3 restored − 5 deducted
  });
});

describe('Carton sales — read responses expose the line unit', () => {
  let ctx: Ctx;
  let invoiceId: string;
  let invoiceNumber: number;
  let customerId: string;

  beforeAll(async () => {
    ctx = await bootstrap();

    const product = await ctx.db.product.create({
      data: {
        name: 'Response Check',
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock: 48,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });
    const customer = await ctx.db.customer.create({
      data: { name: 'Carton Buyer', storeId: ctx.storeId },
    });
    customerId = customer.id;

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'DEBT',
        customerId,
        items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }],
      });
    expect(created.status).toBe(201);
    invoiceId = created.body.id;
    invoiceNumber = created.body.number;
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('returns saleUnit and stockQuantity from GET /invoices/:id', async () => {
    const res = await request(ctx.server)
      .get(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].saleUnit).toBe('CARTON');
    expect(res.body.items[0].stockQuantity).toBe(24);
  });

  it('returns saleUnit and stockQuantity from GET /invoices/number/:number', async () => {
    const res = await request(ctx.server)
      .get(`/api/invoices/number/${invoiceNumber}`)
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].saleUnit).toBe('CARTON');
    expect(res.body.items[0].stockQuantity).toBe(24);
  });

  it('returns saleUnit and stockQuantity in the customer invoice history', async () => {
    const res = await request(ctx.server)
      .get(`/api/customers/${customerId}`)
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices[0].items[0].saleUnit).toBe('CARTON');
    expect(res.body.invoices[0].items[0].stockQuantity).toBe(24);
  });
});

describe('Carton sales — offline sync push', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  async function makeCartonProduct(name: string, stock: number) {
    return ctx.db.product.create({
      data: {
        name,
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });
  }

  function offlineInvoice(productId: string, itemOverrides: Record<string, unknown>) {
    return {
      invoices: [
        {
          id: randomUUID(),
          date: new Date().toISOString(),
          total: 60,
          paid: 60,
          remaining: 0,
          paymentMethod: 'CASH',
          items: [
            {
              id: randomUUID(),
              productName: 'Offline Carton',
              price: 60,
              quantity: 1,
              total: 60,
              unitCost: 48,
              productId,
              ...itemOverrides,
            },
          ],
        },
      ],
      debts: [],
      debtPayments: [],
    };
  }

  it('recomputes pieces from the product when only saleUnit is sent', async () => {
    const product = await makeCartonProduct('Offline Recompute', 48);

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send(offlineInvoice(product.id, { saleUnit: 'CARTON' }));

    expect(res.status).toBe(200);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(24); // 48 − 24, not 48 − 1
  });

  it('honours an explicit stockQuantity from the device', async () => {
    // The explicit value (30) deliberately disagrees with what a server-side
    // recompute would produce (1 × 24 = 24, from the product's *current*
    // piecesPerCarton). The device reserved 30 pieces because the carton
    // held 30 pieces when this sale happened offline; the product's carton
    // size has since been changed to 24 on the server. The client's value
    // must win — it is what the device actually reserved against its own
    // local copy, not what the product looks like now. If the two numbers
    // agreed here, deleting the explicit-stockQuantity branch from
    // syncStockPieces would leave this test green for the wrong reason.
    const product = await makeCartonProduct('Offline Explicit', 48);

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send(
        offlineInvoice(product.id, { saleUnit: 'CARTON', stockQuantity: 30 }),
      );

    expect(res.status).toBe(200);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(18); // 48 − 30 (the explicit value), not 48 − 24

    const line = await ctx.db.invoiceItem.findFirst({
      where: { productId: product.id },
    });
    expect(line!.saleUnit).toBe('CARTON');
    expect(line!.stockQuantity).toBe(30);
  });

  it('still deducts pieces for a legacy payload with no saleUnit', async () => {
    const product = await makeCartonProduct('Offline Legacy', 48);

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send(offlineInvoice(product.id, {}));

    expect(res.status).toBe(200);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(47); // 48 − 1 piece
  });

  it('accepts a carton line on a non-carton product instead of destroying the batch', async () => {
    // The device sold this as a carton while offline; the product has since
    // lost its carton data. The sale physically happened, so the server must
    // record it and deduct pieces rather than reject — rejecting would throw
    // away every queued sale in the batch. It logs a stock-discrepancy
    // warning instead.
    const product = await ctx.db.product.create({
      data: {
        name: 'Offline No Carton Data',
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock: 48,
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send(offlineInvoice(product.id, { saleUnit: 'CARTON' }));

    expect(res.status).toBe(200);
    expect(res.body.report.invoices.inserted).toBe(1);

    // Falls back to the raw quantity: 1 piece, not a whole carton.
    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(47);
  });

  it('ignores a client stockQuantity on a piece line', async () => {
    // An outbox bug that computes stockQuantity without checking saleUnit
    // would otherwise deduct a whole carton for a one-piece sale, silently.
    const product = await makeCartonProduct('Offline Unit Overreach', 48);

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send(
        offlineInvoice(product.id, { saleUnit: 'UNIT', stockQuantity: 24 }),
      );

    expect(res.status).toBe(200);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(47); // 1 piece, not 24
  });
});
