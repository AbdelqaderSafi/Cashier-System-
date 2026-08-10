# Carton Sales Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a store define products that are bought and sold by the carton, and sell either whole cartons or single pieces from the same product — without touching a single existing row in the live production database.

**Architecture:** Three nullable columns on `products` define a carton (pieces per carton, carton purchase price, carton sale price). Two new columns on `invoice_items` freeze a historical snapshot of each sale line: `saleUnit` (`UNIT`/`CARTON`, `NOT NULL DEFAULT 'UNIT'`) and `stockQuantity` (nullable — the pieces actually moved on the stock ledger). Stock is always counted in pieces; `quantity` on a line is counted in whatever unit was sold. All pricing is derived server-side from the product row, never from the request body. Two pure utility modules (`carton.util.ts`, `invoice-item.util.ts`) hold the shared arithmetic so product-create/update and invoice-create/update/delete/sync cannot drift apart.

**Tech Stack:** NestJS 11, Prisma 7 (`prisma-client` generator → `generated/prisma/client`), PostgreSQL, class-validator, Jest (unit) + Jest/supertest (e2e).

**Spec:** [docs/superpowers/specs/2026-08-09-carton-sales-design.md](../specs/2026-08-09-carton-sales-design.md)

---

## Global Constraints

- **The migration is additive only.** Only `CREATE TYPE` and `ADD COLUMN` are permitted. Never write `UPDATE`, `DROP`, `SET NOT NULL`, or a backfill against an existing table. Production carries live store data.
- **Every new API field is optional.** A request that omits all of them must behave exactly as it does today. This is the backward-compatibility contract with already-deployed frontends and offline devices.
- **Never trust client-sent prices or carton sizes.** `price`, `unitCost`, and `stockQuantity` are always derived from the `products` row inside the request.
- `Product.stock` is **always in pieces**, never in cartons.
- **Never read `invoiceItem.stockQuantity` directly** on a restore/deduct path. Always go through `stockPiecesOf()` (Task 5), which falls back to `quantity` for pre-migration rows. Reading it directly silently restores the wrong stock for legacy invoices.
- The API global prefix is `/api` (set in `src/bootstrap.ts`). All e2e request paths start with `/api`.
- `ValidationPipe` runs with `whitelist: true, forbidNonWhitelisted: true`. Any field not declared on a DTO causes a **400**, so every new field must be added to its DTO or the frontend breaks.
- User-facing error messages are in Arabic; code comments are in English. Follow the existing files.
- The carton field group is **all three or none**: `piecesPerCarton`, `cartonPurchasePrice`, `cartonSalePrice`.
- In carton mode, opening stock = `(cartonCount × piecesPerCarton) + stock`. The `stock` field means **loose pieces** in carton mode. This is a deliberate deviation from the original requirements report — see spec §11.

## ⚠️ Database safety — read before running ANY command

**The `DATABASE_URL` in the repo's `.env` points at the live production Neon database.** It holds real store data that must not be touched.

A local development database has already been created and brought up to the production schema:

```
postgresql://postgres@localhost:5432/casheer_dev
```

**Every command in this plan that reaches a database MUST be prefixed with that URL.** The plan spells the prefix out in each step — do not drop it.

```bash
DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" <command>
```

`dotenv` does not overwrite an already-set `process.env` value (verified), so the shell prefix wins over `.env`.

**Two hard rules:**

1. **Never run `prisma migrate dev`, `migrate reset`, or `db push` without the local prefix.** `migrate dev` offers to *reset the entire database* when it detects drift. Against production that is total data loss.
2. **Never run `prisma migrate deploy` against production from here.** Production picks the migration up on its next deploy via the `start:migrate` script. Applying it by hand is not part of this plan.

A `globalSetup` guard in `test/jest-e2e.json` (`test/guard-local-db.ts`) refuses to start the e2e suite unless `DATABASE_URL` resolves to a local host. It has been verified in both directions: it blocks the production host and passes `localhost`. If you see `Refusing to run the e2e suite against ...`, you forgot the prefix — add it, never weaken the guard.

## Task Dependency Order

Tasks are sequential: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Task 5 needs the `SaleUnit` enum generated in Task 1. Tasks 6–9 all consume `buildInvoiceItem`/`stockPiecesOf` from Task 5.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `test/guard-local-db.ts` | ✅ Done | Blocks the e2e suite from running against a non-local database |
| `test/jest-e2e.json` | ✅ Done | Wires the guard in as `globalSetup` |
| `package.json` | Modify | Fix unit-test module resolution for the generated Prisma client |
| `prisma/schema.prisma` | Modify | Carton columns + `SaleUnit` enum |
| `prisma/migrations/<ts>_add_carton_sales/migration.sql` | Create | Additive-only DDL |
| `src/modules/product/carton.util.ts` | Create | Carton group validation + derived-value arithmetic |
| `src/modules/product/carton.util.spec.ts` | Create | Unit tests for the above |
| `src/modules/product/dto/create-product.dto.ts` | Modify | 4 optional carton fields |
| `src/modules/product/dto/update-product.dto.ts` | Modify | 3 nullable carton fields |
| `src/modules/product/product.service.ts` | Modify | Derive stock + wholesalePrice on create/update |
| `src/modules/invoice/invoice-item.util.ts` | Create | Line pricing + stock-pieces resolution |
| `src/modules/invoice/invoice-item.util.spec.ts` | Create | Unit tests for the above |
| `src/modules/invoice/dto/create-invoice.dto.ts` | Modify | `saleUnit` on the line |
| `src/modules/invoice/dto/update-invoice.dto.ts` | Modify | `saleUnit` on the line |
| `src/modules/invoice/invoice.service.ts` | Modify | Carton-aware pricing, deduction, restore, response |
| `src/modules/customer/customer.service.ts` | Modify | Expose new line fields in customer history |
| `src/modules/sync/dto/sync-push.dto.ts` | Modify | `saleUnit` + `stockQuantity` on offline lines |
| `src/modules/sync/sync.service.ts` | Modify | Deduct pieces, not cartons, on offline push |
| `test/carton-sales.e2e-spec.ts` | Create | e2e coverage, one describe block per task |
| `docs/API_CHANGES_FOR_FRONTEND.md` | Modify | Frontend handover notes |

---

### Task 1: Foundation — jest config, schema, migration

**Files:**
- Modify: `package.json` (the `jest` block)
- Modify: `prisma/schema.prisma:80-103` (Product), `prisma/schema.prisma:185-203` (InvoiceItem)
- Create: `prisma/migrations/<timestamp>_add_carton_sales/migration.sql`
- Create: `test/carton-sales.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `SaleUnit` enum (`'UNIT' | 'CARTON'`) exported from `generated/prisma/client`; `Product.piecesPerCarton: number | null`, `Product.cartonPurchasePrice: Prisma.Decimal | null`, `Product.cartonSalePrice: Prisma.Decimal | null`; `InvoiceItem.saleUnit: SaleUnit`, `InvoiceItem.stockQuantity: number | null`. Also the `bootstrap()` / `teardown()` / `Ctx` test helpers used by every later e2e task.

- [ ] **Step 1: Fix unit-test module resolution**

The `jest` block in `package.json` cannot resolve `generated/prisma/client` — verified by running a probe spec, which failed with `Cannot find module 'generated/prisma/client'`. The e2e config already carries the fix; mirror it. Without this, every unit spec in Tasks 2 and 5 fails to even load.

In `package.json`, inside the `"jest"` object, add `modulePaths` and `moduleNameMapper` so the block reads:

```json
  "jest": {
    "moduleFileExtensions": [
      "js",
      "json",
      "ts"
    ],
    "rootDir": "src",
    "modulePaths": [
      "<rootDir>/.."
    ],
    "moduleNameMapper": {
      "^(\\.{1,2}/.*)\\.js$": "$1"
    },
    "testRegex": ".*\\.spec\\.ts$",
    "transform": {
      "^.+\\.(t|j)s$": "ts-jest"
    },
    "collectCoverageFrom": [
      "**/*.(t|j)s"
    ],
    "coverageDirectory": "../coverage",
    "testEnvironment": "node"
  }
```

- [ ] **Step 2: Verify the existing unit tests still pass**

Run: `npm test`
Expected: PASS — 2 suites (`user.controller.spec.ts`, `user.service.spec.ts`), no failures.

- [ ] **Step 3: Add the carton fields to the Prisma schema**

In `prisma/schema.prisma`, add the enum immediately above `model InvoiceItem`:

```prisma
// Whether an invoice line was sold as a loose piece or as a whole carton.
// Lines created before carton support existed are all piece sales, which is
// what the column default gives them.
enum SaleUnit {
  UNIT
  CARTON
}
```

In `model Product`, after the `minStock` line, add:

```prisma
  // Carton definition — all three are set together or all left NULL.
  // NULL across the board means "this product is not sold by the carton",
  // which is every product that existed before this migration.
  piecesPerCarton     Int?
  cartonPurchasePrice Decimal? @db.Decimal(10, 2)
  cartonSalePrice     Decimal? @db.Decimal(10, 2)
```

In `model InvoiceItem`, after the `total` line, add:

```prisma
  // Historical snapshot of how this line was sold. `quantity` is counted in
  // `saleUnit`s (pieces or cartons); `stockQuantity` is always in pieces and
  // is the amount the stock ledger moved by.
  //
  // stockQuantity is NULLable rather than backfilled: its correct historical
  // value is per-row (= quantity), which no constant default can express, and
  // backfilling would mean writing to every existing line on production.
  // Read it through stockPiecesOf() in invoice-item.util.ts.
  saleUnit      SaleUnit @default(UNIT)
  stockQuantity Int?
