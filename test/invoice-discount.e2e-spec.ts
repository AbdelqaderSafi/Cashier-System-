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

describe('Invoice discount — profit reporting', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('subtracts the discount from reported revenue and profit', async () => {
    // Without this, every shekel discounted is booked as phantom profit: the
    // line sum says 60 while the till actually took 50.
    const product = await makeProduct(ctx, 'Reported Discount');

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
      .get('/api/reports/daily-profit')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe(50); // 60 gross − 10 discount
    expect(res.body.totalCost).toBe(36); // 6 × 6 — a discount does not change cost
    expect(res.body.netProfit).toBe(14); // 50 − 36
  });

  it('agrees with the daily-sales summary', async () => {
    // Both endpoints should report the same money. Before this fix they
    // disagreed by exactly the discount total.
    const profit = await request(ctx.server)
      .get('/api/reports/daily-profit')
      .set('Authorization', `Bearer ${ctx.token}`);
    const sales = await request(ctx.server)
      .get('/api/invoices/daily-sales')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(profit.status).toBe(200);
    expect(sales.status).toBe(200);
    expect(Number(sales.body.summary.totalSales)).toBe(profit.body.totalRevenue);
  });
});

describe('Invoice discount — offline sync push', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('persists a discount pushed from an offline device and reports it', async () => {
    const product = await makeProduct(ctx, 'Offline Discount');
    const invoiceId = randomUUID();

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        invoices: [
          {
            id: invoiceId,
            date: new Date().toISOString(),
            total: 50, // net, as the device computed it
            paid: 50,
            remaining: 0,
            discount: 10,
            paymentMethod: 'CASH',
            items: [
              {
                id: randomUUID(),
                productName: 'Offline Discount',
                price: 10,
                quantity: 6,
                total: 60,
                unitCost: 6,
                productId: product.id,
              },
            ],
          },
        ],
        debts: [],
        debtPayments: [],
      });

    expect(res.status).toBe(200);

    const stored = await ctx.db.invoice.findUnique({ where: { id: invoiceId } });
    expect(Number(stored!.discount)).toBe(10);
    expect(Number(stored!.total)).toBe(50);

    // The report must see it too, otherwise the discount is phantom profit.
    const report = await request(ctx.server)
      .get('/api/reports/daily-profit')
      .set('Authorization', `Bearer ${ctx.token}`);
    expect(report.body.totalRevenue).toBe(50); // 60 line sum − 10 discount
  });

  it('defaults to zero for a legacy payload with no discount field', async () => {
    const product = await makeProduct(ctx, 'Offline No Discount');
    const invoiceId = randomUUID();

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        invoices: [
          {
            id: invoiceId,
            date: new Date().toISOString(),
            total: 60,
            paid: 60,
            remaining: 0,
            paymentMethod: 'CASH',
            items: [
              {
                id: randomUUID(),
                productName: 'Offline No Discount',
                price: 10,
                quantity: 6,
                total: 60,
                unitCost: 6,
                productId: product.id,
              },
            ],
          },
        ],
        debts: [],
        debtPayments: [],
      });

    expect(res.status).toBe(200);

    const stored = await ctx.db.invoice.findUnique({ where: { id: invoiceId } });
    expect(Number(stored!.discount)).toBe(0);
  });
});

describe('Invoice discount — refused once the debt has payments', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('refuses to change the discount once the debt has payments', async () => {
    const product = await makeProduct(ctx, 'Discount After Payment');
    const customer = await ctx.db.customer.create({
      data: { name: 'Paying Buyer', storeId: ctx.storeId },
    });

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'DEBT',
        customerId: customer.id,
        items: [{ productId: product.id, quantity: 6 }],
      });
    expect(created.status).toBe(201);

    const debt = await ctx.db.debt.findFirst({ where: { invoiceId: created.body.id } });
    const pay = await request(ctx.server)
      .post(`/api/debts/${debt!.id}/pay`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: 20 });
    expect(pay.status).toBe(201);

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ discount: 10 });

    expect(res.status).toBe(400);

    // The ledger must be untouched by the refusal.
    const invoice = await ctx.db.invoice.findUnique({ where: { id: created.body.id } });
    expect(Number(invoice!.total)).toBe(60);
    expect(Number(invoice!.discount)).toBe(0);
    const debtAfter = await ctx.db.debt.findUnique({ where: { id: debt!.id } });
    expect(Number(debtAfter!.paid)).toBe(20);
    expect(Number(debtAfter!.remaining)).toBe(40);
  });
});

describe('Invoice ledger — editing a debt-backed invoice', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('refuses ANY edit of a DEBT invoice once its debt has payments', async () => {
    // The update path recomputes paid/remaining from paymentMethod and rewrites
    // the debt from the new total. For DEBT it resets invoice.paid to 0 while
    // debts.paid keeps the payments — so the next payment writes
    // paid + remaining != total, trips invoice_balance_consistent, and the debt
    // can never be settled. A notes-only edit is enough to trigger it.
    const product = await makeProduct(ctx, 'Notes Edit After Payment');
    const customer = await ctx.db.customer.create({
      data: { name: 'Debt Payer', storeId: ctx.storeId },
    });

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'DEBT',
        customerId: customer.id,
        items: [{ productId: product.id, quantity: 10 }], // 100
      });
    expect(created.status).toBe(201);

    const debt = await ctx.db.debt.findFirst({ where: { invoiceId: created.body.id } });
    const pay = await request(ctx.server)
      .post(`/api/debts/${debt!.id}/pay`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: 40 });
    expect(pay.status).toBe(201);

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ notes: 'تصحيح ملاحظة' });

    expect(res.status).toBe(400);

    // The ledger must be exactly as the payment left it.
    const invoice = await ctx.db.invoice.findUnique({ where: { id: created.body.id } });
    expect(Number(invoice!.paid)).toBe(40); // NOT reset to 0
    expect(Number(invoice!.remaining)).toBe(60);
    expect(Number(invoice!.total)).toBe(100);

    const debtAfter = await ctx.db.debt.findUnique({ where: { id: debt!.id } });
    expect(Number(debtAfter!.paid)).toBe(40);
    expect(Number(debtAfter!.remaining)).toBe(60);
  });

  it('refuses ANY edit of a PARTIAL invoice once its debt has payments', async () => {
    // For PARTIAL the corruption is silent: the debt recompute subtracts the
    // already-made payments a second time, every CHECK still passes, and the
    // customer's outstanding balance is written off with no error anywhere.
    const product = await makeProduct(ctx, 'Partial Edit After Payment');
    const customer = await ctx.db.customer.create({
      data: { name: 'Partial Payer', storeId: ctx.storeId },
    });

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'PARTIAL',
        customerId: customer.id,
        paid: 30,
        items: [{ productId: product.id, quantity: 10 }], // 100, debt 70
      });
    expect(created.status).toBe(201);

    const debt = await ctx.db.debt.findFirst({ where: { invoiceId: created.body.id } });
    const pay = await request(ctx.server)
      .post(`/api/debts/${debt!.id}/pay`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: 20 });
    expect(pay.status).toBe(201);

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ notes: 'x' });

    expect(res.status).toBe(400);

    // 20 of real customer debt must still be owed, not silently forgiven.
    const debtAfter = await ctx.db.debt.findUnique({ where: { id: debt!.id } });
    expect(Number(debtAfter!.amount)).toBe(70);
    expect(Number(debtAfter!.paid)).toBe(20);
    expect(Number(debtAfter!.remaining)).toBe(50);
    expect(debtAfter!.isPaid).toBe(false);
  });
});
