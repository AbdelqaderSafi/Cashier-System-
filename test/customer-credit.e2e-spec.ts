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
 * Customer credit balance (e2e).
 *
 * Runs against a local throwaway DB (test/guard-local-db.ts enforces this).
 * Each describe block owns a fresh store identified by a uuid subdomain
 * (`credit-test-*`) so a crash leaves a recognisable footprint.
 */

type Ctx = {
  app: INestApplication;
  server: Server;
  db: DatabaseService;
  storeId: string;
  token: string;
};

async function bootstrap(): Promise<Ctx> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const db = app.get(DatabaseService);
  const jwt = app.get(JwtService);

  const subdomain = `credit-test-${randomUUID().slice(0, 8)}`;
  const store = await db.store.create({
    data: { name: `Credit Test ${subdomain}`, subdomain, status: 'APPROVED' },
  });
  const user = await db.user.create({
    data: {
      username: `tester-${subdomain}`,
      email: `${subdomain}@credit.test`,
      password: 'x', // not used — we mint the JWT directly
      role: 'ADMIN',
      storeId: store.id,
      isEmailVerified: true,
    },
  });

  const token = await jwt.signAsync(
    { sub: user.id, storeId: store.id, role: 'ADMIN' },
    { secret: env.JWT_SECRET, expiresIn: '10m' },
  );

  return {
    app,
    server: app.getHttpServer() as Server,
    db,
    storeId: store.id,
    token,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  // credit_entries FKs both debt_payments and debt_payment_operations, so it
  // goes first. Both new tables use RESTRICT on customerId, so they must be
  // gone before customers.
  const { db, storeId } = ctx;
  await db.creditEntry.deleteMany({ where: { storeId } });
  await db.debtPayment.deleteMany({ where: { debt: { storeId } } });
  await db.debtPaymentOperation.deleteMany({ where: { storeId } });
  await db.debt.deleteMany({ where: { storeId } });
  await db.invoiceItem.deleteMany({ where: { invoice: { storeId } } });
  await db.invoice.deleteMany({ where: { storeId } });
  await db.product.deleteMany({ where: { storeId } });
  await db.customer.deleteMany({ where: { storeId } });
  await db.user.deleteMany({ where: { storeId } });
  await db.store.delete({ where: { id: storeId } });
  await ctx.app.close();
}