```

- [ ] **Step 4: Generate the migration without applying it**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npx prisma migrate dev --create-only --name add_carton_sales`
Expected: prints the path of a new folder under `prisma/migrations/` and does **not** apply it.

- [ ] **Step 5: Review and annotate the generated SQL**

Open the generated `migration.sql`. Confirm it contains **only** `CREATE TYPE` and `ALTER TABLE ... ADD COLUMN` statements. If it contains any `UPDATE`, `DROP`, `SET NOT NULL`, or index rebuild, **stop and report** — that means the schema edit drifted from the plan.

Replace its contents with this annotated version (matching the commented style of `prisma/migrations/20260525150000_add_customer_client_idempotency_key/migration.sql`):

```sql
-- Carton sales support. Every statement is additive: no existing row is read,
-- rewritten, or newly constrained, so live store data is untouched.

-- Sale unit for an invoice line.
CREATE TYPE "SaleUnit" AS ENUM ('UNIT', 'CARTON');

-- Carton definition on the product. All three are NULL for every product that
-- already exists, which reads as "not sold by the carton".
ALTER TABLE "products" ADD COLUMN "piecesPerCarton"     INTEGER;
ALTER TABLE "products" ADD COLUMN "cartonPurchasePrice" DECIMAL(10,2);
ALTER TABLE "products" ADD COLUMN "cartonSalePrice"     DECIMAL(10,2);

-- A constant DEFAULT is metadata-only in PostgreSQL 11+, so this does NOT
-- rewrite invoice_items. Every existing line reads as 'UNIT'.
ALTER TABLE "invoice_items"
  ADD COLUMN "saleUnit" "SaleUnit" NOT NULL DEFAULT 'UNIT';

-- Pieces moved on the stock ledger by this line. Deliberately NULLable rather
-- than backfilled: the correct historical value is per-row (= quantity), which
-- no constant default can express, and a backfill would mean an UPDATE across
-- every existing invoice line on production. stockPiecesOf() in
-- invoice-item.util.ts falls back to `quantity` for these legacy rows.
ALTER TABLE "invoice_items" ADD COLUMN "stockQuantity" INTEGER;
```

- [ ] **Step 6: Apply the migration and regenerate the client**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npx prisma migrate dev`
Expected: applies `add_carton_sales`, then runs `prisma generate`. `generated/prisma/client` now exports `SaleUnit`.

- [ ] **Step 7: Write the backward-compatibility e2e test**

This is the regression gate for the whole plan: it proves that the pre-carton request shapes and the pre-carton stored rows still behave identically.

Create `test/carton-sales.e2e-spec.ts`:

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
 * Carton sales (e2e).
 *
 * Same isolation pattern as ledger-integrity.e2e-spec.ts: each describe block
 * gets its own throwaway store (`carton-test-*` subdomain) and tears it down
 * in afterAll, so a crash leaves a recognisable footprint.
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

  const subdomain = `carton-test-${randomUUID().slice(0, 8)}`;
  const store = await db.store.create({
    data: { name: `Carton Test ${subdomain}`, subdomain, status: 'APPROVED' },
  });
  const user = await db.user.create({
    data: {
      username: `tester-${subdomain}`,
      email: `${subdomain}@carton.test`,
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

describe('Carton sales — backward compatibility', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('creates a product with no carton fields — carton columns stay NULL', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Legacy Product', price: 10, wholesalePrice: 6, stock: 40 });

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(40);
    expect(Number(res.body.wholesalePrice)).toBe(6);
    expect(res.body.piecesPerCarton).toBeNull();
    expect(res.body.cartonPurchasePrice).toBeNull();
    expect(res.body.cartonSalePrice).toBeNull();
  });

  it('creates an invoice with no saleUnit — line defaults to UNIT and deducts pieces', async () => {
    const product = await ctx.db.product.create({
      data: {
        name: 'Legacy Sale',
        price: new Prisma.Decimal(10),
        wholesalePrice: new Prisma.Decimal(6),
        stock: 40,
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 3 }] });

    expect(res.status).toBe(201);

    const line = await ctx.db.invoiceItem.findFirst({
      where: { invoiceId: res.body.id },
    });
    expect(line!.saleUnit).toBe('UNIT');

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(37);
  });

  it('restores stock correctly when deleting a pre-migration line (stockQuantity NULL)', async () => {
    // Simulate a row written before this migration: saleUnit defaulted, and
    // stockQuantity forced back to NULL exactly as the legacy data looks.
    const product = await ctx.db.product.create({
      data: {
        name: 'Legacy Restore',
        price: new Prisma.Decimal(10),
        wholesalePrice: new Prisma.Decimal(6),
        stock: 37,
        storeId: ctx.storeId,
      },
    });
    const invoice = await ctx.db.invoice.create({
      data: {
        number: 90001,
        total: new Prisma.Decimal(30),
        paid: new Prisma.Decimal(30),
        remaining: new Prisma.Decimal(0),
        paymentMethod: 'CASH',
        storeId: ctx.storeId,
        items: {
          create: {
            productName: 'Legacy Restore',
            price: new Prisma.Decimal(10),
            unitCost: new Prisma.Decimal(6),
            quantity: 3,
            total: new Prisma.Decimal(30),
            productId: product.id,
          },
        },
      },
      include: { items: true },
    });
    await ctx.db.$executeRaw`
      UPDATE invoice_items SET "stockQuantity" = NULL WHERE "invoiceId" = ${invoice.id}
    `;

    const res = await request(ctx.server)
      .delete(`/api/invoices/${invoice.id}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    expect([200, 204]).toContain(res.status);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(40); // 37 + 3, from the quantity fallback
  });
});
```

- [ ] **Step 8: Run the backward-compatibility test**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 3 tests. All three exercise only pre-existing code paths, so they must pass before any behaviour changes.

- [ ] **Step 9: Commit**

```bash
git add package.json prisma/schema.prisma prisma/migrations test/carton-sales.e2e-spec.ts
git commit -m "feat(carton): add carton columns and SaleUnit enum, additive migration only"
```

---

### Task 2: `carton.util.ts` — carton group validation and derived values

**Files:**
- Create: `src/modules/product/carton.util.ts`
- Test: `src/modules/product/carton.util.spec.ts`

**Interfaces:**
- Consumes: `Prisma` from `generated/prisma/client` (Task 1)
- Produces:
  - `type CartonGroup = { piecesPerCarton?: number | null; cartonPurchasePrice?: number | Prisma.Decimal | null; cartonSalePrice?: number | Prisma.Decimal | null }`
  - `isCartonGroupComplete(g: CartonGroup): boolean`
  - `assertCartonGroupValid(g: CartonGroup): void` — throws `BadRequestException`
  - `unitCostFromCarton(cartonPurchasePrice: number | Prisma.Decimal, piecesPerCarton: number): Prisma.Decimal`
  - `openingStockFromCartons(cartonCount: number, piecesPerCarton: number, loosePieces: number): number`

- [ ] **Step 1: Write the failing unit test**

Create `src/modules/product/carton.util.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import {
  assertCartonGroupValid,
  isCartonGroupComplete,
  openingStockFromCartons,
  unitCostFromCarton,
} from './carton.util';

describe('isCartonGroupComplete', () => {
  it('is true only when all three fields are present', () => {
    expect(
      isCartonGroupComplete({
        piecesPerCarton: 24,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      }),
    ).toBe(true);
  });

  it('is false when any field is missing', () => {
    expect(
      isCartonGroupComplete({ piecesPerCarton: 24, cartonPurchasePrice: 48 }),
    ).toBe(false);
    expect(isCartonGroupComplete({})).toBe(false);
  });
});

describe('assertCartonGroupValid', () => {
  it('accepts a complete group', () => {
    expect(() =>
      assertCartonGroupValid({
        piecesPerCarton: 24,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      }),
    ).not.toThrow();
  });

  it('accepts an entirely empty group', () => {
    expect(() => assertCartonGroupValid({})).not.toThrow();
    expect(() =>
      assertCartonGroupValid({
        piecesPerCarton: null,
        cartonPurchasePrice: null,
        cartonSalePrice: null,
      }),
    ).not.toThrow();
  });

  it('rejects a partial group', () => {
    expect(() =>
      assertCartonGroupValid({ piecesPerCarton: 24, cartonPurchasePrice: 48 }),
    ).toThrow(BadRequestException);
    expect(() => assertCartonGroupValid({ cartonSalePrice: 60 })).toThrow(
      BadRequestException,
    );
  });

  it('treats a Decimal-valued group (a row read back from the DB) as complete', () => {
    expect(() =>
      assertCartonGroupValid({
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
      }),
    ).not.toThrow();
  });
});

describe('unitCostFromCarton', () => {
  it('divides the carton purchase price by the carton size', () => {
    expect(unitCostFromCarton(48, 24).equals(2)).toBe(true);
  });

  it('accepts a Decimal purchase price', () => {
    expect(unitCostFromCarton(new Prisma.Decimal(48), 24).equals(2)).toBe(true);
  });

  it('rounds to 2 decimal places to match the DECIMAL(10,2) column', () => {
    // 100 / 3 = 33.3333... — must not carry more precision than the column.
    expect(unitCostFromCarton(100, 3).toFixed(2)).toBe('33.33');
  });
});

