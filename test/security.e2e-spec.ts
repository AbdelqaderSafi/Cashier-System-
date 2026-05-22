import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/modules/database/database.service';

// Each `describe` block builds its own Nest app so that the in-memory
// throttler counter is reset between unrelated test groups. Without this,
// requests fired in earlier blocks would carry over and trigger spurious 429s.
async function bootstrapTestApp(): Promise<{ app: INestApplication; server: Server }> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return { app, server: app.getHttpServer() as Server };
}

describe('Phase 1 — Security Hardening (e2e)', () => {
  // ─── 1. Rate limiting on /api/auth/login ──────────────────────────────────
  describe('Throttler — POST /api/auth/login', () => {
    let app: INestApplication;
    let server: Server;

    const badCreds = {
      subdomain: 'nonexistent-store-for-throttle-test',
      username: 'attacker',
      password: 'definitely-wrong-password',
    };

    beforeAll(async () => {
      ({ app, server } = await bootstrapTestApp());
    });

    afterAll(async () => {
      await app.close();
    });

    it('allows the first 5 invalid attempts (status != 429)', async () => {
      for (let i = 1; i <= 5; i++) {
        const res = await request(server).post('/api/auth/login').send(badCreds);
        expect(res.status).not.toBe(429);
        // Should be 401 (bad creds) or 404 (store not found) — either confirms the
        // request reached the controller layer rather than being rate-limited.
        expect([400, 401, 404, 500]).toContain(res.status);
      }
    }, 30_000);

    it('returns 429 Too Many Requests on the 6th attempt', async () => {
      const res = await request(server).post('/api/auth/login').send(badCreds);
      expect(res.status).toBe(429);
      // Nest throttler ships a standard "ThrottlerException: Too Many Requests"
      expect(JSON.stringify(res.body)).toMatch(/too many|throttle/i);
    }, 30_000);
  });

  // ─── 2. ValidationPipe forbidNonWhitelisted on /api/auth/login ────────────
  describe('ValidationPipe — forbidNonWhitelisted', () => {
    let app: INestApplication;
    let server: Server;

    beforeAll(async () => {
      ({ app, server } = await bootstrapTestApp());
    });

    afterAll(async () => {
      await app.close();
    });

    it('rejects requests containing fields not declared in the DTO', async () => {
      const res = await request(server).post('/api/auth/login').send({
        subdomain: 'demo',
        username: 'a',
        password: 'b',
        role: 'SUPER_ADMIN', // unauthorized — must be rejected
        isActive: true,      // unauthorized — must be rejected
      });

      expect(res.status).toBe(400);

      const messages: string[] = Array.isArray(res.body.message)
        ? res.body.message
        : [String(res.body.message)];
      const joined = messages.join(' | ').toLowerCase();

      expect(joined).toContain('role');
      expect(joined).toMatch(/should not exist|isactive/);
    });

    it('accepts well-formed payloads (no extra fields)', async () => {
      const res = await request(server).post('/api/auth/login').send({
        subdomain: 'demo',
        username: 'a',
        password: 'b',
      });
      // We don't care whether login succeeds — only that validation passed.
      // 400 would mean validation rejected it; anything else is acceptable.
      expect(res.status).not.toBe(400);
    });
  });

  // ─── 3. Helmet security headers on /api/health ────────────────────────────
  describe('Helmet — Security Headers', () => {
    let app: INestApplication;
    let server: Server;

    beforeAll(async () => {
      ({ app, server } = await bootstrapTestApp());
    });

    afterAll(async () => {
      await app.close();
    });

    it('attaches all critical security headers to /api/health', async () => {
      const res = await request(server).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok' });

      // Helmet defaults
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['x-dns-prefetch-control']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-download-options']).toBe('noopen');

      // Helmet removes the X-Powered-By fingerprint
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  // ─── 4. JSON body size limit (2MB) ────────────────────────────────────────
  describe('Body parser — 2MB JSON limit', () => {
    let app: INestApplication;
    let server: Server;

    beforeAll(async () => {
      ({ app, server } = await bootstrapTestApp());
    });

    afterAll(async () => {
      await app.close();
    });

    it('rejects JSON payloads larger than 2MB with 413', async () => {
      // ~3MB of repeated text
      const filler = 'a'.repeat(3 * 1024 * 1024);
      const payload = JSON.stringify({ junk: filler });

      const res = await request(server)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        // Pass raw string so supertest doesn't reserialize and we can be sure
        // the wire size matches.
        .send(payload);

      expect(res.status).toBe(413);
    }, 30_000);
  });

  // ─── 5. Duplicate-email guard on /api/auth/register ────────────────────────
  describe('Auth — duplicate email prevention', () => {
    let app: INestApplication;
    let server: Server;
    let db: DatabaseService;
    let createdStoreId: string | null = null;
    const existingEmail = `dup-${randomUUID().slice(0, 8)}@test.local`;

    beforeAll(async () => {
      ({ app, server } = await bootstrapTestApp());
      db = app.get(DatabaseService);

      // Seed an existing user directly in the DB (no mail sending). We need a
      // store row first since User.storeId is non-null for non-SUPER_ADMINs.
      const store = await db.store.create({
        data: {
          name: 'Dup-test Store',
          subdomain: `dup-test-${randomUUID().slice(0, 8)}`,
          status: 'APPROVED',
        },
      });
      createdStoreId = store.id;
      await db.user.create({
        data: {
          username: 'existing-user',
          email: existingEmail,
          password: 'x',
          role: 'ADMIN',
          storeId: store.id,
          isEmailVerified: true,
        },
      });
    });

    afterAll(async () => {
      if (createdStoreId) {
        await db.user.deleteMany({ where: { storeId: createdStoreId } });
        await db.store.delete({ where: { id: createdStoreId } });
      }
      await app.close();
    });

    it('rejects /auth/register when the email already exists, with Arabic 409', async () => {
      const res = await request(server)
        .post('/api/auth/register')
        .send({
          name: 'Another Store',
          username: 'new-user',
          email: existingEmail,
          password: 'strongpassword123',
        });

      expect(res.status).toBe(409);
      expect(String(res.body.message)).toMatch(/مسجَّل مسبقاً/);

      // Critical: no orphan Store row may have been created for this attempt.
      const stores = await db.store.findMany({
        where: { name: 'Another Store' },
        select: { id: true },
      });
      expect(stores.length).toBe(0);
    });
  });
});
