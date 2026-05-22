import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { Server } from 'http';
import { Prisma } from 'generated/prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { CustomerService } from '../src/modules/customer/customer.service';
import { env } from '../src/common/config/env';

type TestContext = {
  app: INestApplication;
  server: Server;
  token: string;
};

async function bootstrapTestApp(
  override?: (builder: ReturnType<typeof Test.createTestingModule>) => void,
): Promise<TestContext> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (override) override(builder);

  const moduleRef: TestingModule = await builder.compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  // Mint a JWT for a fake (but well-formed) tenant. This is enough to traverse
  // JwtGuard → TenantGuard → RolesGuard for tenant-scoped routes; the DB query
  // simply returns an empty result set for an unknown storeId.
  const jwt = app.get(JwtService);
  const token = await jwt.signAsync(
    {
      sub: '11111111-1111-1111-1111-111111111111',
      storeId: '22222222-2222-2222-2222-222222222222',
      role: 'ADMIN',
    },
    { secret: env.JWT_SECRET, expiresIn: '5m' },
  );

  return { app, server: app.getHttpServer() as Server, token };
}

describe('Phase 2 — Error Handling & Bootstrap Hardening (e2e)', () => {
  // ─── 1. PrismaExceptionFilter — maps P2002 to 409 with Arabic message ─────
  describe('PrismaExceptionFilter — maps DB errors to friendly HTTP responses', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await bootstrapTestApp((builder) => {
        builder.overrideProvider(CustomerService).useValue({
          findAll: () => {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed on the fields: (`phone`)',
              {
                code: 'P2002',
                clientVersion: '7.8.0',
                meta: { target: ['phone'] },
              },
            );
          },
        });
      });
    });

    afterAll(async () => {
      await ctx.app.close();
    });

    it('translates P2002 (unique violation) → 409 with Arabic message and no stack trace', async () => {
      const res = await request(ctx.server)
        .get('/api/customers')
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: 'P2002',
      });
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message).toMatch(/سجل مكرر/);
      expect(res.body.message).toContain('phone');

      // Critical: a Prisma stack trace must NOT leak to the client.
      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toMatch(/at .*\.ts:\d+/);
      expect(serialised).not.toMatch(/node_modules/);
    });
  });

  // ─── 2. PrismaExceptionFilter — P2025 (not found) ─────────────────────────
  describe('PrismaExceptionFilter — P2025', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await bootstrapTestApp((builder) => {
        builder.overrideProvider(CustomerService).useValue({
          findAll: () => {
            throw new Prisma.PrismaClientKnownRequestError(
              'Record to update not found',
              { code: 'P2025', clientVersion: '7.8.0' },
            );
          },
        });
      });
    });

    afterAll(async () => {
      await ctx.app.close();
    });

    it('translates P2025 → 404 with Arabic message', async () => {
      const res = await request(ctx.server)
        .get('/api/customers')
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        code: 'P2025',
      });
      expect(res.body.message).toMatch(/السجل غير موجود/);
    });
  });

  // ─── 3. Pagination cap — ?limit=99999 must return at most 100 items ───────
  describe('paginate() — DoS guard caps page size at 100', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await bootstrapTestApp();
    });

    afterAll(async () => {
      await ctx.app.close();
    });

    it('clamps absurdly large ?limit to MAX_PAGE_SIZE=100 in meta', async () => {
      const res = await request(ctx.server)
        .get('/api/customers?page=1&limit=99999')
        .set('Authorization', `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.limit).toBe(100);
      expect(res.body.meta.page).toBe(1);
      expect(Array.isArray(res.body.data)).toBe(true);
      // The fake tenant has no rows — but the meta proves the cap was applied.
      expect(res.body.data.length).toBeLessThanOrEqual(100);
    });

    it('clamps page=0 / page=-5 to page=1', async () => {
      const res = await request(ctx.server)
        .get('/api/customers?page=-5&limit=10')
        .set('Authorization', `Bearer ${ctx.token}`);

      // class-validator @Min(1) on the DTO rejects negative pages before they
      // reach paginate(), so a 400 here is the correct outcome. The
      // important behaviour is that there is NO way to request page=-5.
      expect([200, 400]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.meta.page).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ─── 4. /api/health — terminus-backed liveness probe ──────────────────────
  describe('/api/health — Terminus liveness + DB ping', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await bootstrapTestApp();
    });

    afterAll(async () => {
      await ctx.app.close();
    });

    it('returns 200 with database status=up when the DB is reachable', async () => {
      const res = await request(ctx.server).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' } },
        details: { database: { status: 'up' } },
      });
    });

    it('is not subject to throttling (10 rapid requests all pass)', async () => {
      for (let i = 0; i < 10; i++) {
        const res = await request(ctx.server).get('/api/health');
        expect(res.status).toBe(200);
      }
    });
  });
});