describe('openingStockFromCartons', () => {
  it('adds loose pieces on top of the carton pieces', () => {
    expect(openingStockFromCartons(2, 24, 5)).toBe(53);
  });

  it('handles zero loose pieces', () => {
    expect(openingStockFromCartons(2, 24, 0)).toBe(48);
  });

  it('handles zero cartons', () => {
    expect(openingStockFromCartons(0, 24, 7)).toBe(7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- carton.util`
Expected: FAIL — `Cannot find module './carton.util'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/product/carton.util.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';

/**
 * The three fields that together make a product sellable by the carton.
 * Values may arrive as numbers (from a DTO) or as Decimals (from a DB row),
 * so both are accepted — every check here is presence-only.
 */
export type CartonGroup = {
  piecesPerCarton?: number | null;
  cartonPurchasePrice?: number | Prisma.Decimal | null;
  cartonSalePrice?: number | Prisma.Decimal | null;
};

export function isCartonGroupComplete(g: CartonGroup): boolean {
  return (
    g.piecesPerCarton != null &&
    g.cartonPurchasePrice != null &&
    g.cartonSalePrice != null
  );
}

function isCartonGroupEmpty(g: CartonGroup): boolean {
  return (
    g.piecesPerCarton == null &&
    g.cartonPurchasePrice == null &&
    g.cartonSalePrice == null
  );
}

/**
 * All three or none.
 *
 * A partial group (pieces + purchase price, no sale price) looks like a carton
 * product in the UI but fails at the first carton sale, so it is rejected at
 * write time rather than left to surface a week later.
 */
export function assertCartonGroupValid(g: CartonGroup): void {
  if (!isCartonGroupComplete(g) && !isCartonGroupEmpty(g)) {
    throw new BadRequestException(
      'بيانات الكرتونة غير مكتملة — يجب إرسال عدد القطع في الكرتونة وسعر شراء الكرتونة وسعر بيع الكرتونة معاً، أو عدم إرسال أي منها',
    );
  }
}

/**
 * Cost of a single piece, derived from the carton purchase price.
 *
 * Rounded to 2dp to match the DECIMAL(10,2) column — a carton size that does
 * not divide evenly leaves a sub-cent drift on piece sales, which is accepted
 * (see spec §4.3).
 */
export function unitCostFromCarton(
  cartonPurchasePrice: number | Prisma.Decimal,
  piecesPerCarton: number,
): Prisma.Decimal {
  return new Prisma.Decimal(cartonPurchasePrice)
    .dividedBy(piecesPerCarton)
    .toDecimalPlaces(2);
}

/**
 * Opening stock in PIECES.
 *
 * `loosePieces` is the "الكمية" field from the product form. In carton mode the
 * owner uses it for pieces held outside a full carton, so it adds on top of the
 * carton pieces rather than replacing them.
 */
export function openingStockFromCartons(
  cartonCount: number,
  piecesPerCarton: number,
  loosePieces: number,
): number {
  return cartonCount * piecesPerCarton + loosePieces;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- carton.util`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/product/carton.util.ts src/modules/product/carton.util.spec.ts
git commit -m "feat(carton): add carton group validation and derived-value helpers"
```

---

### Task 3: Product create accepts carton data

**Files:**
- Modify: `src/modules/product/dto/create-product.dto.ts:50-66`
- Modify: `src/modules/product/product.service.ts:53-75`
- Test: `test/carton-sales.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `assertCartonGroupValid`, `isCartonGroupComplete`, `unitCostFromCarton`, `openingStockFromCartons` (Task 2)
- Produces: `POST /api/products` accepting `piecesPerCarton`, `cartonCount`, `cartonPurchasePrice`, `cartonSalePrice`

- [ ] **Step 1: Write the failing e2e test**

Append to `test/carton-sales.e2e-spec.ts`:

```ts
describe('Carton sales — product create', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('derives stock from cartons plus loose pieces, and unit cost from the carton price', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'Pepsi 330ml',
        price: 3,
        stock: 5, // loose pieces
        piecesPerCarton: 24,
        cartonCount: 2,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      });

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(53); // 2 × 24 + 5
    expect(Number(res.body.wholesalePrice)).toBe(2); // 48 / 24
    expect(Number(res.body.price)).toBe(3); // untouched
    expect(res.body.piecesPerCarton).toBe(24);
    expect(Number(res.body.cartonPurchasePrice)).toBe(48);
    expect(Number(res.body.cartonSalePrice)).toBe(60);
  });

  it('ignores a client-sent wholesalePrice in carton mode', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'Ignored Wholesale',
        price: 3,
        wholesalePrice: 999,
        piecesPerCarton: 24,
        cartonCount: 1,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      });

    expect(res.status).toBe(201);
    expect(Number(res.body.wholesalePrice)).toBe(2);
    expect(res.body.stock).toBe(24);
  });

  it('defaults stock to the carton pieces when no loose pieces are sent', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'No Loose Pieces',
        price: 3,
        piecesPerCarton: 24,
        cartonCount: 2,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      });

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(48);
  });

  it('rejects a partial carton group', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        name: 'Partial Carton',
        price: 3,
        piecesPerCarton: 24,
        cartonPurchasePrice: 48,
      });

    expect(res.status).toBe(400);
  });

  it('rejects cartonCount without piecesPerCarton', async () => {
    const res = await request(ctx.server)
      .post('/api/products')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Orphan Count', price: 3, cartonCount: 2 });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: FAIL — the new tests return 400 `property piecesPerCarton should not exist` (`forbidNonWhitelisted` rejects fields not on the DTO).

- [ ] **Step 3: Add the carton fields to `CreateProductDto`**

In `src/modules/product/dto/create-product.dto.ts`, replace the `stock` property's `@ApiPropertyOptional` description and append the four new fields after `minStock`:

```ts
  @ApiPropertyOptional({
    example: 100,
    default: 0,
    description:
      'كمية المخزون الابتدائية بالقطع. في وضع الكرتونة تعني القطع الفرط الإضافية ' +
      'وتُضاف فوق قطع الكراتين',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  stock?: number;
```

```ts
  @ApiPropertyOptional({
    example: 24,
    description:
      'عدد القطع في الكرتونة — يُرسل مع سعر شراء الكرتونة وسعر بيع الكرتونة معاً أو لا يُرسل أي منها',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  piecesPerCarton?: number;

  @ApiPropertyOptional({
    example: 2,
    description:
      'عدد الكراتين المشتراة — يُستخدم لحساب المخزون الابتدائي فقط ولا يُخزَّن. ' +
      'المخزون = (عدد الكراتين × عدد القطع في الكرتونة) + الكمية المرسلة كقطع فرط',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  cartonCount?: number;

  @ApiPropertyOptional({
    example: 48,
    description: 'سعر شراء الكرتونة — يُشتق منه سعر الجملة للقطعة الواحدة',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  cartonPurchasePrice?: number;

  @ApiPropertyOptional({
    example: 60,
    description: 'سعر بيع الكرتونة الكاملة',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  cartonSalePrice?: number;
```

- [ ] **Step 4: Derive stock and wholesalePrice in `ProductService.create`**

In `src/modules/product/product.service.ts`, add to the imports:

```ts
import { BadRequestException } from '@nestjs/common';
import {
  assertCartonGroupValid,
  isCartonGroupComplete,
  openingStockFromCartons,
  unitCostFromCarton,
} from './carton.util';
```

(`BadRequestException` joins the existing `@nestjs/common` import list.)

Replace the whole `create` method body with:

```ts
  async create(sid: string, dto: CreateProductDto): Promise<Product> {

    if (dto.barcode) {
      await this.assertBarcodeUnique(sid, dto.barcode);
    }

    assertCartonGroupValid(dto);

    if (dto.cartonCount != null && dto.piecesPerCarton == null) {
      throw new BadRequestException(
        'عدد الكراتين يتطلب تحديد عدد القطع في الكرتونة',
      );
    }

    // In carton mode the server owns both derived columns. `stock` from the
    // request means loose pieces held outside a full carton, so it adds on
    // top; `wholesalePrice` is always recomputed so per-piece profit can never
    // drift away from the carton figures the owner actually entered.
    const isCarton = isCartonGroupComplete(dto);
    const stock = isCarton
      ? openingStockFromCartons(
          dto.cartonCount ?? 0,
          dto.piecesPerCarton!,
          dto.stock ?? 0,
        )
      : dto.stock ?? 0;
    const wholesalePrice = isCarton
      ? unitCostFromCarton(dto.cartonPurchasePrice!, dto.piecesPerCarton!)
      : dto.wholesalePrice ?? 0;

    const created = await this.db.product.create({
      data: {
        name: dto.name,
        barcode: dto.barcode ?? null,
        price: dto.price,
        wholesalePrice,
        stock,
        minStock: dto.minStock ?? 5,
        piecesPerCarton: dto.piecesPerCarton ?? null,
        cartonPurchasePrice: dto.cartonPurchasePrice ?? null,
        cartonSalePrice: dto.cartonSalePrice ?? null,
        storeId: sid,
      },
    });

    void this.cacheInvalidator.invalidateStoreData(sid, {
      barcode: created.barcode,
    });
    return created;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 8 tests (3 from Task 1 + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/modules/product/dto/create-product.dto.ts src/modules/product/product.service.ts test/carton-sales.e2e-spec.ts
git commit -m "feat(carton): derive stock and unit cost when creating a carton product"
```

---

### Task 4: Product update accepts carton data

**Files:**
- Modify: `src/modules/product/dto/update-product.dto.ts:59-69`
- Modify: `src/modules/product/product.service.ts` (the `update` method)
- Test: `test/carton-sales.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `assertCartonGroupValid`, `unitCostFromCarton` (Task 2)
- Produces: `PATCH /api/products/:id` accepting `piecesPerCarton`, `cartonPurchasePrice`, `cartonSalePrice` (each nullable to clear carton mode). `cartonCount` is deliberately **not** accepted.

- [ ] **Step 1: Write the failing e2e test**

Append to `test/carton-sales.e2e-spec.ts`:

```ts
describe('Carton sales — product update', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  async function makePlainProduct(name: string, stock = 30) {
    return ctx.db.product.create({
      data: {
        name,
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(1.5),
        stock,
        storeId: ctx.storeId,
      },
    });
  }

  it('converts an existing plain product into a carton product without touching stock', async () => {
    const product = await makePlainProduct('Convert Me');

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ piecesPerCarton: 24, cartonPurchasePrice: 48, cartonSalePrice: 60 });

    expect(res.status).toBe(200);
    expect(res.body.piecesPerCarton).toBe(24);
    expect(Number(res.body.wholesalePrice)).toBe(2); // recomputed from 48 / 24
    expect(res.body.stock).toBe(30); // NOT recomputed — pieces may already be sold
  });

  it('recomputes wholesalePrice when the carton purchase price changes', async () => {
    const product = await ctx.db.product.create({
      data: {
        name: 'Reprice',
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock: 48,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ cartonPurchasePrice: 72 });

    expect(res.status).toBe(200);
    expect(Number(res.body.wholesalePrice)).toBe(3); // 72 / 24
  });

  it('clears carton mode when all three fields are set to null', async () => {
    const product = await ctx.db.product.create({
      data: {
        name: 'Clear Carton',
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock: 48,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        piecesPerCarton: null,
        cartonPurchasePrice: null,
        cartonSalePrice: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.piecesPerCarton).toBeNull();
    expect(res.body.cartonPurchasePrice).toBeNull();
    expect(res.body.cartonSalePrice).toBeNull();
  });

  it('rejects an update that would leave a partial carton group', async () => {
    const product = await makePlainProduct('Partial Update');

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ piecesPerCarton: 24 });

    expect(res.status).toBe(400);
  });

  it('rejects cartonCount on update — stock is never recomputed from cartons', async () => {
    const product = await makePlainProduct('No Carton Count');

    const res = await request(ctx.server)
      .patch(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ cartonCount: 5 });

    expect(res.status).toBe(400); // forbidNonWhitelisted — not on the DTO
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: FAIL — the carton fields are rejected as unknown properties on `UpdateProductDto`.

- [ ] **Step 3: Add nullable carton fields to `UpdateProductDto`**

In `src/modules/product/dto/update-product.dto.ts`, append after `isActive`:

```ts
  @ApiPropertyOptional({
    example: 24,
    nullable: true,
    description:
      'عدد القطع في الكرتونة — أرسل null في الحقول الثلاثة معاً لإلغاء وضع الكرتونة',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  piecesPerCarton?: number | null;

  @ApiPropertyOptional({
    example: 48,
    nullable: true,
    description: 'سعر شراء الكرتونة — تغييره يعيد حساب سعر الجملة للقطعة',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  cartonPurchasePrice?: number | null;

  @ApiPropertyOptional({
    example: 60,
    nullable: true,
    description: 'سعر بيع الكرتونة الكاملة',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  cartonSalePrice?: number | null;
```

`@IsOptional()` in class-validator skips validation for both `undefined` and `null`, so an explicit `null` passes through to the service and clears the column.

- [ ] **Step 4: Handle the carton fields in `ProductService.update`**

In `src/modules/product/product.service.ts`, replace the whole `update` method with:

```ts
  async update(sid: string, id: string, dto: UpdateProductDto): Promise<Product> {
    // Read existing row to learn the old barcode — we need to invalidate it
    // explicitly even if `dto.barcode` is undefined (any update can affect
    // the cached row's stock/price/isActive fields). The carton columns come
    // along because the group must be validated against the MERGED state.
    const existing = await this.db.product.findFirst({
      where: { id, storeId: sid },
      select: {
        id: true,
        barcode: true,
        piecesPerCarton: true,
        cartonPurchasePrice: true,
        cartonSalePrice: true,
      },
    });
    if (!existing) throw new NotFoundException('Product not found');

    if (dto.barcode) {
      await this.assertBarcodeUnique(sid, dto.barcode, id);
    }

    // A PATCH that touches only one carton field must still leave a complete
    // (or entirely empty) group behind, so validate what the row will LOOK
    // like after the merge rather than what the request carries.
    const merged = {
      piecesPerCarton:
        dto.piecesPerCarton !== undefined
          ? dto.piecesPerCarton
          : existing.piecesPerCarton,
      cartonPurchasePrice:
        dto.cartonPurchasePrice !== undefined
          ? dto.cartonPurchasePrice
          : existing.cartonPurchasePrice,
      cartonSalePrice:
        dto.cartonSalePrice !== undefined
          ? dto.cartonSalePrice
          : existing.cartonSalePrice,
    };
    assertCartonGroupValid(merged);

    const data: Prisma.ProductUpdateInput = {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.barcode !== undefined && { barcode: dto.barcode }),
      ...(dto.price !== undefined && { price: dto.price }),
      ...(dto.stock !== undefined && { stock: dto.stock }),
      ...(dto.minStock !== undefined && { minStock: dto.minStock }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      ...(dto.piecesPerCarton !== undefined && {
        piecesPerCarton: dto.piecesPerCarton,
      }),
      ...(dto.cartonPurchasePrice !== undefined && {
        cartonPurchasePrice: dto.cartonPurchasePrice,
      }),
      ...(dto.cartonSalePrice !== undefined && {
        cartonSalePrice: dto.cartonSalePrice,
      }),
    };

    // Stock is deliberately NOT recomputed from cartons here — pieces may
    // already have been sold out of those cartons. wholesalePrice, on the
    // other hand, is a pure function of the carton figures, so it is
    // recomputed whenever either input moves.
    const cartonInputsTouched =
      dto.piecesPerCarton !== undefined || dto.cartonPurchasePrice !== undefined;
    if (
      cartonInputsTouched &&
      merged.piecesPerCarton != null &&
      merged.cartonPurchasePrice != null
    ) {
      data.wholesalePrice = unitCostFromCarton(
        merged.cartonPurchasePrice,
        merged.piecesPerCarton,
      );
    } else if (dto.wholesalePrice !== undefined) {
      data.wholesalePrice = dto.wholesalePrice;
    }

    const updated = await this.db.product.update({ where: { id }, data });

    // Invalidate both the old and (possibly) new barcode entries.
    void this.cacheInvalidator.invalidateProductBarcode(sid, existing.barcode);
    if (updated.barcode && updated.barcode !== existing.barcode) {
      void this.cacheInvalidator.invalidateProductBarcode(sid, updated.barcode);
    }
    void this.cacheInvalidator.invalidateSyncInit(sid);
    return updated;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 13 tests.

- [ ] **Step 6: Verify the unit tests and build still pass**

Run: `npm test && npm run build`
Expected: PASS, then a clean `nest build` with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/product/dto/update-product.dto.ts src/modules/product/product.service.ts test/carton-sales.e2e-spec.ts
git commit -m "feat(carton): allow converting existing products to carton products"
```

---

### Task 5: `invoice-item.util.ts` — line pricing and stock resolution

**Files:**
- Create: `src/modules/invoice/invoice-item.util.ts`
- Test: `src/modules/invoice/invoice-item.util.spec.ts`

**Interfaces:**
- Consumes: `Prisma`, `SaleUnit` from `generated/prisma/client` (Task 1)
- Produces:
  - `type PricingProduct` — the product columns needed to price a line
  - `type BuiltInvoiceItem` — `{ productName: string; barcode: string | null; price: Prisma.Decimal; unitCost: Prisma.Decimal; quantity: number; total: Prisma.Decimal; saleUnit: SaleUnit; stockQuantity: number; productId: string }`
  - `buildInvoiceItem(product: PricingProduct, quantity: number, saleUnit?: SaleUnit): BuiltInvoiceItem`
  - `stockPiecesOf(item: { quantity: number; stockQuantity: number | null }): number`

- [ ] **Step 1: Write the failing unit test**

Create `src/modules/invoice/invoice-item.util.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import {
  buildInvoiceItem,
  stockPiecesOf,
  type PricingProduct,
} from './invoice-item.util';

const cartonProduct: PricingProduct = {
  id: 'p1',
  name: 'Pepsi 330ml',
  barcode: '6001',
  price: new Prisma.Decimal(3),
  wholesalePrice: new Prisma.Decimal(2),
  piecesPerCarton: 24,
  cartonPurchasePrice: new Prisma.Decimal(48),
  cartonSalePrice: new Prisma.Decimal(60),
};

const plainProduct: PricingProduct = {
  id: 'p2',
  name: 'Loose Item',
  barcode: null,
  price: new Prisma.Decimal(10),
  wholesalePrice: new Prisma.Decimal(6),
  piecesPerCarton: null,
  cartonPurchasePrice: null,
  cartonSalePrice: null,
};

describe('buildInvoiceItem — piece sales', () => {
  it('prices from the product price and wholesale price', () => {
    const item = buildInvoiceItem(plainProduct, 3);
    expect(item.price.equals(10)).toBe(true);
    expect(item.unitCost.equals(6)).toBe(true);
    expect(item.total.equals(30)).toBe(true);
    expect(item.saleUnit).toBe('UNIT');
    expect(item.stockQuantity).toBe(3);
    expect(item.productId).toBe('p2');
    expect(item.productName).toBe('Loose Item');
    expect(item.barcode).toBeNull();
  });

  it('treats an explicit UNIT the same as an omitted saleUnit', () => {
    expect(buildInvoiceItem(plainProduct, 3, 'UNIT')).toEqual(
      buildInvoiceItem(plainProduct, 3),
    );
  });

  it('sells pieces of a carton product at the piece price', () => {
    const item = buildInvoiceItem(cartonProduct, 3, 'UNIT');
    expect(item.price.equals(3)).toBe(true);
    expect(item.unitCost.equals(2)).toBe(true);
    expect(item.stockQuantity).toBe(3);
  });
});

describe('buildInvoiceItem — carton sales', () => {
  it('prices from the carton prices and deducts whole cartons in pieces', () => {
    const item = buildInvoiceItem(cartonProduct, 2, 'CARTON');
    expect(item.price.equals(60)).toBe(true);
    expect(item.unitCost.equals(48)).toBe(true);
    expect(item.total.equals(120)).toBe(true); // 60 × 2 cartons
    expect(item.quantity).toBe(2); // cartons
    expect(item.stockQuantity).toBe(48); // 2 × 24 pieces
    expect(item.saleUnit).toBe('CARTON');
  });

  it('rejects a carton sale of a product with no carton data', () => {
    expect(() => buildInvoiceItem(plainProduct, 1, 'CARTON')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a carton sale when the group is incomplete', () => {
    expect(() =>
      buildInvoiceItem(
        { ...cartonProduct, cartonSalePrice: null },
        1,
        'CARTON',
      ),
    ).toThrow(BadRequestException);
  });
});

describe('stockPiecesOf', () => {
  it('uses stockQuantity when present', () => {
    expect(stockPiecesOf({ quantity: 2, stockQuantity: 48 })).toBe(48);
  });

  it('falls back to quantity for pre-migration rows', () => {
    expect(stockPiecesOf({ quantity: 3, stockQuantity: null })).toBe(3);
  });

  it('does not treat a legitimate zero as missing', () => {
    expect(stockPiecesOf({ quantity: 5, stockQuantity: 0 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- invoice-item.util`
Expected: FAIL — `Cannot find module './invoice-item.util'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/invoice/invoice-item.util.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { Prisma, type SaleUnit } from 'generated/prisma/client';

/** The product columns needed to price an invoice line. */
export type PricingProduct = {
  id: string;
  name: string;
  barcode: string | null;
  price: Prisma.Decimal;
  wholesalePrice: Prisma.Decimal;
  piecesPerCarton: number | null;
  cartonPurchasePrice: Prisma.Decimal | null;
  cartonSalePrice: Prisma.Decimal | null;
};

/** A fully-priced invoice line, shaped for a Prisma nested create. */
export type BuiltInvoiceItem = {
  productName: string;
  barcode: string | null;
  price: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  quantity: number;
  total: Prisma.Decimal;
  saleUnit: SaleUnit;
  stockQuantity: number;
  productId: string;
};

/**
 * Prices one line from the DB product row. Client-sent prices and carton
 * sizes are never consulted — the caller passes only a product id, a
 * quantity, and the unit being sold.
 *
 * `quantity` is counted in `saleUnit`s (pieces or cartons). `stockQuantity`
 * is always in pieces and is what the stock ledger moves by; storing it on
 * the line freezes the carton size at sale time, so later edits to
 * `piecesPerCarton` cannot corrupt an old invoice's stock restore.
 */
export function buildInvoiceItem(
  product: PricingProduct,
  quantity: number,
  saleUnit: SaleUnit = 'UNIT',
): BuiltInvoiceItem {
  if (saleUnit === 'CARTON') {
    if (
      product.piecesPerCarton == null ||
      product.cartonSalePrice == null ||
      product.cartonPurchasePrice == null
    ) {
      throw new BadRequestException(
        `المنتج "${product.name}" غير معرّف كمنتج كرتونة — لا يمكن بيعه بالكرتونة`,
      );
    }
    const price = new Prisma.Decimal(product.cartonSalePrice);
    return {
      productName: product.name,
      barcode: product.barcode,
      price,
      unitCost: new Prisma.Decimal(product.cartonPurchasePrice),
      quantity,
      total: price.times(quantity),
      saleUnit: 'CARTON',
      stockQuantity: quantity * product.piecesPerCarton,
      productId: product.id,
    };
  }

  const price = new Prisma.Decimal(product.price);
  return {
    productName: product.name,
    barcode: product.barcode,
    price,
    unitCost: new Prisma.Decimal(product.wholesalePrice),
    quantity,
    total: price.times(quantity),
    saleUnit: 'UNIT',
    stockQuantity: quantity,
    productId: product.id,
  };
}

/**
 * Pieces to move on the stock ledger for a line already stored in the DB.
 *
 * Lines written before carton support have `stockQuantity = NULL` and were
 * always piece sales, so `quantity` is their correct piece count. Every
 * restore and deduct path MUST go through this helper — reading
 * `stockQuantity` directly silently restores the wrong amount for every
 * legacy invoice.
 */
export function stockPiecesOf(item: {
  quantity: number;
  stockQuantity: number | null;
}): number {
  return item.stockQuantity ?? item.quantity;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- invoice-item.util`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/invoice/invoice-item.util.ts src/modules/invoice/invoice-item.util.spec.ts
git commit -m "feat(carton): add invoice line pricing and stock-pieces helpers"
```

---

### Task 6: Invoice create sells cartons

**Files:**
- Modify: `src/modules/invoice/dto/create-invoice.dto.ts:20-32`
- Modify: `src/modules/invoice/invoice.service.ts:89-104` (item building), `:174-200` (stock deduction)
- Test: `test/carton-sales.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `buildInvoiceItem` (Task 5)
- Produces: `POST /api/invoices` accepting `items[].saleUnit`

- [ ] **Step 1: Write the failing e2e test**

Append to `test/carton-sales.e2e-spec.ts`:

```ts
describe('Carton sales — invoice create', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  async function makeCartonProduct(name: string, stock: number) {
    return ctx.db.product.create({
      data: {
        name,
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });
  }

  it('sells one carton — deducts 24 pieces and freezes the carton snapshot', async () => {
    const product = await makeCartonProduct('Carton Sale', 48);

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }],
      });

    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(60);

    const line = res.body.items[0];
    expect(line.saleUnit).toBe('CARTON');
    expect(line.stockQuantity).toBe(24);
    expect(line.quantity).toBe(1);
    expect(Number(line.price)).toBe(60);
    expect(Number(line.unitCost)).toBe(48);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(24); // 48 − 24
  });

  it('sells a carton and loose pieces of the same product as two lines', async () => {
    const product = await makeCartonProduct('Mixed Sale', 30);

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [
          { productId: product.id, quantity: 1, saleUnit: 'CARTON' },
          { productId: product.id, quantity: 3, saleUnit: 'UNIT' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    expect(Number(res.body.total)).toBe(69); // 60 + (3 × 3)

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(3); // 30 − 24 − 3
  });

  it('rejects a carton sale that exceeds stock, reporting pieces not cartons', async () => {
    const product = await makeCartonProduct('Short Stock', 20);

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }],
      });

    expect(res.status).toBe(400);
    // The message must talk in pieces — "(1) تتجاوز المخزون المتوفر (20)" would
    // read as nonsense to a cashier.
    expect(res.body.message).toContain('24');
    expect(res.body.message).toContain('20');

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(20); // rolled back
  });

  it('rejects a carton sale of a product with no carton data', async () => {
    const product = await ctx.db.product.create({
      data: {
        name: 'Not A Carton Product',
        price: new Prisma.Decimal(10),
        wholesalePrice: new Prisma.Decimal(6),
        stock: 40,
        storeId: ctx.storeId,
      },
    });

    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }],
      });

    expect(res.status).toBe(400);
  });

  it('reports carton profit correctly (carton price × cartons − carton cost × cartons)', async () => {
    const product = await makeCartonProduct('Profit Check', 48);

    await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 2, saleUnit: 'CARTON' }],
      })
      .expect(201);

    const res = await request(ctx.server)
      .get('/api/reports/daily-profit')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    // Only this store's invoices count: revenue 2 × 60, cost 2 × 48.
    expect(res.body.totalRevenue).toBe(120);
    expect(res.body.totalCost).toBe(96);
    expect(res.body.netProfit).toBe(24);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: FAIL — `saleUnit` rejected as an unknown property on `CreateInvoiceItemDto`.

- [ ] **Step 3: Add `saleUnit` to `CreateInvoiceItemDto`**

In `src/modules/invoice/dto/create-invoice.dto.ts`, change the Prisma import to:

```ts
import { PaymentMethod, SaleUnit } from 'generated/prisma/client';
```

and append to `CreateInvoiceItemDto`:

```ts
  @ApiPropertyOptional({
    enum: SaleUnit,
    example: 'UNIT',
    default: 'UNIT',
    description:
      'وحدة البيع — UNIT: قطعة (الافتراضي عند عدم الإرسال) | CARTON: كرتونة كاملة. ' +
      'عند CARTON تكون الكمية بعدد الكراتين ويُخصم من المخزون (الكمية × عدد القطع في الكرتونة)',
  })
  @IsOptional()
  @IsEnum(SaleUnit)
  saleUnit?: SaleUnit;
```

`IsOptional` and `IsEnum` are already imported in this file; `ApiPropertyOptional` is too.

- [ ] **Step 4: Price the lines through `buildInvoiceItem`**

In `src/modules/invoice/invoice.service.ts`, add the import:

```ts
import { buildInvoiceItem } from './invoice-item.util';
```

Replace the item-building block (currently the `const invoiceItems = dto.items.map(...)` at lines 89–104) with:

```ts
    // Build invoice items from the DB product rows — prices, costs and carton
    // sizes are never taken from the request. Decimal arithmetic throughout,
    // no float drift.
    const invoiceItems = dto.items.map((item) =>
      buildInvoiceItem(
        productMap.get(item.productId)!,
        item.quantity,
        item.saleUnit,
      ),
    );
```

- [ ] **Step 5: Deduct pieces instead of quantity**

Still in `create`, replace the stock-deduction loop (currently `for (const item of dto.items) { ... }` at lines 174–200) with:

```ts
        // Per-item conditional updateMany — each one is a single atomic
        // UPDATE on the row with a `stock >= pieces` predicate, so two
        // concurrent sales of the last unit can't both pass. We iterate the
        // BUILT items, not the DTO, because only they carry stockQuantity
        // (pieces) — a carton line must move 24 pieces, not 1.
        for (const item of invoiceItems) {
          const { count } = await tx.product.updateMany({
            where: {
              id: item.productId,
              storeId: sid,
              isActive: true,
              stock: { gte: item.stockQuantity },
            },
            data: { stock: { decrement: item.stockQuantity } },
          });
          if (count === 0) {
            // Diagnose why the conditional failed.
            const live = await tx.product.findFirst({
              where: { id: item.productId, storeId: sid },
              select: { stock: true, name: true, isActive: true },
            });
            if (!live || !live.isActive) {
              throw new BadRequestException(
                `المنتج "${item.productName}" غير متوفر أو معطّل`,
              );
            }
            // Always report pieces. A carton line would otherwise read
            // "الكمية المطلوبة (1) تتجاوز المخزون المتوفر (20)", which makes
            // no sense to a cashier.
            throw new BadRequestException(
              `الكمية المطلوبة (${item.stockQuantity} قطعة) من "${live.name}" تتجاوز المخزون المتوفر (${live.stock} قطعة)`,
            );
          }
        }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 18 tests. The Task 1 backward-compat block must still pass; if it does not, the piece path regressed.

- [ ] **Step 7: Commit**

```bash
git add src/modules/invoice/dto/create-invoice.dto.ts src/modules/invoice/invoice.service.ts test/carton-sales.e2e-spec.ts
git commit -m "feat(carton): sell whole cartons and deduct stock in pieces"
```

---

### Task 7: Invoice update and delete restore carton stock

**Files:**
- Modify: `src/modules/invoice/dto/update-invoice.dto.ts:20-32`
- Modify: `src/modules/invoice/invoice.service.ts` — `update` (item select, item building, restore loop, deduct loop) and `remove` (item select, restore loop)
- Test: `test/carton-sales.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `buildInvoiceItem`, `stockPiecesOf`, `BuiltInvoiceItem` (Task 5)
- Produces: `PATCH /api/invoices/:id` accepting `items[].saleUnit`

- [ ] **Step 1: Write the failing e2e test**

Append to `test/carton-sales.e2e-spec.ts`:

```ts
describe('Carton sales — invoice update and delete', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  async function makeCartonProduct(name: string, stock: number) {
    return ctx.db.product.create({
      data: {
        name,
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });
  }

  async function sellCartons(productId: string, cartons: number) {
    const res = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId, quantity: cartons, saleUnit: 'CARTON' }],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('restores full carton pieces when the invoice is deleted', async () => {
    const product = await makeCartonProduct('Delete Restore', 48);
    const invoiceId = await sellCartons(product.id, 1);

    const mid = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(mid!.stock).toBe(24);

    const res = await request(ctx.server)
      .delete(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    expect([200, 204]).toContain(res.status);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(48); // 24 restored, not 1
  });

  it('restores carton pieces and deducts the new line when items are replaced', async () => {
    const product = await makeCartonProduct('Update Swap', 48);
    const invoiceId = await sellCartons(product.id, 1); // stock 24

    const res = await request(ctx.server)
      .patch(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ items: [{ productId: product.id, quantity: 5, saleUnit: 'UNIT' }] });

    expect(res.status).toBe(200);
    expect(Number(res.body.total)).toBe(15); // 5 × 3

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(43); // 24 + 24 restored − 5 deducted
  });

  it('upgrades a piece line to a carton line on update', async () => {
    const product = await makeCartonProduct('Upgrade To Carton', 48);

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 2 }],
      });
    expect(created.status).toBe(201); // stock 46

    const res = await request(ctx.server)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }] });

    expect(res.status).toBe(200);
    expect(res.body.items[0].saleUnit).toBe('CARTON');
    expect(res.body.items[0].stockQuantity).toBe(24);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(24); // 46 + 2 restored − 24 deducted
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: FAIL — the delete test restores 1 piece instead of 24, and `saleUnit` is rejected on `UpdateInvoiceItemDto`.

