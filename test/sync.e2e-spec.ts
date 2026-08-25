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
 * Phase 4 — Sync hardening (e2e).
 *
 * Each test boots a self-contained store + admin user and tears them down in
 * afterAll. The DB is shared (Neon), so test data is identified by a uuid
 * subdomain (`sync-test-*`) for traceability.
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

  const subdomain = `sync-test-${randomUUID().slice(0, 8)}`;
  const store = await db.store.create({
    data: { name: `Sync Test ${subdomain}`, subdomain, status: 'APPROVED' },
  });
  const user = await db.user.create({
    data: {
      username: `tester-${subdomain}`,
      email: `${subdomain}@sync.test`,
      password: 'x',
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

describe('Phase 4 — Sync hardening (e2e)', () => {
  // ─── 1. Cross-tenant customer reference → 403 ─────────────────────────────
  describe('Cross-tenant references', () => {
    let ctx: Ctx;
    let foreignCustomerId: string;
    let foreignStoreId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      // Set up a SECOND store with a customer that does NOT belong to ctx.
      const otherSubdomain = `sync-foreign-${randomUUID().slice(0, 8)}`;
      const foreignStore = await ctx.db.store.create({
        data: { name: 'Foreign Store', subdomain: otherSubdomain, status: 'APPROVED' },
      });
      foreignStoreId = foreignStore.id;
      const foreignCustomer = await ctx.db.customer.create({
        data: { name: 'Foreign Customer', storeId: foreignStore.id },
      });
      foreignCustomerId = foreignCustomer.id;
    });

    afterAll(async () => {
      // Manual cleanup of the foreign tenant — teardown() only handles ctx.
      await ctx.db.customer.deleteMany({ where: { storeId: foreignStoreId } });
      await ctx.db.store.delete({ where: { id: foreignStoreId } });
      await teardown(ctx);
    });

    it('rejects a push that references a customer from a different store', async () => {
      const payload = {
        invoices: [
          {
            id: randomUUID(),
            date: new Date().toISOString(),
            total: 100,
            paid: 0,
            remaining: 100,
            paymentMethod: 'DEBT',
            customerId: foreignCustomerId, // ← belongs to a different store
            items: [
              {
                id: randomUUID(),
                productName: 'X',
                price: 100,
                quantity: 1,
                total: 100,
              },
            ],
          },
        ],
        debts: [],
        debtPayments: [],
      };

      const res = await request(ctx.server)
        .post('/api/sync/push')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/لا ينتمي إلى متجرك/);
    });

    it('rejects a push that references a product from a different store', async () => {
      // Create a foreign product
      const foreignProduct = await ctx.db.product.create({
        data: {
          name: 'Foreign Product',
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(5),
          stock: 100,
          storeId: foreignStoreId,
        },
      });

      const payload = {
        invoices: [
          {
            id: randomUUID(),
            date: new Date().toISOString(),
            total: 10,
            paid: 10,
            remaining: 0,
            paymentMethod: 'CASH',
            items: [
              {
                id: randomUUID(),
                productName: 'X',
                price: 10,
                quantity: 1,
                total: 10,
                productId: foreignProduct.id, // ← foreign product
              },
            ],
          },
        ],
        debts: [],
        debtPayments: [],
      };

      const res = await request(ctx.server)
        .post('/api/sync/push')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/لا ينتمي إلى متجرك/);

      await ctx.db.product.delete({ where: { id: foreignProduct.id } });
    });
  });

  // ─── 2. Payload too large → 400 ────────────────────────────────────────────
  describe('Payload size limits (ArrayMaxSize)', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await bootstrap();
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('rejects a payload with > 200 invoices', async () => {
      const invoices = Array.from({ length: 201 }, () => ({
        id: randomUUID(),
        date: new Date().toISOString(),
        total: 10,
        paid: 10,
        remaining: 0,
        paymentMethod: 'CASH',
        items: [
          {
            id: randomUUID(),
            productName: 'X',
            price: 10,
            quantity: 1,
            total: 10,
          },
        ],
      }));

      const res = await request(ctx.server)
        .post('/api/sync/push')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ invoices, debts: [], debtPayments: [] });

      expect(res.status).toBe(400);
      const messages = Array.isArray(res.body.message)
        ? res.body.message
        : [String(res.body.message)];
      expect(messages.join(' ')).toMatch(/200 فاتورة/);
    }, 30_000);
  });

  // ─── 3. Overpayment → 400 ─────────────────────────────────────────────────
  describe('Hard overpay reject in sync.push', () => {
    let ctx: Ctx;
    let debtId: string;

    beforeAll(async () => {
      ctx = await bootstrap();
      const customer = await ctx.db.customer.create({
        data: { name: 'Overpay Customer', storeId: ctx.storeId },
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
      debtId = debt.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('rejects a debt payment that exceeds the remaining balance', async () => {
      const payload = {
        invoices: [],
        debts: [],
        debtPayments: [
          {
            id: randomUUID(),
            amount: 100, // ← debt only has 50 remaining
            date: new Date().toISOString(),
            debtId,
          },
        ],
      };

      const res = await request(ctx.server)
        .post('/api/sync/push')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/يتجاوز المتبقي/);

      // The ledger row must be untouched.
      const finalDebt = await ctx.db.debt.findUnique({ where: { id: debtId } });
      expect(new Prisma.Decimal(finalDebt!.paid).equals(0)).toBe(true);
      expect(new Prisma.Decimal(finalDebt!.remaining).equals(50)).toBe(true);
    });
  });

  // ─── 4. Valid payload → 200 + idempotency replay ──────────────────────────
  describe('Valid payload + idempotent replay', () => {
    let ctx: Ctx;
    let productId: string;
    let customerId: string;

    const N_INVOICES = 10;

    beforeAll(async () => {
      ctx = await bootstrap();
      const product = await ctx.db.product.create({
        data: {
          name: 'P',
          price: new Prisma.Decimal(5),
          wholesalePrice: new Prisma.Decimal(2),
          stock: 100,
          storeId: ctx.storeId,
        },
      });
      productId = product.id;
      const customer = await ctx.db.customer.create({
        data: { name: 'C', storeId: ctx.storeId },
      });
      customerId = customer.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it(`accepts a payload with ${N_INVOICES} invoices and dedupes replays`, async () => {
      const invoices = Array.from({ length: N_INVOICES }, () => ({
        id: randomUUID(),
        date: new Date().toISOString(),
        total: 5,
        paid: 5,
        remaining: 0,
        paymentMethod: 'CASH',
        items: [
          {
            id: randomUUID(),
            productName: 'P',
            price: 5,
            quantity: 1,
            total: 5,
            productId,
            unitCost: 2,
          },
        ],
      }));

      const debts = [
        {
          id: randomUUID(),
          amount: 30,
          paid: 0,
          remaining: 30,
          isPaid: false,
          date: new Date().toISOString(),
          customerId,
        },
      ];

      const payload = { invoices, debts, debtPayments: [] };

      // First push: everything new.
      const first = await request(ctx.server)
        .post('/api/sync/push')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send(payload);

      expect(first.status).toBe(200);
      expect(first.body.report.invoices.inserted).toBe(N_INVOICES);
      expect(first.body.report.invoices.skipped).toBe(0);
      expect(first.body.report.debts.inserted).toBe(1);

      // Allocated invoice numbers should be contiguous.
      const persisted = await ctx.db.invoice.findMany({
        where: { storeId: ctx.storeId },
        orderBy: { number: 'asc' },
        select: { number: true },
      });
      expect(persisted.length).toBe(N_INVOICES);
      for (let i = 1; i < persisted.length; i++) {
        expect(persisted[i].number).toBe(persisted[i - 1].number + 1);
      }

      // Stock should have dropped by N (one per invoice).
      const stockAfter = await ctx.db.product.findUnique({
        where: { id: productId },
        select: { stock: true },
      });
      expect(stockAfter!.stock).toBe(100 - N_INVOICES);

      // Replay: everything must be marked skipped, no new rows.
      const replay = await request(ctx.server)
        .post('/api/sync/push')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send(payload);

      expect(replay.status).toBe(200);
      expect(replay.body.report.invoices.inserted).toBe(0);
      expect(replay.body.report.invoices.skipped).toBe(N_INVOICES);
      expect(replay.body.report.debts.inserted).toBe(0);
      expect(replay.body.report.debts.skipped).toBe(1);

      // Stock and invoice count must be unchanged after the replay.
      const stockAfterReplay = await ctx.db.product.findUnique({
        where: { id: productId },
        select: { stock: true },
      });
      expect(stockAfterReplay!.stock).toBe(100 - N_INVOICES);

      const invoiceCount = await ctx.db.invoice.count({
        where: { storeId: ctx.storeId },
      });
      expect(invoiceCount).toBe(N_INVOICES);
    }, 60_000);
  });
});
