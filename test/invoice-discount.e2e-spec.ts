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
 * Invoice discount (e2e).
 *
 * Same isolation pattern as the other suites: each describe block gets its own
 * throwaway store (`discount-test-*` subdomain) and tears it down in afterAll.
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

  const subdomain = `discount-test-${randomUUID().slice(0, 8)}`;
  const store = await db.store.create({
    data: { name: `Discount Test ${subdomain}`, subdomain, status: 'APPROVED' },
  });
  const user = await db.user.create({
    data: {
      username: `tester-${subdomain}`,
      email: `${subdomain}@discount.test`,
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

export async function makeProduct(ctx: Ctx, name: string, stock = 100) {
  return ctx.db.product.create({
    data: {
      name,
      price: new Prisma.Decimal(10),
      wholesalePrice: new Prisma.Decimal(6),
      stock,
      storeId: ctx.storeId,
    },
  });
}

describe('Invoice discount — backward compatibility', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('creates an invoice with no discount field — discount is 0 and total is unchanged', async () => {
    const product = await makeProduct(ctx, 'No Discount');

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 6 }] });

    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(60);
    expect(Number(res.body.discount)).toBe(0);
    expect(Number(res.body.paid)).toBe(60);
    expect(Number(res.body.remaining)).toBe(0);
  });

  it('reports full revenue for an undiscounted invoice', async () => {
    const res = await request(ctx.server)
      .get('/api/reports/daily-profit')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe(60); // 6 × 10, nothing subtracted
    expect(res.body.totalCost).toBe(36); // 6 × 6
  });
});

describe('Invoice discount — create and update', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('stores the net total and the discount for a cash sale', async () => {
    const product = await makeProduct(ctx, 'Cash Discount');

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        discount: 10,
        items: [{ productId: product.id, quantity: 6 }],
      });

    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(50); // 60 − 10
    expect(Number(res.body.discount)).toBe(10);
    expect(Number(res.body.paid)).toBe(50);
    expect(Number(res.body.remaining)).toBe(0);
  });

  it('bases the debt on the discounted total', async () => {
    const product = await makeProduct(ctx, 'Debt Discount');
    const customer = await ctx.db.customer.create({
      data: { name: 'Discount Buyer', storeId: ctx.storeId },
    });

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'DEBT',
        customerId: customer.id,
        discount: 10,
        items: [{ productId: product.id, quantity: 6 }],
      });

    expect(res.status).toBe(201);
    expect(Number(res.body.remaining)).toBe(50);

    const debt = await ctx.db.debt.findFirst({ where: { invoiceId: res.body.id } });
    expect(Number(debt!.remaining)).toBe(50);
  });

  it('caps a partial payment at the discounted total, not the gross', async () => {
    const product = await makeProduct(ctx, 'Partial Discount');
    const customer = await ctx.db.customer.create({
      data: { name: 'Partial Buyer', storeId: ctx.storeId },
    });

    // 55 is below the gross (60) but above the net (50) — it must be refused,
    // otherwise a "partial" payment would exceed what is actually owed.
    const tooMuch = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'PARTIAL',
        customerId: customer.id,
        discount: 10,
        paid: 55,
        items: [{ productId: product.id, quantity: 6 }],
      });
    expect(tooMuch.status).toBe(400);

    const ok = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'PARTIAL',
        customerId: customer.id,
        discount: 10,
        paid: 45,
        items: [{ productId: product.id, quantity: 6 }],
      });
    expect(ok.status).toBe(201);
    expect(Number(ok.body.total)).toBe(50);
    expect(Number(ok.body.remaining)).toBe(5);
  });

  it('rejects a discount equal to or above the gross total', async () => {
    const product = await makeProduct(ctx, 'Over Discount');

    for (const discount of [60, 70]) {
      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'CASH',
          discount,
          items: [{ productId: product.id, quantity: 6 }],
        });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a negative discount', async () => {
    const product = await makeProduct(ctx, 'Negative Discount');

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        discount: -5,
        items: [{ productId: product.id, quantity: 6 }],
      });

    expect(res.status).toBe(400);
  });

  it('preserves an existing discount when PATCH omits the field', async () => {
    // Without this, editing any discounted invoice silently reverts its total
    // to the gross and the customer is charged more than agreed.
    const product = await makeProduct(ctx, 'Preserve Discount');

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        discount: 10,
        items: [{ productId: product.id, quantity: 6 }],
      });
    expect(created.status).toBe(201);

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ notes: 'ملاحظة جديدة' });

    expect(res.status).toBe(200);
    expect(Number(res.body.discount)).toBe(10);
    expect(Number(res.body.total)).toBe(50);
  });

  it('recomputes the total when PATCH changes the discount', async () => {
    const product = await makeProduct(ctx, 'Change Discount');

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        discount: 10,
        items: [{ productId: product.id, quantity: 6 }],
      });
    expect(created.status).toBe(201);

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ discount: 20 });

    expect(res.status).toBe(200);
    expect(Number(res.body.discount)).toBe(20);
    expect(Number(res.body.total)).toBe(40);
    expect(Number(res.body.paid)).toBe(40);
  });

  it('re-applies a preserved discount when PATCH replaces the items', async () => {
    // The gross changes, so the net must be recomputed from the NEW gross
    // using the SAME preserved discount.
    const product = await makeProduct(ctx, 'Reapply Discount');

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        discount: 10,
        items: [{ productId: product.id, quantity: 6 }],
      });
    expect(created.status).toBe(201);

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ items: [{ productId: product.id, quantity: 10 }] });

    expect(res.status).toBe(200);
    expect(Number(res.body.discount)).toBe(10);
    expect(Number(res.body.total)).toBe(90); // 100 − 10
  });
});
