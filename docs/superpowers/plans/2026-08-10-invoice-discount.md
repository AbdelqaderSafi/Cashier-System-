# Invoice Discount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a cashier apply a fixed-amount discount to a whole invoice at sale time, with profit reporting that actually reflects the money given away.

**Architecture:** One nullable-by-default column, `invoices.discount Decimal @default(0)`. The stored `total` becomes the **net** (gross line sum − discount), because the pre-existing `invoice_balance_consistent` CHECK requires `paid + remaining = total AND total > 0`. A small pure helper validates the discount and returns the net, shared by invoice create and update so they cannot drift. Profit reporting subtracts the day's discounts from revenue — without that, every discount is silently booked as profit.

**Tech Stack:** NestJS 11, Prisma 7 (`prisma-client` generator → `generated/prisma/client`), PostgreSQL, class-validator, Jest (unit) + Jest/supertest (e2e).

**Spec:** [docs/superpowers/specs/2026-08-10-invoice-discount-design.md](../specs/2026-08-10-invoice-discount-design.md)

**Builds on:** the `feat/carton-sales` branch. Carton support is already merged into this branch's history; do not modify it.

---

## Global Constraints

- **The migration is additive only.** Only `ADD COLUMN` is permitted. Never write `UPDATE`, `DROP`, `SET NOT NULL`, or a backfill against an existing table. Production carries live store data.
- **Every new API field is optional.** A request that omits `discount` must behave exactly as it does today. This is the contract with the already-deployed frontend and with offline devices.
- **The stored `total` is always the NET, after discount.** Storing the gross violates `CHECK (paid + remaining = total)` and surfaces as an unmapped 500 at the till.
- `discount >= grossTotal` must be rejected with a **400**, not left to the database. A zero net violates `CHECK (total > 0)` and produces an unmapped 500.
- **`PATCH` must preserve an existing discount when the field is omitted.** Otherwise editing any discounted invoice silently reverts its total to the gross.
- Profit reporting must subtract the day's discounts from revenue. Cost is unchanged — a discount comes out of profit, not out of purchase cost.
- Discounts are allowed for **both** `ADMIN` and `CASHIER`, matching invoice creation.
- User-facing error messages are in Arabic; code comments are in English.
- The API global prefix is `/api`.
- `ValidationPipe` runs with `whitelist: true, forbidNonWhitelisted: true` — any field not declared on a DTO causes a 400.

## ⚠️ Database safety — read before running ANY command

**The `DATABASE_URL` in the repo's `.env` points at the live production Neon database**, and `main` auto-deploys to Railway. A local development database already exists at the production schema:

```
postgresql://postgres@localhost:5432/casheer_dev
```

**Every command in this plan that reaches a database MUST carry that prefix**, spelled out in each step:

```bash
DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" <command>
```

`dotenv` does not overwrite an already-set `process.env` value, so the shell prefix wins over `.env`. Use Bash (Git Bash / POSIX sh) — the prefix syntax does not work in PowerShell.

**Hard rules:**
1. Never run `prisma migrate dev`, `migrate reset`, or `db push` without the local prefix. `migrate dev` offers to reset the whole database on drift.
2. Never run `prisma migrate deploy` against production by hand. Production applies migrations on its next Railway deploy via the container's `CMD`.
3. `test/guard-local-db.ts` (a jest `globalSetup`) refuses to start the e2e suite unless the host is local. If you see `Refusing to run the e2e suite against ...`, add the prefix — never weaken the guard.

## Known repo conditions — not defects, do not "fix"

- **4 tests in `test/error-handling.e2e-spec.ts` fail with 401.** Caused by commit `ff39cda`, which predates this work; that spec mints a JWT for a `storeId` it never inserts. Tracked separately.
- **`npm run lint` is `eslint --fix`** and the repo carries ~56 pre-existing errors on untouched modules from a CRLF/LF prettier disagreement. Do not run it — lint only changed files, without `--fix`.
- **Jest may not self-exit** after results print. Re-run with `--forceExit` to confirm; it does not indicate failure.
- `prisma migrate dev` does **not** auto-run `prisma generate` on Prisma 7.8.0 here. Run `prisma generate` explicitly after a schema change.

