import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/modules/database/database.service';
import { env } from '../src/common/config/env';

/**
 * Report day boundaries (e2e).
 *
 * The shop runs at UTC+3 and the container runs at UTC, so a report that
 * buckets its day on the UTC calendar covers local 03:00 → next-day 02:59.
 * Every sale between local midnight and 03:00 fell into the previous day and
 * disappeared from "today" — which is why the dashboard read zero right after
 * midnight while the debt totals (not date-scoped) still showed data.
 *
 * The three invoices below straddle both edges of one local day, with amounts
 * chosen so the correct window and the old UTC window cannot produce the same
 * totals by coincidence.
 *
 * Same isolation pattern as carton-sales.e2e-spec.ts: a throwaway store per
 * run, torn down in afterAll.
 */

// July: Asia/Hebron is on summer time, UTC+3.
const LOCAL_DAY = '2026-07-15';

const AT_0030_LOCAL = new Date('2026-07-14T21:30:00.000Z'); // 15 Jul, 00:30 local
const AT_1200_LOCAL = new Date('2026-07-15T09:00:00.000Z'); // 15 Jul, 12:00 local
const NEXT_DAY_0030 = new Date('2026-07-15T21:30:00.000Z'); // 16 Jul, 00:30 local

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

  const subdomain = `tz-test-${randomUUID().slice(0, 8)}`;
  const store = await db.store.create({
    data: { name: `TZ Test ${subdomain}`, subdomain, status: 'APPROVED' },
  });
  const user = await db.user.create({
    data: {
      username: `tester-${subdomain}`,
      email: `${subdomain}@tz.test`,
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
  await db.invoiceItem.deleteMany({ where: { invoice: { storeId } } });
  await db.invoice.deleteMany({ where: { storeId } });
  await db.user.deleteMany({ where: { storeId } });
  await db.store.delete({ where: { id: storeId } });
  await ctx.app.close();
}

/** A one-line cash invoice stamped at an exact instant. */
async function sale(
  ctx: Ctx,
  number: number,
  date: Date,
  price: number,
  unitCost: number,
): Promise<void> {
  await ctx.db.invoice.create({
    data: {
      number,
      date,
      total: price,
      paid: price, // paid + remaining must equal total
      remaining: 0,
      paymentMethod: 'CASH',
      storeId: ctx.storeId,
      items: {
        create: [
          {
            productName: `Item ${number}`,
            price,
            unitCost,
            quantity: 1,
            total: price,
          },
        ],
      },
    },
  });
}

describe('Report day boundaries follow the shop clock, not UTC', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();

    await sale(ctx, 1, AT_0030_LOCAL, 100, 60);
    await sale(ctx, 2, AT_1200_LOCAL, 10, 6);
    await sale(ctx, 3, NEXT_DAY_0030, 1000, 600);
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  describe('GET /api/invoices/daily-sales', () => {
    it('counts the sale rung up at 00:30 local as part of that local day', async () => {
      const res = await request(ctx.server)
        .get(`/api/invoices/daily-sales?date=${LOCAL_DAY}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .expect(200);

      const numbers = (res.body.invoices as { number: number }[])
        .map((inv) => inv.number)
        .sort((a, b) => a - b);

      expect(numbers).toEqual([1, 2]);
    });

    it('totals only that local day — 110, not the UTC window’s 1010', async () => {
      const res = await request(ctx.server)
        .get(`/api/invoices/daily-sales?date=${LOCAL_DAY}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .expect(200);

      expect(res.body.summary.invoiceCount).toBe(2);
      expect(Number(res.body.summary.totalSales)).toBe(110);
    });

    it('reports the local calendar date it was asked for', async () => {
      const res = await request(ctx.server)
        .get(`/api/invoices/daily-sales?date=${LOCAL_DAY}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .expect(200);

      expect(res.body.date).toBe(LOCAL_DAY);
    });

    it('pushes the 00:30 sale of the next local day into the next day', async () => {
      const res = await request(ctx.server)
        .get('/api/invoices/daily-sales?date=2026-07-16')
        .set('Authorization', `Bearer ${ctx.token}`)
        .expect(200);

      const numbers = (res.body.invoices as { number: number }[]).map(
        (inv) => inv.number,
      );

      expect(numbers).toEqual([3]);
    });
  });

  describe('GET /api/reports/daily-profit', () => {
    it('computes profit over the local day — 110 − 66, not 1010 − 606', async () => {
      const res = await request(ctx.server)
        .get(`/api/reports/daily-profit?date=${LOCAL_DAY}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        date: LOCAL_DAY,
        totalRevenue: 110,
        totalCost: 66,
        netProfit: 44,
      });
    });

    it('attributes the next local day to the next day', async () => {
      const res = await request(ctx.server)
        .get('/api/reports/daily-profit?date=2026-07-16')
        .set('Authorization', `Bearer ${ctx.token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        date: '2026-07-16',
        totalRevenue: 1000,
        totalCost: 600,
        netProfit: 400,
      });
    });
  });
});