- [ ] **Step 3: Add `saleUnit` to `UpdateInvoiceItemDto`**

In `src/modules/invoice/dto/update-invoice.dto.ts`, change the Prisma import to:

```ts
import { PaymentMethod, SaleUnit } from 'generated/prisma/client';
```

and append to `UpdateInvoiceItemDto`:

```ts
  @ApiPropertyOptional({
    enum: SaleUnit,
    example: 'UNIT',
    default: 'UNIT',
    description:
      'وحدة البيع — UNIT: قطعة (الافتراضي عند عدم الإرسال) | CARTON: كرتونة كاملة',
  })
  @IsOptional()
  @IsEnum(SaleUnit)
  saleUnit?: SaleUnit;
```

- [ ] **Step 4: Select `stockQuantity` on the old items in `update`**

In `src/modules/invoice/invoice.service.ts`, add the import:

```ts
import { buildInvoiceItem, stockPiecesOf, type BuiltInvoiceItem } from './invoice-item.util';
```

(replacing the single-symbol import added in Task 6).

In `update`, change the items select on the initial fetch from
`items: { select: { id: true, productId: true, quantity: true } }` to:

```ts
        items: {
          select: {
            id: true,
            productId: true,
            quantity: true,
            stockQuantity: true,
          },
        },
```