## Task Dependency Order

Sequential: 1 → 2 → 3 → 4 → 5 → 6. Task 3 consumes the helper from Task 2.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | `discount` column on Invoice |
| `prisma/migrations/<ts>_add_invoice_discount/migration.sql` | Create | Additive-only DDL |
| `src/modules/invoice/invoice-discount.util.ts` | Create | Discount validation + net-total arithmetic |
| `src/modules/invoice/invoice-discount.util.spec.ts` | Create | Unit tests for the above |
| `src/modules/invoice/dto/create-invoice.dto.ts` | Modify | `discount` field |
| `src/modules/invoice/dto/update-invoice.dto.ts` | Modify | `discount` field |
| `src/modules/invoice/invoice.service.ts` | Modify | Apply discount on create/update; return it from `getDailySales` |
| `src/modules/customer/customer.service.ts` | Modify | Return `discount` in the invoice-history select |
| `src/modules/reports/reports.service.ts` | Modify | Subtract the day's discounts from revenue |
| `src/modules/sync/dto/sync-push.dto.ts` | Modify | `discount` on offline invoices |
| `src/modules/sync/sync.service.ts` | Modify | Persist the offline discount |
| `test/invoice-discount.e2e-spec.ts` | Create | e2e coverage, one describe block per task |
| `docs/API_CHANGES_FOR_FRONTEND.md` | Modify | Frontend handover notes |

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (model `Invoice`)
- Create: `prisma/migrations/<timestamp>_add_invoice_discount/migration.sql`
- Create: `test/invoice-discount.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Invoice.discount: Prisma.Decimal` (non-null, defaults to 0). Also the `Ctx` / `bootstrap()` / `teardown()` test helpers every later task reuses.

- [ ] **Step 1: Add the column to the Prisma schema**

In `prisma/schema.prisma`, in `model Invoice`, immediately after the `total` line, add:

```prisma
  // Fixed-amount discount applied to the whole invoice at sale time.
  // `total` above is the NET (gross line sum − discount) because
  // invoice_balance_consistent requires paid + remaining = total; the gross
  // is derived as total + discount when a caller needs it.
  discount      Decimal       @default(0) @db.Decimal(10, 2)
```

- [ ] **Step 2: Generate the migration without applying it**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npx prisma migrate dev --create-only --name add_invoice_discount`
Expected: prints the path of a new folder under `prisma/migrations/` and does **not** apply it.

- [ ] **Step 3: Review and annotate the generated SQL**

Open the generated `migration.sql`. Confirm it contains **only** an `ALTER TABLE ... ADD COLUMN`. If it contains `UPDATE`, `DROP`, `SET NOT NULL`, or an index rebuild, **stop and report** — the schema edit drifted from the plan.

Replace its contents with:

```sql
-- Invoice-level discount. Additive only: no existing row is read or rewritten.
--
-- A constant DEFAULT is metadata-only in PostgreSQL 11+, so this does NOT
-- rewrite the invoices table; every existing invoice reads as 0.
--
-- Note that `invoices.total` stores the NET amount (gross − discount). It has
-- to: invoice_balance_consistent (added in 20260522114500) enforces
-- paid + remaining = total AND total > 0.
ALTER TABLE "invoices" ADD COLUMN "discount" DECIMAL(10,2) NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Apply the migration and regenerate the client**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npx prisma migrate dev`
Then run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npx prisma generate`
Expected: migration applied; `Invoice` in `generated/prisma/client` now carries `discount`.

- [ ] **Step 5: Write the backward-compatibility e2e test**

Create `test/invoice-discount.e2e-spec.ts`:

```ts
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
```

- [ ] **Step 6: Run the backward-compatibility test**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- invoice-discount`
Expected: PASS — 2 tests. Both exercise only pre-existing code paths, so they must pass before any behaviour changes.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations test/invoice-discount.e2e-spec.ts
git commit -m "feat(discount): add the invoice discount column, additive migration only"
```

