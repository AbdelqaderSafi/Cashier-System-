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