- [ ] **Step 5: Build the new items through `buildInvoiceItem`**

Still in `update`, delete the local `type NewItem = { ... }` declaration and change the `newInvoiceItems` declaration to use the shared type:

```ts
    let newInvoiceItems: BuiltInvoiceItem[] | null = null;
```

Replace the `newInvoiceItems = dto.items.map(...)` block with:

```ts
      newInvoiceItems = dto.items.map((item) =>
        buildInvoiceItem(
          productMap.get(item.productId)!,
          item.quantity,
          item.saleUnit,
        ),
      );
```

- [ ] **Step 6: Restore and deduct in pieces**

Still in `update`, inside the transaction, replace the restore loop with:

```ts
          // a. Restore stock for all OLD items. updateMany per item — each
          //    one is a single atomic UPDATE. stockPiecesOf() covers lines
          //    written before carton support, whose stockQuantity is NULL.
          for (const oldItem of invoice.items) {
            if (oldItem.productId) {
              await tx.product.updateMany({
                where: { id: oldItem.productId, storeId: sid },
                data: { stock: { increment: stockPiecesOf(oldItem) } },
              });
            }
          }
```

and the deduction loop with:

```ts
          // b. Atomic per-item conditional deduction for the NEW items, in
          //    pieces.
          for (const newItem of newInvoiceItems) {
            const { count } = await tx.product.updateMany({
              where: {
                id: newItem.productId,
                storeId: sid,
                isActive: true,
                stock: { gte: newItem.stockQuantity },
              },
              data: { stock: { decrement: newItem.stockQuantity } },
            });
            if (count === 0) {
              const live = await tx.product.findFirst({
                where: { id: newItem.productId, storeId: sid },
                select: { stock: true, name: true, isActive: true },
              });
              if (!live || !live.isActive) {
                throw new BadRequestException(
                  `المنتج "${newItem.productName}" غير متوفر أو معطّل`,
                );
              }
              throw new BadRequestException(
                `الكمية المطلوبة (${newItem.stockQuantity} قطعة) من "${newItem.productName}" تتجاوز المخزون المتوفر (${live.stock} قطعة)`,
              );
            }
          }
```