---

### Task 2: `invoice-discount.util.ts` — validation and net arithmetic

**Files:**
- Create: `src/modules/invoice/invoice-discount.util.ts`
- Test: `src/modules/invoice/invoice-discount.util.spec.ts`

**Interfaces:**
- Consumes: `Prisma` from `generated/prisma/client`
- Produces:
  - `applyInvoiceDiscount(grossTotal: Prisma.Decimal, discount?: number | Prisma.Decimal | null): { discount: Prisma.Decimal; total: Prisma.Decimal }` — throws `BadRequestException` when the discount is negative or not strictly less than `grossTotal`

- [ ] **Step 1: Write the failing unit test**

Create `src/modules/invoice/invoice-discount.util.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { applyInvoiceDiscount } from './invoice-discount.util';

const gross = (n: number) => new Prisma.Decimal(n);

describe('applyInvoiceDiscount', () => {
  it('subtracts the discount from the gross total', () => {
    const result = applyInvoiceDiscount(gross(60), 10);
    expect(result.total.equals(50)).toBe(true);
    expect(result.discount.equals(10)).toBe(true);
  });

  it('treats an omitted discount as zero and leaves the total untouched', () => {
    const result = applyInvoiceDiscount(gross(60));
    expect(result.total.equals(60)).toBe(true);
    expect(result.discount.equals(0)).toBe(true);
  });

  it('treats null the same as omitted', () => {
    const result = applyInvoiceDiscount(gross(60), null);
    expect(result.total.equals(60)).toBe(true);
    expect(result.discount.equals(0)).toBe(true);
  });

  it('accepts an explicit zero', () => {
    const result = applyInvoiceDiscount(gross(60), 0);
    expect(result.total.equals(60)).toBe(true);
    expect(result.discount.equals(0)).toBe(true);
  });

  it('accepts a Decimal discount (a value read back from a DB row)', () => {
    const result = applyInvoiceDiscount(gross(60), new Prisma.Decimal(10));
    expect(result.total.equals(50)).toBe(true);
  });

  it('keeps two-decimal precision', () => {
    const result = applyInvoiceDiscount(gross(60), 10.55);
    expect(result.total.toFixed(2)).toBe('49.45');
  });

  it('rejects a discount equal to the gross total', () => {
    // A zero net violates CHECK (total > 0) and would surface as an unmapped
    // 500 from the database instead of a readable message.
    expect(() => applyInvoiceDiscount(gross(60), 60)).toThrow(BadRequestException);
  });

  it('rejects a discount larger than the gross total', () => {
    expect(() => applyInvoiceDiscount(gross(60), 70)).toThrow(BadRequestException);
  });

  it('rejects a negative discount', () => {
    expect(() => applyInvoiceDiscount(gross(60), -5)).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- invoice-discount.util`
Expected: FAIL — `Cannot find module './invoice-discount.util'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/invoice/invoice-discount.util.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';

/**
 * Applies an invoice-level discount and returns the pair that gets stored.
 *
 * The returned `total` is the NET amount, and that is what the invoice row
 * holds — invoice_balance_consistent enforces `paid + remaining = total`, so
 * storing the gross while paying the net would make the database reject the
 * write. The gross stays derivable as `total + discount`.
 *
 * A discount is rejected unless it is strictly less than the gross: an
 * invoice that nets to zero violates `CHECK (total > 0)` and would reach the
 * cashier as an unmapped 500 rather than a readable Arabic message.
 */
export function applyInvoiceDiscount(
  grossTotal: Prisma.Decimal,
  discount?: number | Prisma.Decimal | null,
): { discount: Prisma.Decimal; total: Prisma.Decimal } {
  const value = new Prisma.Decimal(discount ?? 0);

  if (value.lt(0)) {
    throw new BadRequestException('الخصم لا يمكن أن يكون بالسالب');
  }

  if (value.gt(0) && value.gte(grossTotal)) {
    throw new BadRequestException(
      `الخصم (${value.toString()}) يجب أن يكون أقل من إجمالي الفاتورة (${grossTotal.toString()})`,
    );
  }

  return { discount: value, total: grossTotal.minus(value) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- invoice-discount.util`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/invoice/invoice-discount.util.ts src/modules/invoice/invoice-discount.util.spec.ts