describe('Customer credit balance (e2e)', () => {
  // ─── Task 1 — schema defaults and the non-negative constraint ─────────────
  describe('Schema defaults', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await bootstrap();
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('defaults a new customer to zero credit', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Zero', storeId: ctx.storeId },
      });
      expect(new Prisma.Decimal(customer.creditBalance).equals(0)).toBe(true);
    });

    it('defaults a debt payment to source CASH with no operation', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'CashOnly', storeId: ctx.storeId },
      });
      const debt = await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(50),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(50),
          customerId: customer.id,
          storeId: ctx.storeId,
        },
      });
      const payment = await ctx.db.debtPayment.create({
        data: { amount: new Prisma.Decimal(10), debtId: debt.id },
      });
      expect(payment.source).toBe('CASH');
      expect(payment.operationId).toBeNull();
    });

    it('refuses a negative creditBalance at the database level', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Negative', storeId: ctx.storeId },
      });
      await expect(
        ctx.db.$executeRaw`
          UPDATE customers SET "creditBalance" = -1 WHERE id = ${customer.id}
        `,
      ).rejects.toThrow(/customer_credit_non_negative/);

      const reread = await ctx.db.customer.findUniqueOrThrow({
        where: { id: customer.id },
      });
      expect(new Prisma.Decimal(reread.creditBalance).equals(0)).toBe(true);
    });
  });

  // ─── Task 3 — overpayment becomes credit ──────────────────────────────────
  describe('Overpaying a customer debt', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await bootstrap();
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const makeCustomerWithDebt = async (amount: number) => {
      const customer = await ctx.db.customer.create({
        data: { name: `C-${randomUUID().slice(0, 6)}`, storeId: ctx.storeId },
      });
      if (amount > 0) {
        await ctx.db.debt.create({
          data: {
            amount: new Prisma.Decimal(amount),
            paid: new Prisma.Decimal(0),
            remaining: new Prisma.Decimal(amount),
            customerId: customer.id,
            storeId: ctx.storeId,
          },
        });
      }
      return customer.id;
    };

    // Seeds credit the way the app actually creates it: an overpayment while
    // the customer owes nothing. Must run before any debt exists for the
    // customer, or the payment settles the debt instead of becoming credit.
    // Asserts 201 so a silent failure can't leave the fixture at zero credit.
    const seedCredit = async (customerId: string, amount: number) => {
      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount });
      expect(res.status).toBe(201);
    };

    it('settles the debt and parks the excess as credit', async () => {
      const customerId = await makeCustomerWithDebt(100);

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });

      expect(res.status).toBe(201);
      expect(res.body.summary.totalRemaining).toBe('0');
      expect(res.body.summary.creditBalance).toBe('50');
      expect(res.body.summary.balance).toBe('50');
      expect(res.body.excessToCredit).toBe('50');
      expect(res.body.creditApplied).toBe('0');
      expect(res.body.affectedDebts[0].creditPaid).toBe('0');

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(50)).toBe(true);

      const entries = await ctx.db.creditEntry.findMany({ where: { customerId } });
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe('OVERPAYMENT');
      expect(new Prisma.Decimal(entries[0].delta).equals(50)).toBe(true);
      expect(new Prisma.Decimal(entries[0].balanceAfter).equals(50)).toBe(true);
    });

    // The documented claim `Σ amountPaid === paymentApplied` is false whenever
    // there is a surplus: paymentApplied is the cash TENDERED, amountPaid is
    // the cash APPLIED to debts, and the gap is exactly excessToCredit. See
    // docs/superpowers/specs/2026-08-23-customer-credit-balance-design.md §١١.٢.
    it('honours the true identity: Σ amountPaid + excessToCredit === paymentApplied', async () => {
      const customerId = await makeCustomerWithDebt(100);

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });

      expect(res.status).toBe(201);
      const sumAmountPaid = (res.body.affectedDebts as { amountPaid: string }[]).reduce(
        (acc, d) => acc.plus(new Prisma.Decimal(d.amountPaid)),
        new Prisma.Decimal(0),
      );
      const total = sumAmountPaid.plus(new Prisma.Decimal(res.body.excessToCredit));
      expect(total.equals(new Prisma.Decimal(res.body.paymentApplied))).toBe(true);
      expect(sumAmountPaid.equals(100)).toBe(true);
      expect(res.body.excessToCredit).toBe('50');
      expect(res.body.paymentApplied).toBe('150');
    });

    it('accepts a payment from a customer who owes nothing', async () => {
      const customerId = await makeCustomerWithDebt(0);

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 100 });

      expect(res.status).toBe(201);
      expect(res.body.summary.creditBalance).toBe('100');
      expect(res.body.summary.balance).toBe('100');
      expect(res.body.affectedDebts).toEqual([]);
    });

    it('spends stored credit on debts the cash did not cover', async () => {
      const customerId = await makeCustomerWithDebt(0);
      await seedCredit(customerId, 50);
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(80),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(80),
          customerId,
          storeId: ctx.storeId,
        },
      });

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 30 });

      expect(res.status).toBe(201);
      expect(res.body.summary.totalRemaining).toBe('0');
      expect(res.body.summary.creditBalance).toBe('0');
      expect(res.body.summary.balance).toBe('0');
      expect(res.body.creditApplied).toBe('50');
      expect(res.body.excessToCredit).toBe('0');
      expect(res.body.affectedDebts).toHaveLength(1);
      expect(res.body.affectedDebts[0].amountPaid).toBe('30');
      expect(res.body.affectedDebts[0].creditPaid).toBe('50');
      expect(res.body.affectedDebts[0].isPaid).toBe(true);
    });

    it('returns all of the customer debts, settled ones included', async () => {
      const customerId = await makeCustomerWithDebt(40);
      // A second, untouched debt — proves the response returns every debt
      // for the customer, not just the one(s) the payment happened to touch.
      const untouchedDebt = await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(70),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(70),
          customerId,
          storeId: ctx.storeId,
        },
      });

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 40 });

      expect(res.status).toBe(201);
      expect(res.body.debts).toHaveLength(2);

      const settled = res.body.debts.find(
        (d: { amount: string; isPaid: boolean }) => Number(d.amount) === 40,
      );
      const untouched = res.body.debts.find(
        (d: { id: string }) => d.id === untouchedDebt.id,
      );
      expect(settled).toBeDefined();
      expect(settled.isPaid).toBe(true);
      expect(untouched).toBeDefined();
      expect(untouched.isPaid).toBe(false);
      expect(untouched.remaining).toBe('70');
    });

    it('replays an identical clientOperationId without moving money twice', async () => {
      const customerId = await makeCustomerWithDebt(100);
      const key = `op-${randomUUID()}`;

      const first = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150, clientOperationId: key });
      const second = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150, clientOperationId: key });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.affectedDebts).toEqual(first.body.affectedDebts);
      expect(second.body.excessToCredit).toBe('50');

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(50)).toBe(true);

      const ops = await ctx.db.debtPaymentOperation.findMany({ where: { customerId } });
      expect(ops).toHaveLength(1);
    });

    it('replays the original result even when the amount differs', async () => {
      const customerId = await makeCustomerWithDebt(100);
      const key = `op-${randomUUID()}`;

      await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 100, clientOperationId: key });
      const replay = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 999, clientOperationId: key });

      expect(replay.status).toBe(201);
      expect(replay.body.paymentApplied).toBe('100');

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(0)).toBe(true);
    });

    it('rejects a clientOperationId reused across two different customers', async () => {
      const customerAId = await makeCustomerWithDebt(100);
      const customerBId = await makeCustomerWithDebt(100);
      const key = `op-${randomUUID()}`;

      const first = await request(ctx.server)
        .post(`/api/debts/customer/${customerAId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 50, clientOperationId: key });
      expect(first.status).toBe(201);

      const second = await request(ctx.server)
        .post(`/api/debts/customer/${customerBId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 50, clientOperationId: key });
      expect(second.status).toBe(409);

      // Customer B's payment must never have been applied.
      const debtsB = await ctx.db.debt.findMany({ where: { customerId: customerBId } });
      const remainingB = debtsB.reduce(
        (acc, d) => acc.plus(new Prisma.Decimal(d.remaining)),
        new Prisma.Decimal(0),
      );
      expect(remainingB.equals(100)).toBe(true);

      const customerB = await ctx.db.customer.findUnique({ where: { id: customerBId } });
      expect(new Prisma.Decimal(customerB!.creditBalance).equals(0)).toBe(true);
    });

    it('rejects a payment against a missing or soft-deleted customer with 404', async () => {
      const res = await request(ctx.server)
        .post(`/api/debts/customer/${randomUUID()}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 50 });

      expect(res.status).toBe(404);
    });

    // The random-UUID case above never touches the `AND "isDeleted" = false`
    // clause in lockCustomerForCredit — a missing row and a filtered-out row
    // both come back empty either way. A soft-deleted customer who still has
    // a live debt is the case that actually exercises the clause: dropping it
    // would silently let this payment through.
    it('rejects a payment against a soft-deleted customer who still has a live debt with 404', async () => {
      const customerId = await makeCustomerWithDebt(100);
      await ctx.db.customer.update({
        where: { id: customerId },
        data: { isDeleted: true, deletedAt: new Date() },
      });

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 50 });

      expect(res.status).toBe(404);
    });

    it('rejects a tender above the DECIMAL(10,2) column ceiling with 400, not 500', async () => {
      const customerId = await makeCustomerWithDebt(100);

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 100000000 });

      expect(res.status).toBe(400);

      const debts = await ctx.db.debt.findMany({ where: { customerId } });
      const remaining = debts.reduce(
        (acc, d) => acc.plus(new Prisma.Decimal(d.remaining)),
        new Prisma.Decimal(0),
      );
      expect(remaining.equals(100)).toBe(true);
    });

    // Neither individual payment below trips the DTO's @Max on `amount` —
    // each is well under 99999999.99. Only the *running total* crosses the
    // DECIMAL(10,2) ceiling on creditBalance, which only grantCredit can see.
    // Seeded through the API (seedCredit), not a raw write, so the ledger
    // stays consistent for the reconciliation test at the end of this file.
    it('rejects an overpayment that would push the accumulated creditBalance past the DECIMAL(10,2) ceiling', async () => {
      const customerId = await makeCustomerWithDebt(0);
      await seedCredit(customerId, 60000000);

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 60000000 });

      expect(res.status).toBe(400);

      const customer = await ctx.db.customer.findUnique({
        where: { id: customerId },
      });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(60000000)).toBe(
        true,
      );
    });

    it('serialises two concurrent payments without double-spending credit', async () => {
      const customerId = await makeCustomerWithDebt(0);
      await seedCredit(customerId, 50);
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(200),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(200),
          customerId,
          storeId: ctx.storeId,
        },
      });

      await Promise.allSettled([
        request(ctx.server)
          .post(`/api/debts/customer/${customerId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 20 }),
        request(ctx.server)
          .post(`/api/debts/customer/${customerId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 20 }),
      ]);

      // 200 debt − 20 − 20 cash − 50 credit (spent exactly once) = 110.
      const debts = await ctx.db.debt.findMany({ where: { customerId } });
      const remaining = debts.reduce(
        (acc, d) => acc.plus(new Prisma.Decimal(d.remaining)),
        new Prisma.Decimal(0),
      );
      expect(remaining.equals(110)).toBe(true);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(0)).toBe(true);
    }, 30_000);

    // Every debt above is built with ctx.db.debt.create and no invoiceId, so
    // only the null side of the `if (invoiceId)` guard in debt.service.ts and
    // credit.tx.ts has ever run. These two tests build a real DEBT invoice
    // through POST /api/invoices so a linked debt exists with a real
    // invoiceId, and check the invoice mirror actually reconciles.
    const makeProduct = async (price: number, stock = 100) =>
      ctx.db.product.create({
        data: {
          name: `Product-${randomUUID().slice(0, 6)}`,
          price: new Prisma.Decimal(price),
          wholesalePrice: new Prisma.Decimal(price).minus(1),
          stock,
          storeId: ctx.storeId,
        },
      });

    it('reconciles the linked invoice after overpaying an invoice-backed debt (cash path)', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: `Inv-${randomUUID().slice(0, 6)}`, storeId: ctx.storeId },
      });
      const product = await makeProduct(10);

      const invoiceRes = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId: customer.id,
          items: [{ productId: product.id, quantity: 10 }],
        });
      expect(invoiceRes.status).toBe(201);
      expect(Number(invoiceRes.body.total)).toBe(100);

      const debt = await ctx.db.debt.findFirst({ where: { invoiceId: invoiceRes.body.id } });
      expect(debt).not.toBeNull();
      expect(new Prisma.Decimal(debt!.remaining).equals(100)).toBe(true);

      const payRes = await request(ctx.server)
        .post(`/api/debts/customer/${customer.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });
      expect(payRes.status).toBe(201);
      expect(payRes.body.excessToCredit).toBe('50');

      const invoice = await ctx.db.invoice.findUniqueOrThrow({
        where: { id: invoiceRes.body.id },
      });
      const total = new Prisma.Decimal(invoice.total);
      const paid = new Prisma.Decimal(invoice.paid);
      const remaining = new Prisma.Decimal(invoice.remaining);
      expect(paid.plus(remaining).equals(total)).toBe(true);
      expect(remaining.isZero()).toBe(true);
      expect(paid.equals(100)).toBe(true);
    });

    it('reconciles the linked invoice when stored credit settles the tail of an invoice-backed debt', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: `Inv-${randomUUID().slice(0, 6)}`, storeId: ctx.storeId },
      });
      // NOTE: cannot be reordered to "invoice first, credit second" — see
      // the fix-round-3 report for why that reordering (as requested) is
      // incompatible with seedCredit's own precondition and was reverted.
      await seedCredit(customer.id, 50);
      const product = await makeProduct(8);

      const invoiceRes = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId: customer.id,
          items: [{ productId: product.id, quantity: 10 }],
        });
      expect(invoiceRes.status).toBe(201);
      expect(Number(invoiceRes.body.total)).toBe(80);

      // Task 4: invoice creation consumes stored credit immediately, so the
      // debt is born already 50 paid down — not still fully open, waiting
      // for a payment to discover the credit later.
      const debtAtBirth = await ctx.db.debt.findFirst({
        where: { invoiceId: invoiceRes.body.id },
      });
      expect(new Prisma.Decimal(debtAtBirth!.paid).equals(50)).toBe(true);
      expect(new Prisma.Decimal(debtAtBirth!.remaining).equals(30)).toBe(true);
      const creditPayments = await ctx.db.debtPayment.findMany({
        where: { debtId: debtAtBirth!.id, source: 'CREDIT' },
      });
      expect(creditPayments).toHaveLength(1);
      const customerAfterCreate = await ctx.db.customer.findUnique({
        where: { id: customer.id },
      });
      expect(
        new Prisma.Decimal(customerAfterCreate!.creditBalance).equals(0),
      ).toBe(true);

      const payRes = await request(ctx.server)
        .post(`/api/debts/customer/${customer.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 30 });
      expect(payRes.status).toBe(201);
      expect(payRes.body.creditApplied).toBe('0');
      expect(payRes.body.affectedDebts[0].amountPaid).toBe('30');
      expect(payRes.body.affectedDebts[0].creditPaid).toBe('0');
      expect(payRes.body.affectedDebts[0].isPaid).toBe(true);

      const invoice = await ctx.db.invoice.findUniqueOrThrow({
        where: { id: invoiceRes.body.id },
      });
      const total = new Prisma.Decimal(invoice.total);
      const paid = new Prisma.Decimal(invoice.paid);
      const remaining = new Prisma.Decimal(invoice.remaining);
      expect(paid.plus(remaining).equals(total)).toBe(true);
      expect(remaining.isZero()).toBe(true);
      expect(paid.equals(80)).toBe(true);
    });

    it('keeps the ledger reconciled with the denormalized column', async () => {
      const customers = await ctx.db.customer.findMany({
        where: { storeId: ctx.storeId },
        select: { id: true, creditBalance: true },
      });
      for (const c of customers) {
        const entries = await ctx.db.creditEntry.findMany({
          where: { customerId: c.id },
          select: { delta: true },
        });
        const sum = entries.reduce(
          (acc, e) => acc.plus(new Prisma.Decimal(e.delta)),
          new Prisma.Decimal(0),
        );
        expect(sum.equals(new Prisma.Decimal(c.creditBalance))).toBe(true);
      }
    });
  });

  // ─── Task 4 — a new debt invoice eats stored credit ───────────────────────
  describe('Credit consumption on invoice creation', () => {
    let ctx: Ctx;
    let productId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'Widget',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(4),
          stock: 1000,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const customerWithCredit = async (credit: number) => {
      const c = await ctx.db.customer.create({
        data: { name: `C-${randomUUID().slice(0, 6)}`, storeId: ctx.storeId },
      });
      if (credit > 0) {
        // Seed via the same overpayment path the app uses, so the ledger and
        // the denormalized column agree. The endpoint rejects amount <= 0,
        // so credit === 0 must issue no request at all.
        const res = await request(ctx.server)
          .post(`/api/debts/customer/${c.id}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: credit });
        expect(res.status).toBe(201);
      }
      return c.id;
    };

    it('spends part of the credit and leaves the rest of the debt open', async () => {
      const customerId = await customerWithCredit(50);

      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId,
          items: [{ productId, quantity: 8 }],
        });

      expect(res.status).toBe(201);

      const debt = await ctx.db.debt.findFirst({
        where: { invoiceId: res.body.id },
      });
      expect(new Prisma.Decimal(debt!.paid).equals(50)).toBe(true);
      expect(new Prisma.Decimal(debt!.remaining).equals(30)).toBe(true);
      expect(debt!.isPaid).toBe(false);

      const invoice = await ctx.db.invoice.findUnique({
        where: { id: res.body.id },
      });
      expect(new Prisma.Decimal(invoice!.paid).equals(50)).toBe(true);
      expect(new Prisma.Decimal(invoice!.remaining).equals(30)).toBe(true);

      const customer = await ctx.db.customer.findUnique({
        where: { id: customerId },
      });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(0)).toBe(true);

      const payments = await ctx.db.debtPayment.findMany({
        where: { debtId: debt!.id },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0].source).toBe('CREDIT');
    });

    it('marks the debt paid explicitly when credit covers it entirely', async () => {
      const customerId = await customerWithCredit(100);

      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId,
          items: [{ productId, quantity: 10 }],
        });

      expect(res.status).toBe(201);
      expect(new Prisma.Decimal(res.body.paid).equals(100)).toBe(true);
      expect(new Prisma.Decimal(res.body.remaining).equals(0)).toBe(true);

      const debt = await ctx.db.debt.findFirst({
        where: { invoiceId: res.body.id },
      });
      expect(debt!.isPaid).toBe(true);
      expect(new Prisma.Decimal(debt!.remaining).equals(0)).toBe(true);

      const customer = await ctx.db.customer.findUnique({
        where: { id: customerId },
      });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(0)).toBe(true);
    });

    it('applies credit to the deferred part of a PARTIAL invoice', async () => {
      const customerId = await customerWithCredit(100);

      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'PARTIAL',
          customerId,
          paid: 40,
          items: [{ productId, quantity: 10 }],
        });

      expect(res.status).toBe(201);
      expect(new Prisma.Decimal(res.body.paid).equals(100)).toBe(true);
      expect(new Prisma.Decimal(res.body.remaining).equals(0)).toBe(true);

      const invoice = await ctx.db.invoice.findUnique({
        where: { id: res.body.id },
      });
      expect(new Prisma.Decimal(invoice!.paid).equals(100)).toBe(true);
      expect(new Prisma.Decimal(invoice!.remaining).equals(0)).toBe(true);

      const debt = await ctx.db.debt.findFirst({
        where: { invoiceId: res.body.id },
      });
      expect(debt!.isPaid).toBe(true);
      expect(new Prisma.Decimal(debt!.remaining).equals(0)).toBe(true);

      const payments = await ctx.db.debtPayment.findMany({
        where: { debtId: debt!.id },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0].source).toBe('CREDIT');

      const customer = await ctx.db.customer.findUnique({
        where: { id: customerId },
      });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(40)).toBe(true);
    });

    it('leaves credit alone on a CASH sale', async () => {
      const customerId = await customerWithCredit(50);

      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'CASH',
          customerId,
          items: [{ productId, quantity: 3 }],
        });

      expect(res.status).toBe(201);
      const customer = await ctx.db.customer.findUnique({
        where: { id: customerId },
      });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(50)).toBe(true);

      // The credit is untouched for two independent reasons, and only one of
      // them is the credit hook. CASH/ONLINE also hard-nulls customerId, so a
      // cash sale never attaches to a customer's history at all. Assert that
      // directly — without this line the whole test still passes with the
      // null-ing ternary deleted, because `needsCustomer` is false for CASH
      // and gates the credit hook out anyway. Verified by mutation.
      const stored = await ctx.db.invoice.findUnique({
        where: { id: res.body.id },
        select: { customerId: true },
      });
      expect(stored!.customerId).toBeNull();
    });

    it('does not deadlock when a sale and a payment race on the same customer', async () => {
      const customerId = await customerWithCredit(0);
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId,
          storeId: ctx.storeId,
        },
      });

      const results = await Promise.allSettled([
        request(ctx.server)
          .post('/api/invoices')
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({
            paymentMethod: 'DEBT',
            customerId,
            items: [{ productId, quantity: 5 }],
          }),
        request(ctx.server)
          .post(`/api/debts/customer/${customerId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 40 }),
      ]);

      const statuses = results.map((r) =>
        r.status === 'fulfilled' ? r.value.status : 0,
      );
      expect(statuses.every((s) => s === 201)).toBe(true);
      expect(statuses).not.toContain(500);
    }, 30_000);
  });

  // ─── Task 5 — reversal paths ──────────────────────────────────────────────
  describe('Reversing credit', () => {
    let ctx: Ctx;
    let productId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'Widget',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(4),
          stock: 1000,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const customerWithCredit = async (credit: number) => {
      const c = await ctx.db.customer.create({
        data: { name: `C-${randomUUID().slice(0, 6)}`, storeId: ctx.storeId },
      });
      if (credit > 0) {
        // Seed via the same overpayment path the app uses, so the ledger and
        // the denormalized column agree. The endpoint rejects amount <= 0,
        // so credit === 0 must issue no request at all.
        const res = await request(ctx.server)
          .post(`/api/debts/customer/${c.id}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: credit });
        expect(res.status).toBe(201);
      }
      return c.id;
    };

    const debtInvoice = async (customerId: string, qty: number) => {
      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ paymentMethod: 'DEBT', customerId, items: [{ productId, quantity: qty }] });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    it('returns the credit when a credit-covered invoice is deleted', async () => {
      const customerId = await customerWithCredit(100);
      const invoiceId = await debtInvoice(customerId, 10);

      const res = await request(ctx.server)
        .delete(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(res.status).toBe(204);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(100)).toBe(true);

      const reversal = await ctx.db.creditEntry.findFirst({
        where: { customerId, reason: 'APPLIED_REVERSED' },
      });
      expect(reversal).toBeTruthy();
    });

    it('allows editing a credit-covered invoice downward', async () => {
      const customerId = await customerWithCredit(100);
      const invoiceId = await debtInvoice(customerId, 10);

      const res = await request(ctx.server)
        .patch(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ items: [{ productId, quantity: 6 }] });

      expect(res.status).toBe(200);

      // The re-application inside the transaction moves paid from 0 to 60 —
      // the response must reflect that, not the pre-credit snapshot taken
      // before re-application ran (it would say paid=0/remaining=60).
      expect(new Prisma.Decimal(res.body.paid).equals(60)).toBe(true);
      expect(new Prisma.Decimal(res.body.remaining).equals(0)).toBe(true);

      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });
      expect(new Prisma.Decimal(debt!.amount).equals(60)).toBe(true);
      expect(new Prisma.Decimal(debt!.remaining).equals(0)).toBe(true);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(40)).toBe(true);
    });

    // Worked example from the review: PARTIAL total 100, submitted paid 30,
    // customer holds 40 credit. After create(): invoice(paid=70, remaining=30),
    // debt(amount=70, paid=40, remaining=30), credit=0. A no-op PATCH must not
    // touch any of that — the reversal-then-reapply round trip inside update()
    // has to land back on exactly the same numbers.
    it('does not mint credit on a no-op PATCH of a credit-funded PARTIAL invoice', async () => {
      const customerId = await customerWithCredit(40);

      const create = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'PARTIAL',
          customerId,
          paid: 30,
          items: [{ productId, quantity: 10 }], // total = 100
        });
      expect(create.status).toBe(201);
      const invoiceId = create.body.id as string;

      const debtBefore = await ctx.db.debt.findFirst({ where: { invoiceId } });
      const invoiceBefore = await ctx.db.invoice.findUnique({ where: { id: invoiceId } });
      const customerBefore = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(debtBefore!.amount).equals(70)).toBe(true);
      expect(new Prisma.Decimal(debtBefore!.remaining).equals(30)).toBe(true);
      expect(new Prisma.Decimal(invoiceBefore!.paid).equals(70)).toBe(true);
      expect(new Prisma.Decimal(invoiceBefore!.remaining).equals(30)).toBe(true);
      expect(new Prisma.Decimal(customerBefore!.creditBalance).equals(0)).toBe(true);

      const patch = await request(ctx.server)
        .patch(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ notes: 'x' });
      expect(patch.status).toBe(200);

      const debtAfter = await ctx.db.debt.findFirst({ where: { invoiceId } });
      const invoiceAfter = await ctx.db.invoice.findUnique({ where: { id: invoiceId } });
      const customerAfter = await ctx.db.customer.findUnique({
        where: { id: customerId },
      });

      expect(
        new Prisma.Decimal(debtAfter!.amount).equals(
          new Prisma.Decimal(debtBefore!.amount),
        ),
      ).toBe(true);
      expect(
        new Prisma.Decimal(debtAfter!.remaining).equals(
          new Prisma.Decimal(debtBefore!.remaining),
        ),
      ).toBe(true);
      // The columns fix-1 was actually about: an implementation that dropped
      // the reversal entirely and only patched the PARTIAL fallback would
      // still pass every assertion above while leaving invoice.paid/remaining
      // wrong (or double-counted).
      expect(
        new Prisma.Decimal(invoiceAfter!.paid).equals(
          new Prisma.Decimal(invoiceBefore!.paid),
        ),
      ).toBe(true);
      expect(
        new Prisma.Decimal(invoiceAfter!.remaining).equals(
          new Prisma.Decimal(invoiceBefore!.remaining),
        ),
      ).toBe(true);
      expect(
        new Prisma.Decimal(customerAfter!.creditBalance).equals(
          new Prisma.Decimal(customerBefore!.creditBalance),
        ),
      ).toBe(true);

      // Exactly one CREDIT payment survives the round trip: the reversal
      // deletes the original, and re-application (still needed — the debt
      // still owes 30 in cash terms after the no-op) writes exactly one new
      // one. Two would mean the reversal never ran; zero would mean neither
      // ran and the debt's `paid` is unexplained.
      const creditPayments = await ctx.db.debtPayment.findMany({
        where: { debtId: debtAfter!.id, source: 'CREDIT' },
      });
      expect(creditPayments).toHaveLength(1);
    });

    // Fix 1 (CRITICAL): DEBT invoice total 100, 40 covered by credit at
    // creation (debt paid=40/remaining=60). Customer then pays the remaining
    // 60 in cash (debt paid=100/remaining=0/isPaid=true). Admin PATCHes the
    // items down to a total of 60. The reversal walks the debt back to
    // (paid=60/remaining=40), which is what step c's `updatedInvoice.debt`
    // captures — but step d immediately rewrites the debt to
    // (paid=60/remaining=0/isPaid=true), since the 60 cash exactly covers
    // the new total, and re-application has nothing left to apply
    // (`applied` stays 0). The old `applied.gt(0)` gate would return the
    // stale step-c snapshot — a debt with remaining=40 that the database
    // just closed at 0 — telling the till the customer still owes 40 they
    // do not owe.
    it('reports the settled debt correctly when a PATCH rewrites it but re-applies no credit', async () => {
      const customerId = await customerWithCredit(40);
      const invoiceId = await debtInvoice(customerId, 10); // total = 100, credit covers 40
      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });

      const cashPay = await request(ctx.server)
        .post(`/api/debts/${debt!.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 60 });
      expect(cashPay.status).toBe(201);

      const res = await request(ctx.server)
        .patch(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ items: [{ productId, quantity: 6 }] }); // total -> 60
      expect(res.status).toBe(200);

      const dbDebt = await ctx.db.debt.findFirst({ where: { invoiceId } });
      const dbInvoice = await ctx.db.invoice.findUnique({ where: { id: invoiceId } });

      // The database's own view: fully settled at zero.
      expect(new Prisma.Decimal(dbDebt!.remaining).equals(0)).toBe(true);
      expect(dbDebt!.isPaid).toBe(true);

      // The response the till receives must agree with it, not with the
      // pre-step-d snapshot.
      expect(
        new Prisma.Decimal(res.body.debt.amount).equals(
          new Prisma.Decimal(dbDebt!.amount),
        ),
      ).toBe(true);
      expect(
        new Prisma.Decimal(res.body.debt.remaining).equals(
          new Prisma.Decimal(dbDebt!.remaining),
        ),
      ).toBe(true);
      expect(res.body.debt.isPaid).toBe(dbDebt!.isPaid);
      expect(
        new Prisma.Decimal(res.body.paid).equals(new Prisma.Decimal(dbInvoice!.paid)),
      ).toBe(true);
      expect(
        new Prisma.Decimal(res.body.remaining).equals(
          new Prisma.Decimal(dbInvoice!.remaining),
        ),
      ).toBe(true);
    });

    it('still refuses to shrink an invoice below what was paid in cash', async () => {
      const customerId = await customerWithCredit(0);
      const invoiceId = await debtInvoice(customerId, 10);
      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });
      await request(ctx.server)
        .post(`/api/debts/${debt!.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 80 });

      const res = await request(ctx.server)
        .patch(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ items: [{ productId, quantity: 5 }] });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('أقل مما تم دفعه');
    });

    it('moves credit to the right customer when the invoice is reassigned', async () => {
      const customerA = await customerWithCredit(100);
      const customerB = await customerWithCredit(100);
      const invoiceId = await debtInvoice(customerA, 10);

      const res = await request(ctx.server)
        .patch(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ paymentMethod: 'DEBT', customerId: customerB });

      expect(res.status).toBe(200);

      // Reassignment reverses customerA's credit and re-applies customerB's,
      // both inside the transaction — the response must show the debt fully
      // settled from B's credit, not the pre-reapplication snapshot.
      expect(new Prisma.Decimal(res.body.paid).equals(100)).toBe(true);
      expect(new Prisma.Decimal(res.body.remaining).equals(0)).toBe(true);

      const a = await ctx.db.customer.findUnique({ where: { id: customerA } });
      const b = await ctx.db.customer.findUnique({ where: { id: customerB } });
      expect(new Prisma.Decimal(a!.creditBalance).equals(100)).toBe(true);
      expect(new Prisma.Decimal(b!.creditBalance).equals(0)).toBe(true);
    });

    it('returns credit when a CREDIT-funded payment is deleted', async () => {
      const customerId = await customerWithCredit(50);
      const invoiceId = await debtInvoice(customerId, 10);
      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });
      const payment = await ctx.db.debtPayment.findFirst({
        where: { debtId: debt!.id, source: 'CREDIT' },
      });

      const res = await request(ctx.server)
        .delete(`/api/debts/${debt!.id}/payments/${payment!.id}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(res.status).toBe(204);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(50)).toBe(true);
    });

    it('withdraws an unspent surplus when its cash payment is deleted', async () => {
      const customerId = await customerWithCredit(0);
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId,
          storeId: ctx.storeId,
        },
      });
      const pay = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });
      expect(pay.body.summary.creditBalance).toBe('50');

      const debtId = pay.body.affectedDebts[0].debtId;
      const payment = await ctx.db.debtPayment.findFirst({
        where: { debtId, source: 'CASH' },
      });

      const res = await request(ctx.server)
        .delete(`/api/debts/${debtId}/payments/${payment!.id}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(res.status).toBe(204);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(0)).toBe(true);
    });

    it('refuses to delete a cash payment whose surplus was already spent', async () => {
      const customerId = await customerWithCredit(0);
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId,
          storeId: ctx.storeId,
        },
      });
      const pay = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });
      const debtId = pay.body.affectedDebts[0].debtId;

      // Spend the surplus on a new invoice.
      await debtInvoice(customerId, 10);

      const payment = await ctx.db.debtPayment.findFirst({
        where: { debtId, source: 'CASH' },
      });
      const res = await request(ctx.server)
        .delete(`/api/debts/${debtId}/payments/${payment!.id}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('تم استخدامه');
    });

    // Fix 2 (money-losing): op1 grants +50 credit, which then gets spent to
    // 0 by an unrelated invoice, and only THEN does a second operation (op2)
    // grant +60. The old `balance.lt(surplus)` guard checks the CURRENT
    // balance (60) against op1's surplus (50) and — since 60 is NOT less
    // than 50 — wrongly concludes op1's 50 is still sitting there untouched
    // and withdraws it from what is actually op2's money.
    it('refuses to claw back a surplus already consumed, even when a later surplus masks the balance', async () => {
      const customerId = await customerWithCredit(0);

      // op1: debt1 = 100, pay 150 -> CASH 100 covers debt1, OVERPAYMENT +50.
      const debt1 = await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId,
          storeId: ctx.storeId,
        },
      });
      const pay1 = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });
      expect(pay1.status).toBe(201);
      expect(pay1.body.summary.creditBalance).toBe('50');
      const op1CashPayment = await ctx.db.debtPayment.findFirst({
        where: { debtId: debt1.id, source: 'CASH' },
      });

      // The 50 gets fully spent by a new DEBT invoice — balance back to 0.
      await debtInvoice(customerId, 5); // total = 50, fully credit-covered
      const afterSpend = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(afterSpend!.creditBalance).equals(0)).toBe(true);

      // op2: debt2 = 40, pay 100 -> CASH 40 covers debt2, OVERPAYMENT +60.
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(40),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(40),
          customerId,
          storeId: ctx.storeId,
        },
      });
      const pay2 = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 100 });
      expect(pay2.status).toBe(201);
      expect(pay2.body.summary.creditBalance).toBe('60');

      // Deleting op1's CASH payment must be refused — op1's surplus was
      // already spent, and there is no way to prove the live 60 is op2's
      // money rather than a phantom reappearance of op1's.
      const res = await request(ctx.server)
        .delete(`/api/debts/${debt1.id}/payments/${op1CashPayment!.id}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('تم استخدامه');

      // op2's 60 must still be intact.
      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(60)).toBe(true);
    });

    it('withdraws a shared surplus exactly once across sibling payments', async () => {
      const customerId = await customerWithCredit(0);
      for (const amt of [60, 40]) {
        await ctx.db.debt.create({
          data: {
            amount: new Prisma.Decimal(amt),
            paid: new Prisma.Decimal(0),
            remaining: new Prisma.Decimal(amt),
            customerId,
            storeId: ctx.storeId,
          },
        });
      }
      const pay = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });
      expect(pay.body.summary.creditBalance).toBe('50');
      expect(pay.body.affectedDebts).toHaveLength(2);

      for (const row of pay.body.affectedDebts) {
        const payment = await ctx.db.debtPayment.findFirst({
          where: { debtId: row.debtId, source: 'CASH' },
        });
        const res = await request(ctx.server)
          .delete(`/api/debts/${row.debtId}/payments/${payment!.id}`)
          .set('Authorization', `Bearer ${ctx.token}`);
        expect(res.status).toBe(204);
      }

      // 50 withdrawn once, not twice — a second withdrawal would be caught by
      // the app's own `balance.lt(surplus)` guard and rejected as a 400
      // before it ever reaches the database's non-negative CHECK.
      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(0)).toBe(true);
    });

    it('refuses to archive a customer who holds credit', async () => {
      const customerId = await customerWithCredit(25);

      const res = await request(ctx.server)
        .delete(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('رصيد');
    });

    it('allows deleting a historical invoice after its settled customer is archived', async () => {
      const customerId = await customerWithCredit(0);
      const invoiceId = await debtInvoice(customerId, 10); // total = 100
      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });

      const pay = await request(ctx.server)
        .post(`/api/debts/${debt!.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 100 });
      expect(pay.status).toBe(201);

      // Debts are settled and credit is zero — archiving must succeed.
      const archive = await request(ctx.server)
        .delete(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(archive.status).toBe(204);

      // Deleting the archived customer's historical invoice used to work and
      // must keep working — lockCustomerForCredit must not 404 here just
      // because the customer is now archived.
      const del = await request(ctx.server)
        .delete(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(del.status).toBe(204);
    });

    // Fix 3 (Important): a debt fully settled by CREDIT (not cash) drives
    // the customer's balance to 0, at which point CustomerService.remove
    // lets them be archived — specifically because they hold no credit the
    // shop still owes. Reversing that CREDIT payment hands the money back,
    // which reopens exactly the situation the archive guard exists to
    // prevent: a customer the shop owes money to, invisible to /customers
    // and /sync/init. grantCredit must un-archive them in the same
    // transaction that grants the credit back.
    it('un-archives a customer when a reversal grants their credit back', async () => {
      const customerId = await customerWithCredit(100);
      const invoiceId = await debtInvoice(customerId, 10); // total = 100, fully credit-covered

      const archive = await request(ctx.server)
        .delete(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(archive.status).toBe(204);

      // Archived — invisible to the regular customer endpoint.
      const hidden = await request(ctx.server)
        .get(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(hidden.status).toBe(404);

      // Deleting the invoice reverses the CREDIT payment that funded it and
      // hands the 100 back — the shop owes this customer money again.
      const del = await request(ctx.server)
        .delete(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(del.status).toBe(204);

      const dbCustomer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(dbCustomer!.isDeleted).toBe(false);
      expect(dbCustomer!.deletedAt).toBeNull();
      expect(new Prisma.Decimal(dbCustomer!.creditBalance).equals(100)).toBe(true);

      // Visible again through the regular (isDeleted: false) endpoint.
      const visible = await request(ctx.server)
        .get(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(visible.status).toBe(200);
    });

    it('allows converting a credit-covered DEBT invoice to CASH', async () => {
      const customerId = await customerWithCredit(100);
      const invoiceId = await debtInvoice(customerId, 10); // total = 100, fully credit-covered

      const res = await request(ctx.server)
        .patch(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ paymentMethod: 'CASH' });

      expect(res.status).toBe(200);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(100)).toBe(true);

      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });
      expect(debt).toBeNull();
    });

    it('reverses a pre-migration-style payment with no operation unchanged', async () => {
      const customerId = await customerWithCredit(0);
      const invoiceId = await debtInvoice(customerId, 10);
      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });
      // operationId NULL is what every payment written before this feature —
      // and every payment sync/push creates — looks like.
      const payment = await ctx.db.debtPayment.create({
        data: { amount: new Prisma.Decimal(30), debtId: debt!.id },
      });
      await ctx.db.debt.update({
        where: { id: debt!.id },
        data: { paid: { increment: 30 }, remaining: { decrement: 30 } },
      });
      await ctx.db.invoice.update({
        where: { id: invoiceId },
        data: { paid: { increment: 30 }, remaining: { decrement: 30 } },
      });

      const res = await request(ctx.server)
        .delete(`/api/debts/${debt!.id}/payments/${payment.id}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(res.status).toBe(204);

      const after = await ctx.db.debt.findUnique({ where: { id: debt!.id } });
      expect(new Prisma.Decimal(after!.remaining).equals(100)).toBe(true);
      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(0)).toBe(true);
    });

    it('does not deadlock when PATCH /invoices races a customer payment', async () => {
      const customerId = await customerWithCredit(0);
      const invoiceId = await debtInvoice(customerId, 10);

      const results = await Promise.allSettled([
        request(ctx.server)
          .patch(`/api/invoices/${invoiceId}`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ items: [{ productId, quantity: 12 }] }),
        request(ctx.server)
          .post(`/api/debts/customer/${customerId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 20 }),
      ]);

      const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
      // A lock cycle surfaces as PostgreSQL 40P01, which PrismaExceptionFilter
      // does not map — it would arrive as a 500.
      expect(statuses).not.toContain(500);
    }, 30_000);

    it('does not deadlock when DELETE /invoices races a customer payment', async () => {
      const customerId = await customerWithCredit(0);
      const invoiceId = await debtInvoice(customerId, 10);

      const results = await Promise.allSettled([
        request(ctx.server)
          .delete(`/api/invoices/${invoiceId}`)
          .set('Authorization', `Bearer ${ctx.token}`),
        request(ctx.server)
          .post(`/api/debts/customer/${customerId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 20 }),
      ]);

      const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
      expect(statuses).not.toContain(500);
    }, 30_000);

    // Fix 4: pay() (single-debt) used to lock Debt → Invoice with no
    // customer lock at all, while InvoiceService.update locks
    // Customer → Invoice → Debt — an inverted order that can cycle into an
    // unmapped 40P01 and surface as a 500 at the till.
    it('does not deadlock when PATCH /invoices races a single-debt payment', async () => {
      const customerId = await customerWithCredit(0);
      const invoiceId = await debtInvoice(customerId, 10);
      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });

      const results = await Promise.allSettled([
        request(ctx.server)
          .patch(`/api/invoices/${invoiceId}`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ items: [{ productId, quantity: 12 }] }),
        request(ctx.server)
          .post(`/api/debts/${debt!.id}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 20 }),
      ]);

      const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
      expect(statuses).not.toContain(500);
    }, 30_000);

    // This sweeps EVERY customer created anywhere in this describe block, so
    // it's only meaningful as the LAST test here — a test added below this
    // one that leaves the ledger inconsistent would go unchecked, and
    // nothing in the file enforces the ordering (`it.each`/test order is
    // declaration order, not a guarantee some later edit preserves).
    it('keeps the ledger reconciled after every reversal', async () => {
      const customers = await ctx.db.customer.findMany({
        where: { storeId: ctx.storeId },
        select: { id: true, creditBalance: true },
      });
      for (const c of customers) {
        const entries = await ctx.db.creditEntry.findMany({
          where: { customerId: c.id },
          select: { delta: true },
        });
        const sum = entries.reduce(
          (acc, e) => acc.plus(new Prisma.Decimal(e.delta)),
          new Prisma.Decimal(0),
        );
        expect(sum.equals(new Prisma.Decimal(c.creditBalance))).toBe(true);
      }
    });
  });

  // ─── Task 6 — read surfaces ───────────────────────────────────────────────
  describe('Credit on read endpoints', () => {
    let ctx: Ctx;
    let owingId: string;
    let creditedId: string;

    beforeAll(async () => {
      ctx = await bootstrap();

      const owing = await ctx.db.customer.create({
        data: { name: 'Owing', storeId: ctx.storeId },
      });
      owingId = owing.id;
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId: owingId,
          storeId: ctx.storeId,
        },
      });

      const credited = await ctx.db.customer.create({
        data: {
          name: 'Credited',
          storeId: ctx.storeId,
          creditBalance: new Prisma.Decimal(50),
        },
      });
      creditedId = credited.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const get = (path: string) =>
      request(ctx.server).get(path).set('Authorization', `Bearer ${ctx.token}`);

    it('returns a negative balance for a customer who owes', async () => {
      const res = await get(`/api/debts/customer/${owingId}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.creditBalance).toBe('0');
      expect(res.body.summary.balance).toBe('-100');
    });

    it('returns a positive balance for a customer holding credit', async () => {
      const res = await get(`/api/debts/customer/${creditedId}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.creditBalance).toBe('50');
      expect(res.body.summary.balance).toBe('50');
    });

    it('includes credit in the narrow debt-summary endpoint', async () => {
      const res = await get(`/api/customers/${creditedId}/debt-summary`);
      expect(res.status).toBe(200);
      expect(res.body.summary.creditBalance).toBe('50');
      expect(res.body.summary.balance).toBe('50');
    });

    it('includes credit and balance on the customer list', async () => {
      const res = await get('/api/customers?limit=50');
      expect(res.status).toBe(200);
      const owing = res.body.data.find((c: { id: string }) => c.id === owingId);
      const credited = res.body.data.find(
        (c: { id: string }) => c.id === creditedId,
      );
      expect(owing.balance).toBe('-100');
      expect(credited.creditBalance).toBe('50');
      expect(credited.balance).toBe('50');
    });

    it('includes credit and balance on customer detail', async () => {
      const res = await get(`/api/customers/${creditedId}`);
      expect(res.status).toBe(200);
      expect(res.body.creditBalance).toBe('50');
      expect(res.body.balance).toBe('50');
    });

    it('reports store-wide credit and net remaining', async () => {
      const res = await get('/api/debts/summary');
      expect(res.status).toBe(200);
      expect(res.body.totalRemaining).toBe('100'); // unchanged
      expect(res.body.totalCredit).toBe('50');
      // Per customer: Owing max(0, 100−0)=100, Credited max(0, 0−50)=0.
      expect(res.body.netRemaining).toBe('100');
    });

    it('keeps every money field in the same string format', async () => {
      const res = await get(`/api/debts/customer/${creditedId}`);
      for (const key of [
        'totalAmount',
        'totalPaid',
        'totalRemaining',
        'creditBalance',
        'balance',
      ]) {
        expect(typeof res.body.summary[key]).toBe('string');
        // Decimal.toString() never pads — "50", never "50.00".
        expect(res.body.summary[key]).not.toMatch(/\.\d0$/);
      }
    });
  });

  // ─── Task 7 — reports ─────────────────────────────────────────────────────
  describe('Credit in reports', () => {
    let ctx: Ctx;
    let productId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'Widget',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(4),
          stock: 1000,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const get = (path: string) =>
      request(ctx.server).get(path).set('Authorization', `Bearer ${ctx.token}`);

    // Shared by the two APPLIED_TO_DEBT tests below: a customer overpaid by
    // 30 (credit=30), then a DEBT invoice for the given quantity of the
    // fixture product (price 10) so the total is fully or partially credit
    // funded.
    const customerWithCreditAndDebtInvoice = async (quantity: number) => {
      const customer = await ctx.db.customer.create({
        data: {
          name: `Redeemer-${randomUUID().slice(0, 6)}`,
          storeId: ctx.storeId,
        },
      });
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId: customer.id,
          storeId: ctx.storeId,
        },
      });
      await request(ctx.server)
        .post(`/api/debts/customer/${customer.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 130 }); // credit = 30

      const invoiceRes = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId: customer.id,
          items: [{ productId, quantity }],
        });
      expect(invoiceRes.status).toBe(201);
      return {
        customerId: customer.id,
        invoiceId: invoiceRes.body.id as string,
      };
    };

    it('reports an overpayment surplus as credit received, not revenue', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Overpayer', storeId: ctx.storeId },
      });
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId: customer.id,
          storeId: ctx.storeId,
        },
      });
      await request(ctx.server)
        .post(`/api/debts/customer/${customer.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });

      const res = await get('/api/invoices/daily-sales');
      expect(res.status).toBe(200);
      expect(res.body.summary.totalCreditReceived).toBe('50');
      expect(res.body.summary.totalCreditApplied).toBe('0');
    });

    it('nets a same-day withdrawal back out of credit received', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Reversed', storeId: ctx.storeId },
      });
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId: customer.id,
          storeId: ctx.storeId,
        },
      });
      const pay = await request(ctx.server)
        .post(`/api/debts/customer/${customer.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 130 });

      const before = await get('/api/invoices/daily-sales');
      const received = new Prisma.Decimal(
        before.body.summary.totalCreditReceived,
      );

      const debtId = pay.body.affectedDebts[0].debtId;
      const payment = await ctx.db.debtPayment.findFirst({
        where: { debtId, source: 'CASH' },
      });
      await request(ctx.server)
        .delete(`/api/debts/${debtId}/payments/${payment!.id}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      const after = await get('/api/invoices/daily-sales');
      expect(
        new Prisma.Decimal(after.body.summary.totalCreditReceived).equals(
          received.minus(30),
        ),
      ).toBe(true);
    });

    // Placed before the "positive applied amount" test below so its own
    // baseline read is a clean '0' — nothing before this point in the block
    // touches APPLIED_TO_DEBT/APPLIED_REVERSED.
    it('nets a same-day invoice deletion back out of credit applied', async () => {
      const before = await get('/api/invoices/daily-sales');
      expect(before.body.summary.totalCreditApplied).toBe('0');

      const { invoiceId } = await customerWithCreditAndDebtInvoice(2); // total 20, applied 20

      const mid = await get('/api/invoices/daily-sales');
      expect(mid.body.summary.totalCreditApplied).toBe('20');

      const del = await request(ctx.server)
        .delete(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(del.status).toBe(204);

      // The APPLIED_TO_DEBT entry and its APPLIED_REVERSED counterpart
      // cancel — the aggregate returns to exactly where it started.
      const after = await get('/api/invoices/daily-sales');
      expect(after.body.summary.totalCreditApplied).toBe('0');
    });

    it('reports a credit-covered debt payment as applied credit, not new revenue', async () => {
      const before = await get('/api/invoices/daily-sales');
      expect(before.body.summary.totalCreditApplied).toBe('0');

      await customerWithCreditAndDebtInvoice(2); // total 20 — fully covered by the 30 credit

      const res = await get('/api/invoices/daily-sales');
      expect(res.status).toBe(200);
      // Exact string, not just a truthy/nonzero check — a sign flip in the
      // aggregation (`.plus` instead of `.minus`) would put '-20' on the
      // wire here instead of the positive amount actually applied.
      expect(res.body.summary.totalCreditApplied).toBe('20');
    });

    // The real invariant credit redemption must preserve: recognising a debt
    // invoice's revenue must not depend on whether it happened to be paid
    // from stored credit. Compare the profit DELTA two otherwise-identical
    // invoices contribute rather than asserting an absolute snapshot, so
    // unrelated invoices from earlier tests in this block (and the day
    // overall) don't matter. If credit redemption were ever modelled as an
    // invoice discount (writing off revenue equal to the applied amount),
    // A's delta would come in lower than B's and this test would catch it —
    // "leaves daily profit untouched" alone (the old version of this test)
    // could not, because its fixture never attached an invoice to the debt.
    it('credits a debt invoice with the same profit whether or not it drew on stored credit', async () => {
      const customerA = await ctx.db.customer.create({
        data: { name: 'CreditFunded', storeId: ctx.storeId },
      });
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId: customerA.id,
          storeId: ctx.storeId,
        },
      });
      await request(ctx.server)
        .post(`/api/debts/customer/${customerA.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 120 }); // credit = 20 — exactly the invoice total below

      const customerB = await ctx.db.customer.create({
        data: { name: 'CashFunded', storeId: ctx.storeId },
      });

      const beforeA = await get('/api/reports/daily-profit');
      const invoiceA = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId: customerA.id,
          items: [{ productId, quantity: 2 }], // total 20, fully credit-funded
        });
      expect(invoiceA.status).toBe(201);
      expect(new Prisma.Decimal(invoiceA.body.paid).equals(20)).toBe(true);
      const afterA = await get('/api/reports/daily-profit');

      const beforeB = await get('/api/reports/daily-profit');
      const invoiceB = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId: customerB.id,
          items: [{ productId, quantity: 2 }], // same product, same quantity — no credit
        });
      expect(invoiceB.status).toBe(201);
      expect(new Prisma.Decimal(invoiceB.body.paid).equals(0)).toBe(true);
      const afterB = await get('/api/reports/daily-profit');

      const deltaA = afterA.body.netProfit - beforeA.body.netProfit;
      const deltaB = afterB.body.netProfit - beforeB.body.netProfit;

      // A real sale must move profit — an equality check alone would also
      // pass if both deltas were wrongly zeroed out.
      expect(deltaA).not.toBe(0);
      expect(deltaA).toBeCloseTo(deltaB, 2);
    });
  });

  // ─── Regression: DebtService.pay must write a RELATIVE invoice remaining ──
  //
  // `pay()` used to write `remaining: newRemaining` — the DEBT's new
  // remaining — as an absolute value onto the invoice too. That is only
  // correct while invoice.remaining === debt.remaining, an invariant
  // sync/push breaks on purpose: an offline debt payment (Step 3 of
  // SyncService.push) updates only the debt row and never mirrors onto its
  // invoice. The first online payment against such a debt then desyncs
  // paid+remaining=total on the invoice and trips invoice_balance_consistent
  // (23514) — unmapped by PrismaExceptionFilter, so the cashier gets a 500,
  // permanently, on every retry of that route.
  describe('DebtService.pay against an invoice a sync push never touched', () => {
    let ctx: Ctx;
    let productId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'Widget',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(4),
          stock: 1000,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('keeps paid + remaining = total after paying off the rest of a debt whose earlier offline payment never touched the invoice', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Drifted', storeId: ctx.storeId },
      });

      const invoiceRes = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId: customer.id,
          items: [{ productId, quantity: 10 }], // total = 100
        });
      expect(invoiceRes.status).toBe(201);
      const invoiceId = invoiceRes.body.id as string;
      const debt = await ctx.db.debt.findFirstOrThrow({ where: { invoiceId } });

      // Simulate the offline shape sync/push produces: write a DebtPayment
      // and move only the DEBT's paid/remaining — the invoice is left
      // exactly as create() wrote it (paid=0, remaining=100), because
      // SyncService.push's debt-payments step (Step 3) never touches the
      // sibling invoice.
      await ctx.db.debtPayment.create({
        data: { amount: new Prisma.Decimal(30), debtId: debt.id },
      });
      await ctx.db.debt.update({
        where: { id: debt.id },
        data: {
          paid: new Prisma.Decimal(30),
          remaining: new Prisma.Decimal(70),
        },
      });

      // The CASHIER now pays off the remainder through the online route.
      const pay = await request(ctx.server)
        .post(`/api/debts/${debt.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 70 });

      expect(pay.status).not.toBe(500);
      expect(pay.status).toBe(201);

      const invoice = await ctx.db.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
      const paid = new Prisma.Decimal(invoice.paid);
      const remaining = new Prisma.Decimal(invoice.remaining);
      const total = new Prisma.Decimal(invoice.total);
      // The exact paid/remaining split is NOT asserted here on purpose: the
      // offline 30 never touched the invoice (that's the drift this test
      // simulates), so invoice.paid only ever sees the 70 paid through this
      // route — reconstructing the true split is the pre-existing, wider
      // "recompute from a stale snapshot" gap that is explicitly out of
      // scope. What THIS fix guarantees is the invariant the database
      // enforces: the pair stays internally consistent instead of tripping
      // invoice_balance_consistent (23514).
      expect(paid.plus(remaining).equals(total)).toBe(true);
    });
  });

  // ─── Debt principal must survive an edit ──────────────────────────────────
  //
  // `invoices.paid` is mirrored upward by every repayment against the linked
  // debt, so deriving the debt principal as (total − invoices.paid) counts
  // each repayment twice: once as already-paid on the invoice, once as a
  // smaller principal. A notes-only PATCH then silently forgives exactly what
  // the customer had already handed over.
  //
  // No credit is involved in either test on purpose — this defect predates the
  // credit feature and hits every PARTIAL invoice in the shop.
  describe('Editing an invoice must not shrink the debt principal', () => {
    let ctx: Ctx;
    let productId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'Principal Widget',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(4),
          stock: 1000,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const sellPartial = async (customerId: string) => {
      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'PARTIAL',
          customerId,
          paid: 30,
          items: [{ productId, quantity: 10 }],
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const repay = async (customerId: string, amount: number) => {
      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount });
      expect(res.status).toBe(201);
    };

    it('leaves the debt untouched when a notes-only PATCH follows a cash repayment', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Principal', storeId: ctx.storeId },
      });
      const invoiceId = await sellPartial(customer.id);
      await repay(customer.id, 10);

      const before = await ctx.db.debt.findFirstOrThrow({
        where: { invoiceId },
      });
      expect(new Prisma.Decimal(before.amount).equals(70)).toBe(true);
      expect(new Prisma.Decimal(before.paid).equals(10)).toBe(true);
      expect(new Prisma.Decimal(before.remaining).equals(60)).toBe(true);

      const patched = await request(ctx.server)
        .patch(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ notes: 'typo fix' });
      expect(patched.status).toBe(200);

      const after = await ctx.db.debt.findFirstOrThrow({ where: { invoiceId } });
      expect(new Prisma.Decimal(after.amount).equals(70)).toBe(true);
      expect(new Prisma.Decimal(after.paid).equals(10)).toBe(true);
      expect(new Prisma.Decimal(after.remaining).equals(60)).toBe(true);

      // The invoice and the debt must still agree about what is outstanding.
      const inv = await ctx.db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(new Prisma.Decimal(inv.remaining).equals(after.remaining)).toBe(true);
    });

    // Same root cause: the gte(total) guard was fed invoices.paid, which
    // reaches total once the debt is settled, so a settled PARTIAL invoice
    // rejected every edit — blaming a `paid` field the request never sent.
    it('still allows editing a PARTIAL invoice whose debt is fully repaid', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Settled', storeId: ctx.storeId },
      });
      const invoiceId = await sellPartial(customer.id);
      await repay(customer.id, 70);

      const patched = await request(ctx.server)
        .patch(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ notes: 'typo fix' });
      expect(patched.status).toBe(200);

      const debt = await ctx.db.debt.findFirstOrThrow({ where: { invoiceId } });
      expect(new Prisma.Decimal(debt.amount).equals(70)).toBe(true);
      expect(new Prisma.Decimal(debt.remaining).equals(0)).toBe(true);
      expect(debt.isPaid).toBe(true);
    });
  });

  // ─── Fix 1a — the CASH-payment delete guard must not recommend settling ──
  //
  // Settling the debt (isPaid: true) makes the guard's own `!isPaid` half
  // pass, so the old message ("settle the debt first") told the cashier
  // exactly how to defeat the protection and cascade away the very CASH
  // payments it exists to protect.
  describe('Invoice delete guard on unpaid CASH-funded debts', () => {
    let ctx: Ctx;
    let productId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'Guarded Widget',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(4),
          stock: 1000,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('refuses to delete and does not recommend settling the debt', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'CashPayer', storeId: ctx.storeId },
      });
      const invoice = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({
          paymentMethod: 'DEBT',
          customerId: customer.id,
          items: [{ productId, quantity: 10 }], // total 100
        });
      expect(invoice.status).toBe(201);
      const debt = await ctx.db.debt.findFirstOrThrow({
        where: { invoiceId: invoice.body.id },
      });

      // Partial CASH payment — debt stays unpaid, which is exactly the
      // guard's trigger condition (!isPaid && has a CASH payment).
      const pay = await request(ctx.server)
        .post(`/api/debts/${debt.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 40 });
      expect(pay.status).toBe(201);

      const del = await request(ctx.server)
        .delete(`/api/invoices/${invoice.body.id}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(del.status).toBe(400);
      // The old message told the cashier to settle the debt first — doing so
      // flips isPaid to true, which passes this very guard and then cascades
      // away the debt's CASH payments along with the invoice.
      expect(del.body.message).not.toContain('تسوية');
      expect(del.body.message).toBe(
        'لا يمكن حذف فاتورة مرتبطة بدين عليه دفعات مسجّلة. الرجاء تصحيح الفاتورة بدلاً من حذفها.',
      );

      // The CASH payment must genuinely still be there — proof the block worked.
      const survivingPayment = await ctx.db.debtPayment.findFirst({
        where: { debtId: debt.id, source: 'CASH' },
      });
      expect(survivingPayment).not.toBeNull();
    });
  });

  // ─── Fix 1b + Fix 2 — an audited escape hatch for credit with no remedy ───
  //
  // Two reachable states leave a customer holding credit with NO debt and
  // NO debt_payments row to delete: (i) paying a customer who owes nothing,
  // and (ii) voiding an invoice that cascades the debt away. In both, the
  // old message's second remedy ("delete the payment that created it") has
  // no route — GET /debts/customer/:id returns debts: [] and there is
  // nothing to delete. forfeitCredit=true is the only way out.
  describe('Archiving a customer stuck holding credit', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await bootstrap();
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    // Reproduces the genuinely stuck state: overpay a customer who owes
    // nothing. No debt is ever created, so no debt_payments row exists —
    // there is nothing the old message's second remedy could point at.
    const makeStuckCustomer = async (credit: number) => {
      const customer = await ctx.db.customer.create({
        data: {
          name: `Stuck-${randomUUID().slice(0, 6)}`,
          storeId: ctx.storeId,
        },
      });
      const pay = await request(ctx.server)
        .post(`/api/debts/customer/${customer.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: credit });
      expect(pay.status).toBe(201);
      expect(pay.body.affectedDebts).toEqual([]);
      return customer.id;
    };

    it('confirms the stuck state: no debts and no debt_payments row to delete', async () => {
      const customerId = await makeStuckCustomer(75);

      const debts = await request(ctx.server)
        .get(`/api/debts/customer/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(debts.status).toBe(200);
      expect(debts.body.debts).toEqual([]);

      const payments = await ctx.db.debtPayment.findMany({
        where: { debt: { customerId } },
      });
      expect(payments).toHaveLength(0);
    });

    it('refuses to archive without forfeitCredit, with a message naming only real remedies', async () => {
      const customerId = await makeStuckCustomer(30);

      const res = await request(ctx.server)
        .delete(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('رصيد');
      // Must not repeat the remedy that has no route in this scenario.
      expect(res.body.message).not.toContain('احذف الدفعة');
      // Must mention the forfeit escape hatch this fix adds.
      expect(res.body.message).toContain('forfeitCredit');

      const customer = await ctx.db.customer.findUnique({
        where: { id: customerId },
      });
      expect(customer!.isDeleted).toBe(false);
    });

    it('rejects forfeitCredit from a non-admin role', async () => {
      const customerId = await makeStuckCustomer(30);
      const cashierToken = await ctx.app
        .get(JwtService)
        .signAsync(
          { sub: randomUUID(), storeId: ctx.storeId, role: 'CASHIER' },
          { secret: env.JWT_SECRET, expiresIn: '10m' },
        );

      const res = await request(ctx.server)
        .delete(`/api/customers/${customerId}?forfeitCredit=true`)
        .set('Authorization', `Bearer ${cashierToken}`);

      expect(res.status).toBe(403);

      const customer = await ctx.db.customer.findUnique({
        where: { id: customerId },
      });
      expect(customer!.isDeleted).toBe(false);
      expect(new Prisma.Decimal(customer!.creditBalance).equals(30)).toBe(true);
    });

    it('archives and forfeits the credit with forfeitCredit=true, leaving an audited ledger row', async () => {
      const customerId = await makeStuckCustomer(45);

      const res = await request(ctx.server)
        .delete(`/api/customers/${customerId}?forfeitCredit=true`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(204);

      const customer = await ctx.db.customer.findUniqueOrThrow({
        where: { id: customerId },
      });
      expect(customer.isDeleted).toBe(true);
      expect(new Prisma.Decimal(customer.creditBalance).equals(0)).toBe(true);

      const entries = await ctx.db.creditEntry.findMany({
        where: { customerId },
      });
      const forfeit = entries.find((e) => e.reason === 'OVERPAYMENT_REVERSED');
      expect(forfeit).toBeTruthy();
      expect(new Prisma.Decimal(forfeit!.delta).equals(-45)).toBe(true);
      // Must read distinctly from an ordinary surplus withdrawal in the ledger.
      expect(forfeit!.notes).toContain('أرشفة');

      // The ledger must still reconcile with the denormalized column.
      const sum = entries.reduce(
        (acc, e) => acc.plus(new Prisma.Decimal(e.delta)),
        new Prisma.Decimal(0),
      );
      expect(sum.equals(new Prisma.Decimal(customer.creditBalance))).toBe(true);
      expect(sum.equals(0)).toBe(true);
    });

    it('removes the customer from the customer list once archived', async () => {
      const customerId = await makeStuckCustomer(20);
      const before = await ctx.db.customer.findUniqueOrThrow({
        where: { id: customerId },
      });

      const del = await request(ctx.server)
        .delete(`/api/customers/${customerId}?forfeitCredit=true`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(del.status).toBe(204);

      const list = await request(ctx.server)
        .get('/api/customers')
        .query({ search: before.name })
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(list.status).toBe(200);
      expect(
        (list.body.data as { id: string }[]).some((c) => c.id === customerId),
      ).toBe(false);
    });

    it('defaults forfeitCredit to false — omitting it behaves exactly as before', async () => {
      const customerId = await makeStuckCustomer(15);

      const res = await request(ctx.server)
        .delete(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(400);
      const customer = await ctx.db.customer.findUniqueOrThrow({
        where: { id: customerId },
      });
      expect(customer.isDeleted).toBe(false);
      expect(new Prisma.Decimal(customer.creditBalance).equals(15)).toBe(true);
    });
  });

  // ─── Fix 1c — the unpaid-debts archive guard must speak Arabic like every ──
  // ─── other user-facing message in this codebase ───────────────────────────
  describe('Archive guard message language (fix 1c)', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await bootstrap();
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('refuses to archive a customer with unpaid debts, in Arabic', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Owing', storeId: ctx.storeId },
      });
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(50),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(50),
          customerId: customer.id,
          storeId: ctx.storeId,
        },
      });

      const res = await request(ctx.server)
        .delete(`/api/customers/${customer.id}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(400);
      expect(res.body.message).not.toMatch(/^[A-Za-z0-9 .,!?'"-]+$/);
      expect(res.body.message).toContain('ديون');
    });
  });

  // ─── Fix 3 — daily-sales must surface cash collected on debt repayments ──
  describe('Daily sales: cash collected on debt repayments', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await bootstrap();
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const get = (path: string) =>
      request(ctx.server).get(path).set('Authorization', `Bearer ${ctx.token}`);

    it('reflects the CASH portion of a debt repayment, leaving pre-existing fields untouched', async () => {
      const customer = await ctx.db.customer.create({
        data: { name: 'Repayer', storeId: ctx.storeId },
      });
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(50),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(50),
          customerId: customer.id,
          storeId: ctx.storeId,
        },
      });

      const before = await get('/api/invoices/daily-sales');
      expect(before.status).toBe(200);
      const beforeCash = before.body.summary.totalCash;
      const beforePaid = before.body.summary.totalPaid;
      const beforeDebtRepay = new Prisma.Decimal(
        before.body.summary.totalCashDebtRepayments ?? 0,
      );

      // 150 tendered against a 50 debt: 50 clears it in CASH, 100 becomes credit.
      const pay = await request(ctx.server)
        .post(`/api/debts/customer/${customer.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });
      expect(pay.status).toBe(201);
      expect(pay.body.excessToCredit).toBe('100');

      const after = await get('/api/invoices/daily-sales');
      expect(after.status).toBe(200);

      const afterDebtRepay = new Prisma.Decimal(
        after.body.summary.totalCashDebtRepayments,
      );
      expect(afterDebtRepay.minus(beforeDebtRepay).equals(50)).toBe(true);
      // Never a formatted "50.00" — Decimal.toString() only.
      expect(after.body.summary.totalCashDebtRepayments).not.toMatch(/\.\d0$/);

      // No invoice was created — the pre-existing invoice-derived fields
      // must be completely unaffected by a debt repayment.
      expect(after.body.summary.totalCash).toBe(beforeCash);
      expect(after.body.summary.totalPaid).toBe(beforePaid);
    });
  });

  // ─── The customer payment record ──────────────────────────────────────────
  //
  // debt_payments only ever records the portion allocated to a debt, so a 150
  // handed across the counter against a 100 debt used to leave no trace of the
  // 150 anywhere readable. The operation row always held it; these tests pin
  // that it is now filled in and exposed.
  describe('Customer payment record', () => {
    let ctx: Ctx;
    let productId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'Payment Record Widget',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(4),
          stock: 1000,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const newCustomer = async (name: string) =>
      (await ctx.db.customer.create({ data: { name, storeId: ctx.storeId } })).id;

    const oweOnDebt = async (customerId: string, qty: number) => {
      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ paymentMethod: 'DEBT', customerId, items: [{ productId, quantity: qty }] });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    // The acceptance case from the request: owes 100, pays 150.
    it('records the full 150 as one payment, split 100 / 50', async () => {
      const customerId = await newCustomer('Full Record');
      await oweOnDebt(customerId, 10); // total 100

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150, notes: 'دفعة كاملة' });

      expect(res.status).toBe(201);
      expect(res.body.payment).toBeDefined();
      expect(res.body.payment.customerId).toBe(customerId);
      expect(res.body.payment.amount).toBe('150');
      expect(res.body.payment.appliedToDebt).toBe('100');
      expect(res.body.payment.addedToCredit).toBe('50');
      expect(res.body.payment.notes).toBe('دفعة كاملة');
      expect(res.body.payment.paidAt).toBeDefined();
      expect(res.body.payment.id).toBeDefined();

      expect(res.body.summary.totalRemaining).toBe('0');
      expect(res.body.summary.creditBalance).toBe('50');
      expect(res.body.summary.balance).toBe('50');
    });

    it('exposes it on the customer as customerPayments, newest first', async () => {
      const customerId = await newCustomer('History');
      await oweOnDebt(customerId, 10); // total 100

      await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 40 });
      await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 110 });

      const res = await request(ctx.server)
        .get(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.customerPayments)).toBe(true);
      expect(res.body.customerPayments).toHaveLength(2);

      // Newest first: the 110 was taken after the 40.
      expect(res.body.customerPayments[0].amount).toBe('110');
      expect(res.body.customerPayments[1].amount).toBe('40');

      // 100 debt: 40 settles part, then 110 settles the remaining 60 and banks 50.
      expect(res.body.customerPayments[0].appliedToDebt).toBe('60');
      expect(res.body.customerPayments[0].addedToCredit).toBe('50');
      expect(res.body.customerPayments[1].appliedToDebt).toBe('40');
      expect(res.body.customerPayments[1].addedToCredit).toBe('0');
    });

    // The whole point of the separation: debts[].payments is the per-debt
    // allocation, NOT the record of cash taken.
    it('keeps debts[].payments as the per-debt allocation', async () => {
      const customerId = await newCustomer('Allocation');
      await oweOnDebt(customerId, 10); // total 100

      await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });

      const res = await request(ctx.server)
        .get(`/api/debts/customer/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      // The debt saw 100, not 150 — the surplus never belonged to it.
      const allocated = res.body.debts[0].payments
        .map((p: { amount: string }) => new Prisma.Decimal(p.amount))
        .reduce((a: Prisma.Decimal, b: Prisma.Decimal) => a.plus(b), new Prisma.Decimal(0));
      expect(allocated.equals(100)).toBe(true);
    });

    // Spending stored credit is not new cash across the counter, so it must
    // NOT produce a payment record.
    it('does not record a payment when stored credit settles a new invoice', async () => {
      const customerId = await newCustomer('Credit Spend');
      await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 80 }); // no debts yet -> all 80 becomes credit

      const before = await request(ctx.server)
        .get(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(before.body.customerPayments).toHaveLength(1);

      // A new debt invoice consumes the credit — no cash changes hands.
      await oweOnDebt(customerId, 5); // total 50, fully covered by credit

      const after = await request(ctx.server)
        .get(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(after.body.customerPayments).toHaveLength(1);
      expect(after.body.customerPayments[0].amount).toBe('80');
    });

    it('reports the split for a row written before the columns existed', async () => {
      // Simulates production rows: the operation exists with its full amount,
      // but the split columns are null because they did not exist when it was
      // written. Reads must derive the truth, never report zeros.
      const customerId = await newCustomer('Legacy Row');
      await oweOnDebt(customerId, 10); // total 100

      const pay = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });
      expect(pay.status).toBe(201);

      await ctx.db.debtPaymentOperation.update({
        where: { id: pay.body.payment.id },
        data: { appliedToDebt: null, addedToCredit: null },
      });

      const res = await request(ctx.server)
        .get(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.body.customerPayments[0].appliedToDebt).toBe('100');
      expect(res.body.customerPayments[0].addedToCredit).toBe('50');
    });

    // The hard half of the legacy case: the split columns are null AND the
    // linked debt_payments are gone, which is what deleting the invoice does
    // (Invoice -> Debt -> DebtPayment all cascade). Deriving from the payment
    // rows would report "0 to debt, 150 to credit" here — a rewritten history.
    // The OVERPAYMENT credit entry survives, so the split stays truthful.
    it('reports the split for a legacy row whose payments were deleted', async () => {
      const customerId = await newCustomer('Legacy Cascaded');
      const invoiceId = await oweOnDebt(customerId, 10); // total 100

      const pay = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 150 });
      expect(pay.status).toBe(201);

      // Make it look pre-migration.
      await ctx.db.debtPaymentOperation.update({
        where: { id: pay.body.payment.id },
        data: { appliedToDebt: null, addedToCredit: null },
      });

      // Deleting the invoice cascades the debt and its payment rows away.
      const del = await request(ctx.server)
        .delete(`/api/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(del.status).toBe(204);

      const survivors = await ctx.db.debtPayment.count({
        where: { operationId: pay.body.payment.id },
      });
      expect(survivors).toBe(0);

      const res = await request(ctx.server)
        .get(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.body.customerPayments[0].amount).toBe('150');
      expect(res.body.customerPayments[0].appliedToDebt).toBe('100');
      expect(res.body.customerPayments[0].addedToCredit).toBe('50');
    });

    it('replaying the same clientOperationId does not add a second record', async () => {
      const customerId = await newCustomer('Replay');
      await oweOnDebt(customerId, 10);
      const key = `rec-${randomUUID()}`;

      for (let i = 0; i < 2; i++) {
        const r = await request(ctx.server)
          .post(`/api/debts/customer/${customerId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 150, clientOperationId: key });
        expect(r.status).toBe(201);
        expect(r.body.payment.amount).toBe('150');
        // A replay must return the same SPLIT, not just the same total.
        expect(r.body.payment.appliedToDebt).toBe('100');
        expect(r.body.payment.addedToCredit).toBe('50');
      }

      const res = await request(ctx.server)
        .get(`/api/customers/${customerId}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(res.body.customerPayments).toHaveLength(1);
    });
  });
});