- [ ] **Step 7: Restore in pieces on delete**

In `remove`, change the items select from
`items: { select: { productId: true, quantity: true } }` to:

```ts
        items: { select: { productId: true, quantity: true, stockQuantity: true } },
```

and the restore loop to:

```ts
        for (const item of invoice.items) {
          if (item.productId) {
            await tx.product.updateMany({
              where: { id: item.productId, storeId: sid },
              data: { stock: { increment: stockPiecesOf(item) } },
            });
          }
        }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 21 tests. The Task 1 legacy-restore test must still pass; it is the guard on the `stockPiecesOf` fallback.

- [ ] **Step 9: Commit**

```bash
git add src/modules/invoice/dto/update-invoice.dto.ts src/modules/invoice/invoice.service.ts test/carton-sales.e2e-spec.ts
git commit -m "feat(carton): restore and re-deduct carton stock on invoice update and delete"
```

---

### Task 8: Expose the new line fields in read responses

**Files:**
- Modify: `src/modules/invoice/invoice.service.ts` — `findOne` and `findByNumber` item selects
- Modify: `src/modules/customer/customer.service.ts:135-144`
- Test: `test/carton-sales.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing new
- Produces: `saleUnit` and `stockQuantity` on every invoice line the API returns

- [ ] **Step 1: Write the failing e2e test**

Append to `test/carton-sales.e2e-spec.ts`:

