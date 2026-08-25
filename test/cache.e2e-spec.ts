import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import request from 'supertest';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { Prisma } from 'generated/prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/modules/database/database.service';
import { env } from '../src/common/config/env';
import { CacheKeys } from '../src/common/cache/cache-keys';

/**
 * Phase 6 — Caching (e2e).
 *
 * Verifies the two cached read paths:
 *   - /api/sync/init  (per-store, 30s TTL, invalidated on writes)
 *   - /api/products/barcode/:b  (per-store+barcode, 5min TTL, invalidated on update)
 *
 * Also verifies the `?force-fresh=true` bypass.
 */

type Ctx = {
  app: INestApplication;
  server: Server;
  db: DatabaseService;
  cache: Cache;
  storeId: string;
  token: string;
};

async function bootstrap(): Promise<Ctx> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.init();

  const db = app.get(DatabaseService);
  const jwt = app.get(JwtService);
  const cache = app.get<Cache>(CACHE_MANAGER);

  const subdomain = `cache-test-${randomUUID().slice(0, 8)}`;
  const store = await db.store.create({
    data: { name: `Cache Test ${subdomain}`, subdomain, status: 'APPROVED' },
  });
  const user = await db.user.create({
    data: {
      username: `tester-${subdomain}`,
      email: `${subdomain}@cache.test`,
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
    cache,
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

describe('Phase 6 — Caching (e2e)', () => {
  // ─── 1. /sync/init caches and reads from cache ───────────────────────────
  describe('/api/sync/init', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await bootstrap();
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('populates and serves from the cache on the second call', async () => {
      const key = CacheKeys.syncInit(ctx.storeId);

      // Ensure clean slate (in case the global cache is hot from a prior test).
      await ctx.cache.del(key);
      expect(await ctx.cache.get(key)).toBeUndefined();

      // First call: cache miss → DB → cache set.
      const first = await request(ctx.server)
        .get('/api/sync/init')
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        products: expect.any(Array),
        customers: expect.any(Array),
        debts: expect.any(Array),
      });
      expect(await ctx.cache.get(key)).toBeDefined();

      // Second call: cache hit. The response shape must be identical.
      const second = await request(ctx.server)
        .get('/api/sync/init')
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
    });

    it('?force-fresh=true bypasses the cache and re-populates it', async () => {
      const key = CacheKeys.syncInit(ctx.storeId);

      // Plant a sentinel value to prove force-fresh ignores it.
      await ctx.cache.set(
        key,
        { products: ['SENTINEL'], customers: [], debts: [] },
        60_000,
      );

      const fresh = await request(ctx.server)
        .get('/api/sync/init?force-fresh=true')
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(fresh.status).toBe(200);
      expect(fresh.body.products).not.toContain('SENTINEL');

      // The fresh fetch must have overwritten the sentinel.
      const newCached = await ctx.cache.get<{ products: string[] }>(key);
      expect(newCached?.products).not.toContain('SENTINEL');
    });

    it('invalidates the cache when a write happens (new customer)', async () => {
      const key = CacheKeys.syncInit(ctx.storeId);

      // Warm the cache.
      await request(ctx.server)
        .get('/api/sync/init')
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(await ctx.cache.get(key)).toBeDefined();

      // Write through the service path that should invalidate the cache.
      await request(ctx.server)
        .post('/api/customers')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ name: `cache-test-${randomUUID().slice(0, 6)}` });

      // The invalidation is fire-and-forget after the DB write. Give it a
      // moment to land before asserting the key is gone.
      await new Promise((r) => setTimeout(r, 100));
      expect(await ctx.cache.get(key)).toBeUndefined();
    }, 15_000);
  });

  // ─── 2. /products/barcode/:barcode caches; update invalidates ─────────────
  describe('Product barcode cache', () => {
    let ctx: Ctx;
    let productId: string;
    const barcode = '7777777777';

    beforeAll(async () => {
      ctx = await bootstrap();
      const p = await ctx.db.product.create({
        data: {
          name: 'Cached Item',
          barcode,
          price: new Prisma.Decimal(10),
          wholesalePrice: new Prisma.Decimal(5),
          stock: 50,
          storeId: ctx.storeId,
        },
      });
      productId = p.id;
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    it('caches the lookup and serves identical responses on a hit', async () => {
      const key = CacheKeys.productByBarcode(ctx.storeId, barcode);
      await ctx.cache.del(key);

      const first = await request(ctx.server)
        .get(`/api/products/barcode/${barcode}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(first.status).toBe(200);
      expect(first.body.id).toBe(productId);
      expect(await ctx.cache.get(key)).toBeDefined();

      const second = await request(ctx.server)
        .get(`/api/products/barcode/${barcode}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(second.body).toEqual(first.body);
    });

    it('invalidates the cache when the product is updated', async () => {
      const key = CacheKeys.productByBarcode(ctx.storeId, barcode);

      // Warm
      await request(ctx.server)
        .get(`/api/products/barcode/${barcode}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(await ctx.cache.get(key)).toBeDefined();

      // Update via API — should bust the cache.
      const newPrice = 99.99;
      await request(ctx.server)
        .patch(`/api/products/${productId}`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ price: newPrice });

      await new Promise((r) => setTimeout(r, 100));
      expect(await ctx.cache.get(key)).toBeUndefined();

      // Refetch should observe the new price.
      const after = await request(ctx.server)
        .get(`/api/products/barcode/${barcode}`)
        .set('Authorization', `Bearer ${ctx.token}`);
      expect(Number(after.body.price)).toBeCloseTo(newPrice, 2);
    }, 15_000);
  });
});