git commit -m "feat(discount): add invoice discount validation and net-total helper"
```

---

### Task 3: Invoice create and update apply the discount

**Files:**
- Modify: `src/modules/invoice/dto/create-invoice.dto.ts`
- Modify: `src/modules/invoice/dto/update-invoice.dto.ts`
- Modify: `src/modules/invoice/invoice.service.ts` (`create`, `update`, `getDailySales`)
- Modify: `src/modules/customer/customer.service.ts` (invoice history select)
- Test: `test/invoice-discount.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `applyInvoiceDiscount` (Task 2)
- Produces: `POST /api/invoices` and `PATCH /api/invoices/:id` accepting `discount`

- [ ] **Step 1: Write the failing e2e test**

Append to `test/invoice-discount.e2e-spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- invoice-discount`
Expected: FAIL — `discount` is rejected as an unknown property (`forbidNonWhitelisted`).

- [ ] **Step 3: Add `discount` to `CreateInvoiceDto`**

In `src/modules/invoice/dto/create-invoice.dto.ts`, append to `CreateInvoiceDto` (after `paid`):

```ts
  @ApiPropertyOptional({
    example: 10,
    default: 0,
    description:
      'خصم على الفاتورة كاملة (مبلغ مقطوع). المجموع المخزَّن هو الصافي بعد الخصم. ' +
      'يجب أن يكون أقل من إجمالي البنود',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  discount?: number;
```

- [ ] **Step 4: Add `discount` to `UpdateInvoiceDto`**

In `src/modules/invoice/dto/update-invoice.dto.ts`, append to `UpdateInvoiceDto`:

```ts
  @ApiPropertyOptional({
    example: 20,
    description:
      'خصم جديد على الفاتورة كاملة. إذا لم يُرسل يبقى الخصم الحالي كما هو',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  discount?: number;
```

- [ ] **Step 5: Apply the discount in `InvoiceService.create`**

In `src/modules/invoice/invoice.service.ts`, add the import:

```ts
import { applyInvoiceDiscount } from './invoice-discount.util';
```

Find the block that reduces the built items into `total`:

```ts
    const total = invoiceItems.reduce(
      (acc, item) => acc.plus(item.total),
      new Prisma.Decimal(0),
    );
```

Replace it with:

```ts
    // The line sum is the GROSS. What gets stored as `total` is the net after
    // the invoice discount — invoice_balance_consistent enforces
    // paid + remaining = total, so paying the net against a gross total would
    // be rejected by the database.
    const grossTotal = invoiceItems.reduce(
      (acc, item) => acc.plus(item.total),
      new Prisma.Decimal(0),
    );
    const { discount, total } = applyInvoiceDiscount(grossTotal, dto.discount);
```

Then, in the `tx.invoice.create({ data: { ... } })` call, add `discount` alongside `total`:

```ts
            total,
            discount,
```

Everything downstream (`paid`, `remaining`, the `PARTIAL` check, the debt row) already reads `total`, so it now correctly works off the net with no further change.

- [ ] **Step 6: Apply the discount in `InvoiceService.update`**

Still in `src/modules/invoice/invoice.service.ts`, in `update`:

The initial fetch must bring the stored discount forward. Add `discount` to the fields the existing invoice read returns — it uses `include`, so confirm `invoice.discount` is available; if the query was narrowed to a `select`, add `discount: true`.

Replace the total computation. It currently reads:

```ts
    let total: Prisma.Decimal = new Prisma.Decimal(invoice.total);
```

and later, inside the `if (dto.items !== undefined)` block:

```ts
      total = newInvoiceItems.reduce(
        (acc, item) => acc.plus(item.total),
        new Prisma.Decimal(0),
      );
```