```ts
describe('Carton sales — read responses expose the line unit', () => {
  let ctx: Ctx;
  let invoiceId: string;
  let invoiceNumber: number;
  let customerId: string;

  beforeAll(async () => {
    ctx = await bootstrap();

    const product = await ctx.db.product.create({
      data: {
        name: 'Response Check',
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock: 48,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });
    const customer = await ctx.db.customer.create({
      data: { name: 'Carton Buyer', storeId: ctx.storeId },
    });
    customerId = customer.id;

    const created = await request(ctx.server)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        paymentMethod: 'DEBT',
        customerId,
        items: [{ productId: product.id, quantity: 1, saleUnit: 'CARTON' }],
      });
    expect(created.status).toBe(201);
    invoiceId = created.body.id;
    invoiceNumber = created.body.number;
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('returns saleUnit and stockQuantity from GET /invoices/:id', async () => {
    const res = await request(ctx.server)
      .get(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].saleUnit).toBe('CARTON');
    expect(res.body.items[0].stockQuantity).toBe(24);
  });

  it('returns saleUnit and stockQuantity from GET /invoices/number/:number', async () => {
    const res = await request(ctx.server)
      .get(`/api/invoices/number/${invoiceNumber}`)
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].saleUnit).toBe('CARTON');
    expect(res.body.items[0].stockQuantity).toBe(24);
  });

  it('returns saleUnit and stockQuantity in the customer invoice history', async () => {
    const res = await request(ctx.server)
      .get(`/api/customers/${customerId}`)
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices[0].items[0].saleUnit).toBe('CARTON');
    expect(res.body.invoices[0].items[0].stockQuantity).toBe(24);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: FAIL — `saleUnit` is `undefined` in all three responses (the fields exist on the row but are not in the `select` lists).

- [ ] **Step 3: Add the fields to the invoice read selects**

In `src/modules/invoice/invoice.service.ts`, in **both** `findOne` and `findByNumber`, change the items select to:

```ts
        items: {
          select: {
            id: true,
            productName: true,
            barcode: true,
            price: true,
            quantity: true,
            total: true,
            saleUnit: true,
            stockQuantity: true,
            productId: true,
          },
        },
```

- [ ] **Step 4: Add the fields to the customer invoice history select**

In `src/modules/customer/customer.service.ts`, in `findOne`, change the nested items select to:

```ts
            items: {
              select: {
                id: true,
                productName: true,
                barcode: true,
                price: true,
                quantity: true,
                total: true,
                saleUnit: true,
                stockQuantity: true,
              },
            },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 24 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/invoice/invoice.service.ts src/modules/customer/customer.service.ts test/carton-sales.e2e-spec.ts
git commit -m "feat(carton): expose saleUnit and stockQuantity in invoice read responses"
```

---

### Task 9: Offline sync deducts pieces, not cartons

**Files:**
- Modify: `src/modules/sync/dto/sync-push.dto.ts:24-72`
- Modify: `src/modules/sync/sync.service.ts:174-186` (product validation), `:263-306` (item insert + stock deduction)
- Test: `test/carton-sales.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `SaleUnit` (Task 1)
- Produces: `POST /api/sync/push` accepting `invoices[].items[].saleUnit` and `invoices[].items[].stockQuantity`

- [ ] **Step 1: Write the failing e2e test**

Append to `test/carton-sales.e2e-spec.ts`:

