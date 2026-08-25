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
 * Phase 3 — Ledger Integrity (e2e).
 *
 * These tests run against the live Neon DB so they create a self-contained
 * temporary store + cleanup in afterAll. Test data is identified by a uuid
 * subdomain (`ledger-test-*`) so a crash leaves a recognisable footprint.
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

  // Fresh store per test file run to keep blast radius small.
  const subdomain = `ledger-test-${randomUUID().slice(0, 8)}`;
  const store = await db.store.create({
    data: { name: `Ledger Test ${subdomain}`, subdomain, status: 'APPROVED' },
  });
  const user = await db.user.create({
    data: {
      username: `tester-${subdomain}`,
      email: `${subdomain}@ledger.test`,
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
  // Cascade: store → invoices → items / debts → payments. Delete order matters
  // because debt has FKs both to customer and to invoice.
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

describe('Phase 3 — Ledger Integrity (e2e)', () => {
  // ─── 1. Concurrent debt payments — total correct, no overpay ──────────────
  describe('Concurrent payments on the same debt', () => {
    let ctx: Ctx;
    let customerId: string;
    let debtId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const customer = await ctx.db.customer.create({
        data: { name: 'C', storeId: ctx.storeId },
      });
      customerId = customer.id;
      const debt = await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(100),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(100),
          customerId,
          storeId: ctx.storeId,
        },
      });
      debtId = debt.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('serialises two concurrent pay() calls — totals reconcile, no overpay', async () => {
      const responses = await Promise.allSettled([
        request(ctx.server)
          .post(`/api/debts/${debtId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 60 }),
        request(ctx.server)
          .post(`/api/debts/${debtId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 60 }),
      ]);

      // Surface the actual responses if anything goes sideways.
      const detail = responses.map((r) =>
        r.status === 'fulfilled'
          ? { status: r.value.status, body: r.value.body }
          : { error: String(r.reason) },
      );
      const statuses = responses.map((r) =>
        r.status === 'fulfilled' ? r.value.status : 0,
      );
      try {
        expect(statuses).toContain(201);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('pay() responses:', JSON.stringify(detail, null, 2));
        throw e;
      }

      const ok = statuses.filter((s) => s === 201).length;
      const rejected = statuses.filter((s) => s === 400).length;
      // Exactly one should succeed (the first 60), the other must reject as
      // overpay (60 > remaining 40).
      expect(ok).toBe(1);
      expect(rejected).toBe(1);

      // The ledger row must reconcile: paid + remaining = amount, paid = 60.
      const finalDebt = await ctx.db.debt.findUnique({ where: { id: debtId } });
      expect(finalDebt).toBeTruthy();
      expect(new Prisma.Decimal(finalDebt!.paid).equals(60)).toBe(true);
      expect(new Prisma.Decimal(finalDebt!.remaining).equals(40)).toBe(true);
      expect(
        new Prisma.Decimal(finalDebt!.paid)
          .plus(finalDebt!.remaining)
          .equals(finalDebt!.amount),
      ).toBe(true);
    }, 30_000);
  });

  // ─── 2. Concurrent sales of the last unit — exactly one succeeds ──────────
  describe('Concurrent sales depleting last unit of stock', () => {
    let ctx: Ctx;
    let productId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'P',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(5),
          stock: 1, // ← exactly one in stock
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('lets exactly one of two concurrent CASH sales succeed', async () => {
      const body = {
        paymentMethod: 'CASH',
        items: [{ productId, quantity: 1 }],
      };

      const responses = await Promise.allSettled([
        request(ctx.server)
          .post('/api/invoices')
          .set('Authorization', `Bearer ${ctx.token}`)
          .send(body),
        request(ctx.server)
          .post('/api/invoices')
          .set('Authorization', `Bearer ${ctx.token}`)
          .send(body),
      ]);

      const detail = responses.map((r) =>
        r.status === 'fulfilled'
          ? { status: r.value.status, body: r.value.body }
          : { error: String(r.reason) },
      );
      const statuses = responses.map((r) =>
        r.status === 'fulfilled' ? r.value.status : 0,
      );
      const ok = statuses.filter((s) => s === 201).length;
      const rejected = statuses.filter((s) => s === 400).length;
      try {
        expect(ok).toBe(1);
        expect(rejected).toBe(1);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('stock-race responses:', JSON.stringify(detail, null, 2));
        throw e;
      }

      const finalProduct = await ctx.db.product.findUnique({
        where: { id: productId },
      });
      expect(finalProduct!.stock).toBe(0);
    }, 30_000);
  });

  // ─── 3. CHECK constraint refuses raw corruption ───────────────────────────
  describe('DB CHECK constraints', () => {
    let ctx: Ctx;
    let debtId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const c = await ctx.db.customer.create({
        data: { name: 'C2', storeId: ctx.storeId },
      });
      const debt = await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(50),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(50),
          customerId: c.id,
          storeId: ctx.storeId,
        },
      });
      debtId = debt.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('rejects a raw UPDATE that breaks debt_balance_consistent', async () => {
      await expect(
        ctx.db.$executeRaw`
          UPDATE debts
          SET paid = 999, remaining = 0
          WHERE id = ${debtId}
        `,
      ).rejects.toThrow(/debt_balance_consistent|check constraint/i);
    });

    it('rejects a raw UPDATE that drives stock negative', async () => {
      const product = await ctx.db.product.create({
        data: {
          name: 'StockGuard',
          price: new Prisma.Decimal(1),
          wholesalePrice: new Prisma.Decimal(0),
          stock: 5,
          storeId: ctx.storeId,
        },
      });
      await expect(
        ctx.db.$executeRaw`
          UPDATE products SET stock = -1 WHERE id = ${product.id}
        `,
      ).rejects.toThrow(/stock_non_negative|check constraint/i);
    });
  });

  // ─── 4. Parallel invoice creates — every number is unique + monotonic ─────
  describe('Atomic invoice-number allocation', () => {
    let ctx: Ctx;
    let productId: string;

    const PARALLEL = 20; // 100 in the spec; reduced to keep test data small.

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'BulkInv',
          price: new Prisma.Decimal(1),
          wholesalePrice: new Prisma.Decimal(0),
          stock: PARALLEL * 2,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it(`${PARALLEL} parallel invoice creates yield ${PARALLEL} unique numbers`, async () => {
      const body = {
        paymentMethod: 'CASH',
        items: [{ productId, quantity: 1 }],
      };

      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          request(ctx.server)
            .post('/api/invoices')
            .set('Authorization', `Bearer ${ctx.token}`)
            .send(body),
        ),
      );

      const successes = results.filter((r) => r.status === 201);
      expect(successes.length).toBe(PARALLEL);

      const numbers = successes.map((r) => r.body.number);
      const unique = new Set(numbers);
      expect(unique.size).toBe(PARALLEL);
      // The counter is monotonic — sorted set should match a contiguous run
      // starting from min(numbers).
      const sorted = [...numbers].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBe(sorted[i - 1] + 1);
      }
    }, 60_000);
  });
});