Change to track the gross and derive the net once, after the items are resolved:

```ts
    // Start from the stored values. `invoice.total` is already net, so the
    // gross it came from is total + discount.
    let discount: Prisma.Decimal = new Prisma.Decimal(invoice.discount);
    let grossTotal: Prisma.Decimal = new Prisma.Decimal(invoice.total).plus(discount);
```

and inside the `if (dto.items !== undefined)` block, replace the `total = ...reduce(...)` with:

```ts
      grossTotal = newInvoiceItems.reduce(
        (acc, item) => acc.plus(item.total),
        new Prisma.Decimal(0),
      );
```

Then, immediately after that `if (dto.items !== undefined)` block closes and before `paid`/`remaining` are computed, add:

```ts
    // An omitted discount keeps the stored one, re-applied to whatever the
    // gross is now — otherwise editing a discounted invoice would silently
    // revert its total to the gross and overcharge the customer.
    const applied = applyInvoiceDiscount(
      grossTotal,
      dto.discount !== undefined ? dto.discount : discount,
    );
    discount = applied.discount;
    const total = applied.total;
```

Make sure the later `let paid` / `let remaining` switch and the debt logic read this `total`. Persist the discount by adding it to the `tx.invoice.update({ data: { ... } })` call, next to `total`:

```ts
            total,
            discount,
```

Take care that `total` is no longer a `let` reassigned in two places — it is now computed once. Remove the old `let total` declaration and any leftover reassignment so the file still compiles.

- [ ] **Step 7: Return `discount` from the two reads that use an explicit `select`**

Most invoice reads use `include`, which returns every scalar column, so `discount` appears with no change. Two do not, and would silently omit it — leaving the frontend to show a net total with no way to explain it:

In `src/modules/invoice/invoice.service.ts`, in `getDailySales`, the invoice `select` (around line 726) lists `paymentMethod: true`. Add `discount: true` alongside `total: true`.

In `src/modules/customer/customer.service.ts`, in `findOne`, the nested `invoices` select (around line 133) does the same. Add `discount: true` alongside `total: true`.

Change nothing else in either query — do not reorder or drop existing fields.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- invoice-discount`
Expected: PASS — 10 tests (2 from Task 1 + 8 new).

- [ ] **Step 9: Verify the invoice suites did not regress**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 35 tests. This is the regression net over `create`/`update`.

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- ledger-integrity`
Expected: PASS — 5 tests.

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/modules/invoice test/invoice-discount.e2e-spec.ts
git commit -m "feat(discount): apply an invoice discount on create and preserve it on update"
```

---

### Task 4: Profit reporting subtracts discounts

**Files:**
- Modify: `src/modules/reports/reports.service.ts`
- Test: `test/invoice-discount.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `Invoice.discount` (Task 1)
- Produces: `GET /api/reports/daily-profit` returning revenue net of discounts

- [ ] **Step 1: Write the failing e2e test**

Append to `test/invoice-discount.e2e-spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- invoice-discount`
Expected: FAIL — `totalRevenue` is 60, not 50.

- [ ] **Step 3: Subtract the day's discounts from revenue**

In `src/modules/reports/reports.service.ts`, after the existing `costRows` raw query, add a second scoped query and fold it into the revenue:

```ts
    // Invoice-level discounts live on the invoice, not on its lines, so the
    // line-sum revenue above is the GROSS. Subtract the day's discounts or
    // every discount given is reported as profit.
    const discountRows = await this.db.$queryRaw<{ total_discount: string }[]>`
      SELECT COALESCE(SUM(i."discount"), 0)::text AS total_discount
      FROM   invoices i
      WHERE  i."storeId" = ${sid}
        AND  i.date BETWEEN ${dayStart} AND ${dayEnd}
    `;
```

Then change the revenue computation from:

```ts
    const totalRevenue = Number(result._sum.total ?? 0);
```

to:

```ts
    const grossRevenue = Number(result._sum.total ?? 0);
    const totalDiscount = Number(discountRows[0]?.total_discount ?? 0);
    const totalRevenue = grossRevenue - totalDiscount;
```