```ts
describe('Carton sales — offline sync push', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootstrap();
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  async function makeCartonProduct(name: string, stock: number) {
    return ctx.db.product.create({
      data: {
        name,
        price: new Prisma.Decimal(3),
        wholesalePrice: new Prisma.Decimal(2),
        stock,
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
        storeId: ctx.storeId,
      },
    });
  }

  function offlineInvoice(productId: string, itemOverrides: Record<string, unknown>) {
    return {
      invoices: [
        {
          id: randomUUID(),
          date: new Date().toISOString(),
          total: 60,
          paid: 60,
          remaining: 0,
          paymentMethod: 'CASH',
          items: [
            {
              id: randomUUID(),
              productName: 'Offline Carton',
              price: 60,
              quantity: 1,
              total: 60,
              unitCost: 48,
              productId,
              ...itemOverrides,
            },
          ],
        },
      ],
      debts: [],
      debtPayments: [],
    };
  }

  it('recomputes pieces from the product when only saleUnit is sent', async () => {
    const product = await makeCartonProduct('Offline Recompute', 48);

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send(offlineInvoice(product.id, { saleUnit: 'CARTON' }));

    expect(res.status).toBe(200);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(24); // 48 − 24, not 48 − 1
  });

  it('honours an explicit stockQuantity from the device', async () => {
    const product = await makeCartonProduct('Offline Explicit', 48);

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send(
        offlineInvoice(product.id, { saleUnit: 'CARTON', stockQuantity: 24 }),
      );

    expect(res.status).toBe(200);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(24);

    const line = await ctx.db.invoiceItem.findFirst({
      where: { productId: product.id },
    });
    expect(line!.saleUnit).toBe('CARTON');
    expect(line!.stockQuantity).toBe(24);
  });

  it('still deducts pieces for a legacy payload with no saleUnit', async () => {
    const product = await makeCartonProduct('Offline Legacy', 48);

    const res = await request(ctx.server)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send(offlineInvoice(product.id, {}));

    expect(res.status).toBe(200);

    const after = await ctx.db.product.findUnique({ where: { id: product.id } });
    expect(after!.stock).toBe(47); // 48 − 1 piece
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: FAIL — the first test leaves stock at 47 (and/or 400 on the unknown `saleUnit` property).

- [ ] **Step 3: Add the fields to `SyncInvoiceItemDto`**

In `src/modules/sync/dto/sync-push.dto.ts`, change the Prisma import to:

```ts
import { PaymentMethod, SaleUnit } from 'generated/prisma/client';
```

and append to `SyncInvoiceItemDto`:

```ts
  @ApiPropertyOptional({
    enum: SaleUnit,
    example: 'CARTON',
    default: 'UNIT',
    description:
      'وحدة البيع — UNIT: قطعة (الافتراضي) | CARTON: كرتونة كاملة. ' +
      'عند CARTON تكون الكمية بعدد الكراتين',
  })
  @IsOptional()
  @IsEnum(SaleUnit)
  saleUnit?: SaleUnit;

  @ApiPropertyOptional({
    example: 24,
    description:
      'عدد القطع المخصومة فعلياً من المخزون. إذا لم يُرسل يحسبه الخادم من بيانات ' +
      'الكرتونة المخزَّنة في المنتج',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  stockQuantity?: number;
```

`IsOptional`, `IsEnum`, `IsInt`, `Min` and `Type` are already imported in this file; add `ApiPropertyOptional` to the `@nestjs/swagger` import if it is not already there (it is, used by `barcode`).

- [ ] **Step 4: Fetch carton sizes during the existing product validation**

In `src/modules/sync/sync.service.ts`, replace the product cross-tenant check inside the transaction:

```ts
        // Same ownership check as before, but we keep the carton size while
        // we're here — an offline carton line has to be converted to pieces
        // and there is no reason to pay for a second round-trip.
        const cartonSizeByProductId = new Map<string, number | null>();
        if (productIdsReferenced.size > 0) {
          const rows = await tx.product.findMany({
            where: {
              id: { in: [...productIdsReferenced] },
              storeId: sid,
            },
            select: { id: true, piecesPerCarton: true },
          });
          if (rows.length !== productIdsReferenced.size) {
            throw new ForbiddenException(
              'أحد المنتجات في الـ payload لا ينتمي إلى متجرك',
            );
          }
          for (const row of rows) {
            cartonSizeByProductId.set(row.id, row.piecesPerCarton);
          }
        }
```

- [ ] **Step 5: Add the pieces resolver**

Add this private method to `SyncService` (place it directly above `push`):

```ts
  /**
   * Pieces to deduct for one offline line.
   *
   * Priority: an explicit `stockQuantity` from the device wins (it is what the
   * device actually reserved against its local copy), then a server-side
   * recompute from the product's carton size, then the raw quantity.
   *
   * A CARTON line on a product with no carton size means the product was
   * converted back to piece-only while the device was offline. The sale
   * already happened on the ground, so we log the discrepancy and deduct
   * pieces rather than rejecting and losing the record — the same policy the
   * stock-drift warning below already applies.
   */
  private syncStockPieces(
    item: SyncInvoiceItemDto,
    cartonSizeByProductId: Map<string, number | null>,
  ): number {
    if (item.stockQuantity != null) return item.stockQuantity;
    if (item.saleUnit !== 'CARTON') return item.quantity;

    const piecesPerCarton = item.productId
      ? cartonSizeByProductId.get(item.productId)
      : null;
    if (piecesPerCarton == null) {
      this.logger.warn(
        `[sync/push] Carton line for product ${item.productId ?? 'unknown'} has no ` +
          'piecesPerCarton and no client stockQuantity — deducting raw quantity. ' +
          'Flag inventory discrepancy out-of-band.',
      );
      return item.quantity;
    }
    return item.quantity * piecesPerCarton;
  }
```

Add `SyncInvoiceItemDto` to the DTO import at the top of the file:

```ts
import { SyncPushDto, SyncInvoiceItemDto } from './dto/sync-push.dto';
```

- [ ] **Step 6: Persist and deduct the resolved pieces**

Replace the `allItems` construction with:

```ts
            // Flatten every item from every new invoice into a single
            // bulk insert. stockQuantity is resolved once here and reused for
            // the deduction below, so the row and the ledger can never
            // disagree.
            const allItems = newInvoices.flatMap((invoice) =>
              invoice.items.map((item) => ({
                id: item.id,
                productName: item.productName,
                barcode: item.barcode ?? null,
                price: new Prisma.Decimal(item.price),
                unitCost: new Prisma.Decimal(item.unitCost ?? 0),
                quantity: item.quantity,
                total: new Prisma.Decimal(item.total),
                saleUnit: item.saleUnit ?? 'UNIT',
                stockQuantity: this.syncStockPieces(item, cartonSizeByProductId),
                productId: item.productId ?? null,
                invoiceId: invoice.id,
              })),
            );
```

and replace the nested stock-deduction loop (`for (const invoice of newInvoices) { for (const item of invoice.items) { ... } }`) with a single pass over `allItems`:

```ts
            // Atomic per-item stock deduction, in pieces. Offline-sync
            // semantics: if online stock has drifted too low, the row is left
            // untouched and the discrepancy is logged — the sale itself still
            // persists (it really happened).
            for (const item of allItems) {
              if (!item.productId) continue;
              const { count } = await tx.product.updateMany({
                where: {
                  id: item.productId,
                  storeId: sid,
                  stock: { gte: item.stockQuantity },
                },
                data: { stock: { decrement: item.stockQuantity } },
              });
              if (count === 0) {
                this.logger.warn(
                  `[sync/push] Stock-deduction skipped for product ${item.productId} on invoice ${item.invoiceId}. ` +
                    'Likely cause: product deleted/disabled or stock fell below the offline sale quantity. ' +
                    'Flag inventory discrepancy out-of-band.',
                );
              }
            }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- carton-sales`
Expected: PASS — 27 tests.

- [ ] **Step 8: Verify the existing sync suite still passes**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- sync`
Expected: PASS — the pre-existing `test/sync.e2e-spec.ts` must be unaffected. It covers the idempotency, cross-tenant and overpayment paths that Step 4 and Step 6 touched.

- [ ] **Step 9: Commit**

```bash
git add src/modules/sync/dto/sync-push.dto.ts src/modules/sync/sync.service.ts test/carton-sales.e2e-spec.ts
git commit -m "feat(carton): deduct carton pieces on offline sync push"
```

---

### Task 10: Full verification and frontend handover

**Files:**
- Modify: `docs/API_CHANGES_FOR_FRONTEND.md`

**Interfaces:**
- Consumes: everything
- Produces: a green build, a green test suite, and the handover notes the frontend developer needs

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — `user.controller.spec.ts`, `user.service.spec.ts`, `carton.util.spec.ts`, `invoice-item.util.spec.ts`.

- [ ] **Step 2: Run the full e2e suite**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e`
Expected: PASS for `cache`, `ledger-integrity`, `security`, `sync`, `carton-sales`. `ledger-integrity` is the important one: it covers the concurrent-stock and invoice-numbering paths that Tasks 6 and 7 edited.

**Known pre-existing failure — not ours, do not "fix" it here.** 4 tests in `test/error-handling.e2e-spec.ts` fail with 401. Cause: commit `ff39cda` (store suspend/reactivate, landed before this branch) made `src/common/guards/jwt.guard.ts` re-check live store status in the DB on every request, and that spec mints a JWT for a `storeId` it never inserts. Verified: neither `jwt.guard.ts` nor `error-handling.e2e-spec.ts` is touched anywhere on this branch. Report it to the repo owner as separate work; do not weaken the guard or the spec to make it green.

Any failure outside those 4 is ours — fix it before continuing to Step 3.

- [ ] **Step 3: Lint the changed files and build**

**Do not run `npm run lint`.** That script is `eslint ... --fix`, and the repo already has 56 pre-existing lint errors (mostly prettier CRLF/LF disagreements) on files this branch never touches — verified by running eslint against the untouched `user` and `debt` modules. Running it would rewrite files across the whole repo and bury this branch's diff in unrelated churn.

Lint only what this branch changed, without `--fix`:

```bash
npx eslint $(git diff --name-only main..HEAD -- '*.ts')
```

Expected: no error that is *new* relative to the rest of the repo. Line-ending (`prettier/prettier` `␍⏎`) complaints are the pre-existing repo-wide condition — leave them. A real error introduced by this branch (unused import, unsafe assertion, undefined variable) must be fixed.

Run: `npm run build`
Expected: exit 0, clean `nest build` with no TypeScript errors. This one is a hard gate.

- [ ] **Step 4: Confirm the migration is still additive-only**

Run: `git diff main -- prisma/migrations`
Expected: exactly one new migration folder whose SQL contains only `CREATE TYPE` and `ALTER TABLE ... ADD COLUMN`. If you see `UPDATE`, `DROP`, or `SET NOT NULL`, stop and report — the production-safety constraint is violated.

- [ ] **Step 5: Write the frontend handover notes**

Append to `docs/API_CHANGES_FOR_FRONTEND.md`:

```markdown
## بيع الكرتونة (2026-08-09)

### المنتجات

`POST /api/products` و `PATCH /api/products/:id` صاروا يقبلوا:

| الحقل | النوع | ملاحظات |
|---|---|---|
| `piecesPerCarton` | `int ≥ 1` | عدد القطع في الكرتونة |
| `cartonPurchasePrice` | `decimal ≥ 0` | سعر شراء الكرتونة |
| `cartonSalePrice` | `decimal ≥ 0` | سعر بيع الكرتونة |
| `cartonCount` | `int ≥ 0` | **الإنشاء فقط** — لا يُقبل في التعديل |

**الحقول الثلاثة الأولى تُرسل معاً أو لا يُرسل أي منها.** إرسال بعضها → `400`.

**⚠️ ثلاث نقاط تخص الواجهة:**

1. **خانة "الكمية" (`stock`) في وضع الكرتونة تعني "قطع فرط إضافية"** وتُجمع فوق قطع الكراتين:
   `المخزون = (cartonCount × piecesPerCarton) + stock`
   مثال: `2 كرتونة × 24 + 5 فرط = 53 قطعة`.
   يُفضَّل تغيير تسمية الخانة في وضع الكرتونة إلى "قطع إضافية فرط" — الكاشير الذي يفهمها كمخزون كلي ويكتب 48 سينتج مخزوناً = 96.

2. **خانة "سعر الجملة" (`wholesalePrice`) تُتجاهل في وضع الكرتونة.** الخادم يحسبها:
   `wholesalePrice = cartonPurchasePrice ÷ piecesPerCarton` (مقرَّبة لمنزلتين).
   يُفضَّل إخفاؤها أو جعلها `readonly` محسوبة.

3. **التعديل لا يعيد حساب المخزون من الكراتين.** إرسال `cartonCount` في `PATCH` → `400`. لتصحيح المخزون استخدم `stock` مباشرة.

`stock` في كل الاستجابات **دائماً بالقطع**، لا بالكراتين.

### الفواتير

`POST /api/invoices` و `PATCH /api/invoices/:id`: كل بند يقبل `saleUnit` اختياري بقيمة `UNIT` (الافتراضي) أو `CARTON`.

عند `CARTON`:
- `quantity` = عدد الكراتين
- السعر والتكلفة يُقرآن من `cartonSalePrice` و `cartonPurchasePrice` المخزَّنين في المنتج — لا تُرسل أسعاراً
- المخزون يُخصم `quantity × piecesPerCarton` قطعة
- بيع كرتونة من منتج بلا بيانات كرتونة → `400`

بيع كراتين وقطع من نفس المنتج في نفس الفاتورة = **بندان مستقلان**.

استجابات `GET /api/invoices/:id` و `GET /api/invoices/number/:n` و `GET /api/customers/:id` صارت ترجع `saleUnit` و `stockQuantity` في كل بند. البنود المُنشأة قبل هذا التحديث ترجع `saleUnit: "UNIT"` و `stockQuantity: null`.

### المزامنة الأوف‌لاين

`POST /api/sync/push`: كل بند يقبل `saleUnit` و `stockQuantity` اختياريين.

**طابور الأوف‌لاين يجب أن يرسل `saleUnit: "CARTON"` مع كل بيعة كرتونة**، ويُفضَّل إرسال `stockQuantity` أيضاً. بدونهما يُخصم المخزون بالقطعة بدل الكرتونة وينحرف المخزون بصمت.
```

- [ ] **Step 6: Commit**

```bash
git add docs/API_CHANGES_FOR_FRONTEND.md
git commit -m "docs(carton): document the carton sales API for the frontend"
```

- [ ] **Step 7: Report deployment notes to the repo owner**

Summarise for the owner, do not act on it yourself:

- Deployment runs `prisma migrate deploy` via the `start:migrate` script — the new migration applies automatically on the next deploy.
- The migration is metadata-only and takes no meaningful lock, so no maintenance window is needed.
- The change is backward compatible in both directions: the new backend serves the current frontend unchanged, and the new frontend fields are all optional.
- There is **no rollback migration**. Rolling the code back while leaving the columns in place is safe (they are simply ignored). Dropping the columns after carton sales have been recorded would destroy the `stockQuantity` snapshots and corrupt stock restores.

---

## Self-Review Notes

**Spec coverage:** §3 → Task 1. §4 → Task 3 (util in Task 2). §5 → Task 4. §6 → Task 6 (util in Task 5). §7 → Task 7. §8 → Task 8. §9 → Task 9. §10 (reports unchanged) → verified by the profit assertion in Task 6 Step 1. §11 deviations → recorded in Global Constraints and Task 10 Step 5. §12 frontend notes → Task 10 Step 5. §14 acceptance criteria → all 15 mapped: 1–2 (Task 1 Step 7), 3 (Task 1 Step 7 legacy-restore), 4 (Task 10 Step 2 full suite), 5–6 (Task 3), 7–8 (Task 6), 9–10 (Task 6), 11 (Task 7), 12 (Task 9), 13–14 (Task 3), 15 (Task 4).

**Type consistency:** `buildInvoiceItem` and `stockPiecesOf` are named identically in Tasks 5, 6, 7 and their consumers. `BuiltInvoiceItem` replaces the local `NewItem` type in `invoice.service.update` (Task 7 Step 5). `assertCartonGroupValid` / `isCartonGroupComplete` / `unitCostFromCarton` / `openingStockFromCartons` are named identically in Tasks 2, 3, 4. `syncStockPieces` is private to `SyncService` and used only in Task 9.

**Verified empirically before writing this plan:** the unit jest config cannot resolve `generated/prisma/client` without the Task 1 Step 1 fix (probe failed with `Cannot find module`), and `new Prisma.Decimal(48).dividedBy(24).toDecimalPlaces(2)` equals `2` — hence the tests compare with `.equals()` / `Number()` rather than string-matching `"2.00"`.