Leave `totalCost` untouched — a discount comes out of profit, not out of purchase cost.

Also update the method's doc comment so the stated formula matches:

```ts
   * Revenue = Σ (item.price × item.quantity) − Σ (invoice.discount)
   * Cost    = Σ (item.unitCost × item.quantity)
   * Profit  = Revenue − Cost
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- invoice-discount`
Expected: PASS — 12 tests.

- [ ] **Step 5: Verify undiscounted reporting is unchanged**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 35 tests. The carton suite asserts exact profit figures on undiscounted invoices, so it is the regression net for this change.

- [ ] **Step 6: Commit**

```bash
git add src/modules/reports/reports.service.ts test/invoice-discount.e2e-spec.ts
git commit -m "fix(discount): subtract invoice discounts from reported revenue"
```

---

### Task 5: Offline sync carries the discount

**Files:**
- Modify: `src/modules/sync/dto/sync-push.dto.ts`
- Modify: `src/modules/sync/sync.service.ts`
- Test: `test/invoice-discount.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `Invoice.discount` (Task 1)
- Produces: `POST /api/sync/push` accepting `invoices[].discount`

- [ ] **Step 1: Write the failing e2e test**

Append to `test/invoice-discount.e2e-spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- invoice-discount`
Expected: FAIL — `discount` rejected as an unknown property on `SyncInvoiceDto`.

- [ ] **Step 3: Add `discount` to `SyncInvoiceDto`**

In `src/modules/sync/dto/sync-push.dto.ts`, append to `SyncInvoiceDto` (after `remaining`):

```ts
  @ApiPropertyOptional({
    example: 10.0,
    default: 0,
    description:
      'خصم الفاتورة (مبلغ مقطوع). المجموع المرسل total هو الصافي بعد الخصم. ' +
      'ضروري لصحة التقارير — بدونه يُحتسب الخصم ربحاً',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  discount?: number;
```

- [ ] **Step 4: Persist it in `SyncService.push`**

In `src/modules/sync/sync.service.ts`, in the `tx.invoice.createMany` call, add `discount` next to `remaining`:

```ts
                remaining: new Prisma.Decimal(invoice.remaining),
                discount: new Prisma.Decimal(invoice.discount ?? 0),
```

Nothing else changes: the sync path deliberately trusts the device's `total`, `paid` and `remaining` as it already does — the sale physically happened — and `discount` is stored as a historical snapshot so reporting can subtract it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- invoice-discount`
Expected: PASS — 14 tests.

- [ ] **Step 6: Verify the pre-existing sync suite still passes**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- sync`
Expected: PASS — 5 tests. It covers the idempotency, cross-tenant and overpayment paths around this change.

- [ ] **Step 7: Commit**

```bash
git add src/modules/sync test/invoice-discount.e2e-spec.ts
git commit -m "feat(discount): carry the invoice discount through offline sync"
```

---

### Task 6: Full verification and frontend handover

**Files:**
- Modify: `docs/API_CHANGES_FOR_FRONTEND.md`

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — including the new `invoice-discount.util` suite.

- [ ] **Step 2: Run the full e2e suite**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e`
Expected: PASS for `cache`, `ledger-integrity`, `security`, `sync`, `carton-sales`, and `invoice-discount`.

**Known pre-existing failure — not ours, do not "fix" it.** 4 tests in `test/error-handling.e2e-spec.ts` fail with 401, caused by commit `ff39cda`. Any failure outside those 4 is ours.

- [ ] **Step 3: Lint the changed files and build**

**Do not run `npm run lint`** — it is `eslint --fix` and would rewrite the repo.

```bash
npx eslint $(git diff --name-only main..HEAD -- '*.ts')
```

Expected: no error that is new relative to the rest of the repo. Line-ending (`prettier/prettier` `␍⏎`) complaints are the pre-existing repo-wide condition.

Run: `npm run build`
Expected: exit 0. This is a hard gate.

- [ ] **Step 4: Confirm the migration is additive-only**

```bash
grep -v "^\s*--" prisma/migrations/*_add_invoice_discount/migration.sql | grep -icE "update|drop|set not null|delete|truncate|alter column"
```

Expected: `0`. If anything other than `ADD COLUMN` appears, **stop and report BLOCKED**.

- [ ] **Step 5: Write the frontend handover notes**

Append to `docs/API_CHANGES_FOR_FRONTEND.md`:

```markdown
## خصم الفاتورة (2026-08-10)

`POST /api/invoices` و `PATCH /api/invoices/:id` صاروا يقبلوا حقل اختياري:

| الحقل | النوع | ملاحظات |
|---|---|---|
| `discount` | `decimal ≥ 0` | خصم على الفاتورة كاملة (مبلغ مقطوع، لا نسبة) |

مسموح للكاشير والمدير.

**⚠️ ثلاث نقاط تخص الواجهة:**

1. **`total` في كل الاستجابات هو الصافي بعد الخصم.** المجموع قبل الخصم = `total + discount`.
   مثال: بنود بـ 60 مع `discount: 10` → `total: 50`, `discount: 10`.

2. **سقف الدفع الجزئي بينزل مع الخصم.** عند `PARTIAL` المبلغ المدفوع لازم يكون أقل من **الصافي**، لا من الإجمالي. فاتورة 60 بخصم 10 → أقصى دفعة جزئية أقل من 50. أرسل 55 وسيُرفض بـ 400.

3. **الخصم المساوي أو الأكبر من إجمالي البنود → 400.** فاتورة بصافي صفر مرفوضة. امنعها في الواجهة قبل الإرسال.

**التعديل:** إذا لم تُرسل `discount` في `PATCH`، الخصم الحالي يبقى كما هو ويُعاد تطبيقه على الإجمالي الجديد. أرسل `discount: 0` صراحةً لإلغاء الخصم.

**المزامنة الأوف‌لاين:** `POST /api/sync/push` — كل فاتورة تقبل `discount` اختياري، و`total` المرسل هو الصافي. **طابور الأوف‌لاين لازم يبعت `discount`** وإلا التقارير بتحسب الخصم ربحاً.

**التقارير:** `GET /api/reports/daily-profit` صار يطرح خصومات اليوم من الإيراد، فصار يتطابق مع `totalSales` في `GET /api/invoices/daily-sales`.
```

- [ ] **Step 6: Commit**

```bash
git add docs/API_CHANGES_FOR_FRONTEND.md
git commit -m "docs(discount): document the invoice discount API for the frontend"
```

---

## Self-Review Notes

**Spec coverage:** §3 → Task 1. §4–§5 → Tasks 2 and 3. §6 (partial-payment cap) → Task 3 Step 1, test 3. §7 (reporting) → Task 4. §8 (update preserves) → Task 3 Step 1, tests 6–8. §9 (sync) → Task 5. §10 (response) → covered implicitly; invoice reads use `include`, so `discount` is returned without a select change — Task 1's backward-compat test asserts `res.body.discount`. §11 (frontend notes) → Task 6 Step 5. §13 acceptance criteria → all 14 mapped: 1–2 (Task 1 Step 5), 3 (Task 3 test 6), 4 (Task 3 test 1), 5 (Task 3 test 2), 6 (Task 3 test 3), 7 (Task 4 test 1), 8 (Task 4 test 2), 9 (Task 3 test 7), 10 (Task 5 test 1), 11–12 (Task 3 test 4), 13 (Task 3 test 5), 14 (DTO `maxDecimalPlaces: 2`).

**Type consistency:** `applyInvoiceDiscount` is named identically in Tasks 2 and 3 and returns `{ discount, total }` in both. `grossTotal` is the local name for the line sum in both `create` and `update`.

**Known risk called out for implementers:** Task 3 Step 6 restructures `update`'s total computation from a reassigned `let total` into a single derivation. That method also carries the debt-constraint checks and the `SELECT ... FOR UPDATE` debt lock — they must survive untouched.
