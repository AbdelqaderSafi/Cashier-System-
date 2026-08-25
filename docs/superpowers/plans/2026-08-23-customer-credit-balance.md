# Customer Credit Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer overpay their debt — pay 150 against a 100 debt — and have the extra 50 stored as credit that is spent automatically on their next debt invoice, with a signed balance (`negative = owes`, `positive = shop owes them`) on every read.

**Architecture:** A denormalized `customers.creditBalance` column kept in lockstep with a `credit_entries` audit ledger, both written inside one transaction that holds `SELECT … FOR UPDATE` on the customer row. This mirrors the existing `debts.paid` ↔ `debt_payments` relationship exactly. A `DebtPaymentOperation` parent row anchors the client idempotency key, because one customer-level payment fans out into N `DebtPayment` rows and `DebtPayment` has no `storeId` to key on. Credit spent on a debt is recorded as a real `DebtPayment` with `source: CREDIT`, mirrored onto the invoice the same way `DebtService.pay` already does — anything else violates `invoice_balance_consistent` on the next cash payment.

**Tech Stack:** NestJS 11, Prisma 7.8 (`prisma-client` generator → `generated/prisma/client`), PostgreSQL, class-validator, Jest (unit) + Jest/supertest (e2e).

**Spec:** [docs/superpowers/specs/2026-08-23-customer-credit-balance-design.md](../specs/2026-08-23-customer-credit-balance-design.md)

**Branch:** `feat/debt-management`, forked from `development`.

---

## Global Constraints

- **The migration is additive only.** `CREATE TYPE`, `CREATE TABLE`, `ADD COLUMN`, `CREATE INDEX`, and the one documented `ADD CONSTRAINT … CHECK`. Never write `UPDATE`, `DROP`, `SET NOT NULL`, or a backfill against an existing table. Production carries live store data.
- **Every existing API field keeps its exact name, type, and meaning.** The frontend is already built against the handoff contract. Everything new is purely additive.
- **Never let a CHECK constraint be the user-facing guard.** `PrismaExceptionFilter` maps only `P2002 / P2025 / P2003 / P2000 / P2014`; PostgreSQL `23514` (check violation) and `40P01` (deadlock) fall through to an unmapped **500** with `حدث خطأ في قاعدة البيانات`. Validate in the service and return an Arabic **400**.
- **Lock order is Store → Customer → Debts → Invoices.** Any transaction touching a customer's debts or invoices takes `SELECT … FOR UPDATE` on the **customer row as its first statement**, unconditionally — even when no credit is involved. Skipping this deadlocks `PATCH /invoices/:id` against `POST /debts/customer/:id/pay`.
- **Never write `debts.paid` without recomputing `debts.remaining` in the same statement**, and never write `invoices.paid` without `invoices.remaining`. Use Prisma's `{ increment }` / `{ decrement }` so PostgreSQL evaluates both in one `UPDATE` and the CHECK sees only the final row.
- **All money arithmetic uses `Prisma.Decimal`.** No `Number`, no `parseFloat`, no `toFixed` in business logic.
- **All money on the wire is `Decimal.prototype.toString()`** — `"50"`, not `"50.00"`. This is the repo's existing behaviour (`Decimal.toJSON` *is* `toString`), so a hand-formatted `.toFixed(2)` field next to a raw column produces the mixed shape the spec forbids.
- **Cache invalidation happens AFTER the transaction returns**, never inside it. Busting `sync:init` pre-commit lets a concurrent read re-pin the stale value for 30s.
- User-facing error messages are in Arabic; code comments are in English.
- The API global prefix is `/api`. `ValidationPipe` runs with `whitelist: true, forbidNonWhitelisted: true` — any field not declared on a DTO causes a 400.
- **Out of scope, do not implement:** cash refunds from credit, overpayment on `POST /debts/:id/pay`, credit consumption in `POST /sync/push`, manual credit adjustment endpoints, credit across stores.

## ⚠️ Database safety — read before running ANY command

**The `DATABASE_URL` in the repo's `.env` points at the live production Neon database**, and `main` auto-deploys to Railway. A local development database exists at the production schema:

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
2. Never run `prisma migrate deploy` against production by hand. Production applies migrations on its next Railway deploy via the container's `CMD ["sh","-c","npx prisma migrate deploy && node dist/src/main"]`.
3. `test/guard-local-db.ts` (jest `globalSetup`) refuses to start the e2e suite unless the host is local. If you see `Refusing to run the e2e suite against …`, add the prefix — never weaken the guard.

## Do not commit

**The user commits.** Write files and leave them unstaged. Every `git add`/`git commit` in this plan is written as a **checkpoint** the user runs, not a step you execute. Report "Task N complete, ready to commit" and stop.

## Known repo conditions — not defects, do not "fix"

- **4 tests in `test/error-handling.e2e-spec.ts` fail with 401.** Pre-existing (commit `ff39cda`); that spec mints a JWT for a `storeId` it never inserts. Tracked separately.
- **`npm run lint` is `eslint --fix`** and the repo carries ~56 pre-existing errors on untouched modules from a CRLF/LF prettier disagreement. Lint only changed files, without `--fix`.
- **Jest may not self-exit** after results print. Re-run with `--forceExit` to confirm; it does not indicate failure.
- `prisma migrate dev` does **not** auto-run `prisma generate` on Prisma 7.8.0 here. Run `prisma generate` explicitly after every schema change.

## Tripwire tests — these must stay green

Two existing specs assert the *old* rejection behaviour on paths this work deliberately does **not** change. They are proof the out-of-scope boundary held. If either goes red, the change leaked:

- `test/ledger-integrity.e2e-spec.ts` — two concurrent overpays on `POST /debts/:id/pay` yield exactly one `201` and one `400`.
- `test/sync.e2e-spec.ts` — an overpaying `POST /sync/push` payload yields `400` matching `/يتجاوز المتبقي/` with the debt row untouched.

## Task Dependency Order

Sequential: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Task 3 consumes the pure helpers from Task 2 and creates the transaction helpers Tasks 4 and 5 reuse.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | `creditBalance` on Customer; `source`/`operationId` on DebtPayment; `CreditEntry` + `DebtPaymentOperation` models; `Store` back-relations |
| `prisma/migrations/<ts>_add_customer_credit/migration.sql` | Create | Additive-only DDL |
| `src/modules/debt/credit.util.ts` | Create | Pure Decimal helpers — no DB |
| `src/modules/debt/credit.util.spec.ts` | Create | Unit tests for the above |
| `src/modules/debt/credit.tx.ts` | Create | Transaction-scoped credit operations (take a `tx`) |
| `src/modules/debt/dto/pay-customer-debt.dto.ts` | Create | `clientOperationId` — customer-level route only |
| `src/modules/debt/dto/pay-debt.dto.ts` | Modify | Fix the now-false `amount` description |
| `src/modules/debt/debt.controller.ts` | Modify | Swap the DTO on `payForCustomer`; rewrite its Swagger |
| `src/modules/debt/debt.service.ts` | Modify | Overpay→credit, idempotency, credit-aware `deletePayment`, credit in summaries |
| `src/modules/invoice/invoice.service.ts` | Modify | Consume credit on create; customer lock; credit-aware guards, update, remove; daily-sales credit lines |
| `src/modules/customer/customer.service.ts` | Modify | `creditBalance`/`balance` on reads; archive guard |
| `src/modules/backup/backup.service.ts` | Modify | Net customer credit before ranking debtors |
| `test/customer-credit.e2e-spec.ts` | Create | e2e coverage, one describe block per task |
| `test/cache.e2e-spec.ts` | Modify | Teardown only |
| `test/carton-sales.e2e-spec.ts` | Modify | Teardown only |
| `test/invoice-discount.e2e-spec.ts` | Modify | Teardown only |
| `test/ledger-integrity.e2e-spec.ts` | Modify | Teardown only |
| `test/sync.e2e-spec.ts` | Modify | Teardown only |
| `docs/API_CHANGES_FOR_FRONTEND.md` | Modify | Frontend handover notes |

---

### Task 1: Schema, migration, and test scaffolding

**Files:**
- Modify: `prisma/schema.prisma` (models `Store`, `Customer`, `DebtPayment`; two new models, two new enums)
- Create: `prisma/migrations/<timestamp>_add_customer_credit/migration.sql`
- Create: `test/customer-credit.e2e-spec.ts`
- Modify: `test/cache.e2e-spec.ts:85`, `test/carton-sales.e2e-spec.ts:71`, `test/invoice-discount.e2e-spec.ts:70`, `test/ledger-integrity.e2e-spec.ts:80`, `test/sync.e2e-spec.ts:77`

**Interfaces:**
- Consumes: nothing
- Produces: `Customer.creditBalance: Prisma.Decimal`, `DebtPayment.source: 'CASH' | 'CREDIT'`, `DebtPayment.operationId: string | null`, models `CreditEntry` and `DebtPaymentOperation`, enums `PaymentSource` and `CreditReason`. Also `Ctx` / `bootstrap()` / `teardown()` in `test/customer-credit.e2e-spec.ts`, which every later task reuses.

- [ ] **Step 1: Add the enums to `prisma/schema.prisma`**

Directly above `model Debt`, add:

```prisma
// Where the money for a debt payment came from. Every payment that existed
// before customer credit was cash, which is what the column default gives
// them. A CREDIT payment is funded from customers.creditBalance and must be
// excluded from cash-revenue reporting and from the "has payments" guards
// that block editing or voiding an invoice.
enum PaymentSource {
  CASH
  CREDIT
}

// Directional on purpose. A single REVERSAL value would serve two opposite
// movements — credit handed back to the customer (delta > 0) and credit
// clawed back from them (delta < 0) — and the daily reports in
// InvoiceService.getDailySales could not tell which bucket an entry belongs
// to. Invariant: OVERPAYMENT and APPLIED_REVERSED always carry delta > 0;
// APPLIED_TO_DEBT and OVERPAYMENT_REVERSED always carry delta < 0.
enum CreditReason {
  OVERPAYMENT           // cash surplus became credit
  OVERPAYMENT_REVERSED  // surplus withdrawn (a cash payment was deleted)
  APPLIED_TO_DEBT       // credit spent settling a debt
  APPLIED_REVERSED      // credit returned (invoice deleted/edited, CREDIT payment deleted)
}
```

- [ ] **Step 2: Add `creditBalance` and the back-relations to `model Customer`**

In `model Customer`, immediately after the `phone` line, add:

```prisma
  // Money the shop is holding for this customer, from an overpayment. Never
  // negative — customer_credit_non_negative enforces that as a backstop, and
  // the service layer rejects the request long before the DB sees it. Kept in
  // lockstep with SUM(credit_entries.delta) by every write holding
  // SELECT ... FOR UPDATE on this row, the same way debts.paid tracks
  // debt_payments with no constraint tying them.
  creditBalance Decimal @default(0) @db.Decimal(10, 2)
```

And in the same model's relations block, after `debts     Debt[]`, add:

```prisma
  creditEntries CreditEntry[]
  paymentOps    DebtPaymentOperation[]
```

- [ ] **Step 3: Add the back-relations to `model Store`**

In `model Store`, after `debts             Debt[]`, add:

```prisma
  creditEntries     CreditEntry[]
  paymentOps        DebtPaymentOperation[]
```

Without these two lines `prisma generate` fails outright — Prisma requires a back-relation for every declared relation.

- [ ] **Step 4: Extend `model DebtPayment`**

Replace the whole `model DebtPayment` block with:

```prisma
// Debt payments
model DebtPayment {
  id        String   @id @default(uuid())
  amount    Decimal  @db.Decimal(10, 2)
  date      DateTime @default(now())
  notes     String?

  // Funding source. NOT cosmetic: a CREDIT payment must be excluded from the
  // `payments.length > 0` guards that block invoice edit/void, and reversed
  // back into creditBalance when it is deleted.
  source    PaymentSource @default(CASH)

  // Foreign key
  debtId    String
  debt      Debt     @relation(fields: [debtId], references: [id], onDelete: Cascade)

  // The customer-level pay operation that produced this row. NULL means "no
  // operation" — every payment written before this migration, and every
  // payment sync/push creates. Those never produced a surplus, so their
  // deletion behaves exactly as it does today.
  operationId String?
  operation   DebtPaymentOperation? @relation(fields: [operationId], references: [id])

  creditEntry CreditEntry?

  @@index([debtId, date(sort: Desc)])
  @@index([operationId])
  @@map("debt_payments")
}
```

- [ ] **Step 5: Add the two new models**

At the end of `prisma/schema.prisma`, append:

```prisma
// One customer-level pay operation. Needed because a single client action
// fans out into N DebtPayment rows plus at most one credit movement, so no
// existing row represents "the operation" — and DebtPayment has no storeId,
// so it cannot host @@unique([storeId, clientOperationId]) at all.
//
// A row is written for EVERY call, even when there is no surplus and no
// client key, so the key always has an anchor to attach to.
model DebtPaymentOperation {
  id                String   @id @default(uuid())
  // Client-supplied idempotency key (the offline outbox's stable id). NULL is
  // allowed and PostgreSQL treats multiple NULLs as distinct in a unique
  // index, so online-only calls are unconstrained — same trick as
  // invoices_storeId_clientInvoiceId_key.
  clientOperationId String?
  amount            Decimal  @db.Decimal(10, 2)
  date              DateTime @default(now())

  customerId String
  customer   Customer @relation(fields: [customerId], references: [id])
  storeId    String
  store      Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)

  payments      DebtPayment[]
  creditEntries CreditEntry[]

  @@unique([storeId, clientOperationId])
  @@index([storeId, customerId, date(sort: Desc)])
  @@map("debt_payment_operations")
}

// Audit ledger for customers.creditBalance. SUM(delta) per customer must
// always equal the denormalized column; no CHECK can express that (PostgreSQL
// CHECKs are row-local), so the invariant is held by every writer taking
// SELECT ... FOR UPDATE on the customer row first.
model CreditEntry {
  id           String       @id @default(uuid())
  delta        Decimal      @db.Decimal(10, 2)
  // Snapshot of creditBalance immediately after this entry, so an auditor can
  // read one row instead of replaying the whole ledger.
  balanceAfter Decimal      @db.Decimal(10, 2)
  reason       CreditReason
  notes        String?
  date         DateTime     @default(now())

  customerId String
  customer   Customer @relation(fields: [customerId], references: [id])
  storeId    String
  store      Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)

  // The CREDIT payment this entry funded, when there is one. SetNull because
  // debt_payments cascade away with their debt (and so with their invoice),
  // and the ledger row has to outlive them.
  debtPaymentId String?      @unique
  debtPayment   DebtPayment? @relation(fields: [debtPaymentId], references: [id], onDelete: SetNull)
  operationId   String?
  operation     DebtPaymentOperation? @relation(fields: [operationId], references: [id])

  @@index([storeId, customerId, date(sort: Desc)])
  @@index([storeId, reason, date(sort: Desc)]) // daily-sales credit lines
  @@index([customerId])
  @@map("credit_entries")
}
```

- [ ] **Step 6: Generate the migration without applying it**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npx prisma migrate dev --create-only --name add_customer_credit`

Expected: prints the path of a new folder under `prisma/migrations/` and does **not** apply it.

- [ ] **Step 7: Review and rewrite the generated SQL**

Open the generated `migration.sql`. Confirm it contains only `CREATE TYPE`, `ALTER TABLE … ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, and `ADD CONSTRAINT … FOREIGN KEY`. If it contains `UPDATE`, `DROP`, or `SET NOT NULL`, **stop and report** — the schema edit drifted from the plan.

Replace its contents with:

```sql
-- Customer credit balance. Additive only: no existing row is read or rewritten.

CREATE TYPE "PaymentSource" AS ENUM ('CASH', 'CREDIT');
CREATE TYPE "CreditReason" AS ENUM (
  'OVERPAYMENT', 'OVERPAYMENT_REVERSED', 'APPLIED_TO_DEBT', 'APPLIED_REVERSED'
);

-- Constant DEFAULTs are metadata-only in PostgreSQL 11+, so neither statement
-- rewrites its table. Every existing customer reads 0; every existing payment
-- reads CASH, which is what all of them are.
ALTER TABLE "customers"     ADD COLUMN "creditBalance" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "debt_payments" ADD COLUMN "source" "PaymentSource" NOT NULL DEFAULT 'CASH';
ALTER TABLE "debt_payments" ADD COLUMN "operationId" TEXT;

CREATE TABLE "debt_payment_operations" (
    "id"                TEXT NOT NULL,
    "clientOperationId" TEXT,
    "amount"            DECIMAL(10,2) NOT NULL,
    "date"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId"        TEXT NOT NULL,
    "storeId"           TEXT NOT NULL,
    CONSTRAINT "debt_payment_operations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "credit_entries" (
    "id"            TEXT NOT NULL,
    "delta"         DECIMAL(10,2) NOT NULL,
    "balanceAfter"  DECIMAL(10,2) NOT NULL,
    "reason"        "CreditReason" NOT NULL,
    "notes"         TEXT,
    "date"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId"    TEXT NOT NULL,
    "storeId"       TEXT NOT NULL,
    "debtPaymentId" TEXT,
    "operationId"   TEXT,
    CONSTRAINT "credit_entries_pkey" PRIMARY KEY ("id")
);

-- NULLs are distinct in PostgreSQL unique indexes, so an operation without a
-- client key is unconstrained — same pattern as
-- customers_storeId_clientCustomerId_key.
CREATE UNIQUE INDEX "debt_payment_operations_storeId_clientOperationId_key"
  ON "debt_payment_operations" ("storeId", "clientOperationId");
CREATE INDEX "debt_payment_operations_storeId_customerId_date_idx"
  ON "debt_payment_operations" ("storeId", "customerId", "date" DESC);

CREATE UNIQUE INDEX "credit_entries_debtPaymentId_key"
  ON "credit_entries" ("debtPaymentId");
CREATE INDEX "credit_entries_storeId_customerId_date_idx"
  ON "credit_entries" ("storeId", "customerId", "date" DESC);
CREATE INDEX "credit_entries_storeId_reason_date_idx"
  ON "credit_entries" ("storeId", "reason", "date" DESC);
CREATE INDEX "credit_entries_customerId_idx"
  ON "credit_entries" ("customerId");
CREATE INDEX "debt_payments_operationId_idx"
  ON "debt_payments" ("operationId");

-- customerId RESTRICT mirrors debts_customerId_fkey: a money trail must never
-- be erased by deleting a customer. storeId CASCADE mirrors every other table.
ALTER TABLE "debt_payment_operations"
  ADD CONSTRAINT "debt_payment_operations_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "debt_payment_operations"
  ADD CONSTRAINT "debt_payment_operations_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "credit_entries"
  ADD CONSTRAINT "credit_entries_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_entries"
  ADD CONSTRAINT "credit_entries_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- debt_payments cascade away with their debt, and so with their invoice. The
-- ledger row has to outlive them, so this link nulls out instead.
ALTER TABLE "credit_entries"
  ADD CONSTRAINT "credit_entries_debtPaymentId_fkey"
  FOREIGN KEY ("debtPaymentId") REFERENCES "debt_payments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credit_entries"
  ADD CONSTRAINT "credit_entries_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "debt_payment_operations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "debt_payments"
  ADD CONSTRAINT "debt_payments_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "debt_payment_operations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Corruption backstop ONLY. The service layer must reject a negative balance
-- with an Arabic 400 first: PostgreSQL raises 23514 here, which
-- PrismaExceptionFilter does not map, so it would reach the till as a 500.
--
-- This takes ACCESS EXCLUSIVE and full-scans customers. The table is small and
-- migration 20260522114500 set the precedent on three larger tables, but this
-- is deliberately outside the "ADD COLUMN only" rule — see the design spec §3.7.
ALTER TABLE "customers"
  ADD CONSTRAINT "customer_credit_non_negative"
  CHECK ("creditBalance" >= 0);
```

- [ ] **Step 8: Apply the migration and regenerate the client**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npx prisma migrate dev`

Then run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npx prisma generate`

Expected: migration applied; `Customer` in `generated/prisma/client` now carries `creditBalance`, and `CreditEntry` / `DebtPaymentOperation` exist.

- [ ] **Step 9: Add the new tables to every existing spec's teardown**

Five specs delete customers in `afterAll`. `credit_entries.customerId` and `debt_payment_operations.customerId` are `RESTRICT`, so once Task 3 makes `payForCustomer` always write an operation row, any spec that used that route and then deletes its customers throws an FK violation in teardown and leaves orphan data behind.

In each of the five files, find the `await db.debtPayment.deleteMany(...)` line and insert **one line before it** and **two lines after it**:

```ts
  await db.creditEntry.deleteMany({ where: { storeId } });
  await db.debtPayment.deleteMany({ where: { debt: { storeId } } });
  await db.debtPaymentOperation.deleteMany({ where: { storeId } });
```

Files and current line numbers of the `customer.deleteMany` anchor:
- `test/cache.e2e-spec.ts:85`
- `test/carton-sales.e2e-spec.ts:71`
- `test/invoice-discount.e2e-spec.ts:70`
- `test/ledger-integrity.e2e-spec.ts:80`
- `test/sync.e2e-spec.ts:77`

Order matters: `credit_entries` FKs both `debt_payments` and `debt_payment_operations`, so it goes first.

- [ ] **Step 10: Write the failing backward-compatibility test**

Create `test/customer-credit.e2e-spec.ts`:

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
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 11: Run the new spec and verify it passes**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: 3 passed.

- [ ] **Step 12: Verify the tripwires and the whole suite still pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e`

Expected: all specs pass except the 4 known pre-existing 401 failures in `error-handling.e2e-spec.ts`.

- [ ] **Step 13: Checkpoint — report, do not commit**

Report: "Task 1 complete — schema, migration, and test scaffolding. Ready to commit." Suggested message for the user:

```
feat(credit): add customer credit schema and migration
```

---

### Task 2: Pure credit arithmetic helpers

**Files:**
- Create: `src/modules/debt/credit.util.ts`
- Create: `src/modules/debt/credit.util.spec.ts`

**Interfaces:**
- Consumes: `Prisma.Decimal` from `generated/prisma/client`
- Produces:
  - `type PaymentLike = { amount: Prisma.Decimal | string | number; source: PaymentSource }`
  - `cashPaidOf(paid: DecimalLike, payments: PaymentLike[]): Prisma.Decimal`
  - `creditToApply(creditBalance: DecimalLike, debtRemaining: DecimalLike): Prisma.Decimal`
  - `signedBalance(creditBalance: DecimalLike, totalRemaining: DecimalLike): Prisma.Decimal`

- [ ] **Step 1: Write the failing unit test**

Create `src/modules/debt/credit.util.spec.ts`:

```ts
import { Prisma } from 'generated/prisma/client';
import { cashPaidOf, creditToApply, signedBalance } from './credit.util';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('cashPaidOf', () => {
  it('returns the whole paid amount when every payment is cash', () => {
    const result = cashPaidOf(d(100), [
      { amount: d(60), source: 'CASH' },
      { amount: d(40), source: 'CASH' },
    ]);
    expect(result.equals(100)).toBe(true);
  });

  it('subtracts credit-funded payments', () => {
    const result = cashPaidOf(d(100), [
      { amount: d(60), source: 'CASH' },
      { amount: d(40), source: 'CREDIT' },
    ]);
    expect(result.equals(60)).toBe(true);
  });

  it('returns zero when the debt was settled entirely by credit', () => {
    const result = cashPaidOf(d(100), [{ amount: d(100), source: 'CREDIT' }]);
    expect(result.equals(0)).toBe(true);
  });

  it('returns paid unchanged when there are no payment rows', () => {
    expect(cashPaidOf(d(30), []).equals(30)).toBe(true);
  });

  it('accepts string and number amounts without float drift', () => {
    const result = cashPaidOf('0.3', [
      { amount: '0.1', source: 'CREDIT' },
      { amount: 0.2, source: 'CASH' },
    ]);
    expect(result.toString()).toBe('0.2');
  });

  it('never returns a negative number', () => {
    // Defensive: a corrupt ledger where credit payments exceed paid must not
    // produce a negative "cash paid" that then passes a >= guard.
    const result = cashPaidOf(d(10), [{ amount: d(40), source: 'CREDIT' }]);
    expect(result.equals(0)).toBe(true);
  });
});

describe('creditToApply', () => {
  it('spends the whole balance when the debt is larger', () => {
    expect(creditToApply(d(50), d(80)).equals(50)).toBe(true);
  });

  it('spends only what the debt needs when the balance is larger', () => {
    expect(creditToApply(d(100), d(60)).equals(60)).toBe(true);
  });

  it('returns zero when there is no credit', () => {
    expect(creditToApply(d(0), d(80)).equals(0)).toBe(true);
  });

  it('returns zero when the debt is already settled', () => {
    expect(creditToApply(d(50), d(0)).equals(0)).toBe(true);
  });

  it('clamps a negative input to zero rather than minting money', () => {
    expect(creditToApply(d(-10), d(80)).equals(0)).toBe(true);
    expect(creditToApply(d(50), d(-10)).equals(0)).toBe(true);
  });

  it('is exact on two-decimal money', () => {
    expect(creditToApply(d('0.1'), d('0.2')).toString()).toBe('0.1');
  });
});

describe('signedBalance', () => {
  it('is negative when the customer owes', () => {
    expect(signedBalance(d(0), d(100)).toString()).toBe('-100');
  });

  it('is positive when the shop owes the customer', () => {
    expect(signedBalance(d(50), d(0)).toString()).toBe('50');
  });

  it('is zero when they are square', () => {
    expect(signedBalance(d(0), d(0)).toString()).toBe('0');
  });

  it('nets an uncleared credit against an open debt', () => {
    // The offline case: credit and debt both recorded, not yet settled.
    expect(signedBalance(d(50), d(80)).toString()).toBe('-30');
  });

  it('is exact on fractional money', () => {
    expect(signedBalance(d('0.3'), d('0.1')).toString()).toBe('0.2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/debt/credit.util.spec.ts`

Expected: FAIL — `Cannot find module './credit.util'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/debt/credit.util.ts`:

```ts
import { Prisma } from 'generated/prisma/client';
import type { PaymentSource } from 'generated/prisma/client';

/**
 * Pure Decimal arithmetic for customer credit. No database access lives here
 * so the rules can be unit-tested without a connection; everything that needs
 * a transaction is in credit.tx.ts.
 */

type DecimalLike = Prisma.Decimal | string | number;

const dec = (v: DecimalLike): Prisma.Decimal => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);

/** A debt payment as far as credit arithmetic is concerned. */
export type PaymentLike = {
  amount: DecimalLike;
  source: PaymentSource;
};

/**
 * The portion of a debt's `paid` that came from real cash, and therefore
 * cannot be handed back by reversing credit.
 *
 * Every guard that compared against `debt.paid` must compare against this
 * instead. Once credit can settle a debt, `debt.paid` is non-zero from the
 * moment the debt is created, which would make a credit-covered invoice
 * permanently uneditable.
 */
export function cashPaidOf(
  paid: DecimalLike,
  payments: readonly PaymentLike[],
): Prisma.Decimal {
  const creditPortion = payments
    .filter((p) => p.source === 'CREDIT')
    .reduce((acc, p) => acc.plus(dec(p.amount)), ZERO);

  return Prisma.Decimal.max(dec(paid).minus(creditPortion), ZERO);
}

/**
 * How much stored credit to spend on a debt: the smaller of what the customer
 * holds and what the debt still needs. Both inputs are clamped at zero so a
 * corrupt row can never mint credit or drive a balance negative.
 */
export function creditToApply(
  creditBalance: DecimalLike,
  debtRemaining: DecimalLike,
): Prisma.Decimal {
  const available = Prisma.Decimal.max(dec(creditBalance), ZERO);
  const needed = Prisma.Decimal.max(dec(debtRemaining), ZERO);
  return Prisma.Decimal.min(available, needed);
}

/**
 * The signed number the cashier sees: negative when the customer owes,
 * positive when the shop is holding their money.
 *
 * Correct even while a credit and a debt sit side by side unsettled — the
 * offline case, where a sale synced without consuming credit.
 */
export function signedBalance(
  creditBalance: DecimalLike,
  totalRemaining: DecimalLike,
): Prisma.Decimal {
  return dec(creditBalance).minus(dec(totalRemaining));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/debt/credit.util.spec.ts`

Expected: PASS, 17 tests.

- [ ] **Step 5: Lint the two new files**

Run: `npx eslint src/modules/debt/credit.util.ts src/modules/debt/credit.util.spec.ts`

Expected: no output.

- [ ] **Step 6: Checkpoint — report, do not commit**

Report: "Task 2 complete — pure credit helpers with 17 passing unit tests. Ready to commit." Suggested message:

```
feat(credit): add pure Decimal helpers for credit arithmetic
```

---

### Task 3: Overpayment becomes credit

**Files:**
- Create: `src/modules/debt/credit.tx.ts`
- Create: `src/modules/debt/dto/pay-customer-debt.dto.ts`
- Modify: `src/modules/debt/dto/pay-debt.dto.ts` (the `amount` description)
- Modify: `src/modules/debt/debt.controller.ts:80-101`
- Modify: `src/modules/debt/debt.service.ts` (`payForCustomer`)
- Modify: `test/customer-credit.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `cashPaidOf`, `creditToApply`, `signedBalance` from `./credit.util`
- Produces, from `./credit.tx`:
  - `lockCustomerForCredit(tx, sid, customerId): Promise<{ id: string; creditBalance: Prisma.Decimal }>`
  - `grantCredit(tx, args: { sid, customerId, currentBalance, amount, reason, operationId?, notes? }): Promise<Prisma.Decimal>` — returns the new balance
  - `spendCreditOnDebt(tx, args: { sid, customerId, currentBalance, debtId, debtRemaining, invoiceId, operationId? }): Promise<{ applied: Prisma.Decimal; newBalance: Prisma.Decimal }>`
- Produces, on the wire: `creditApplied`, `excessToCredit`, `debts`, `summary.totalDebt`, `summary.creditBalance`, `summary.balance`, and `creditPaid` on each `affectedDebts` row.

- [ ] **Step 1: Write the failing e2e tests**

Append this describe block to `test/customer-credit.e2e-spec.ts`, inside the outer `describe`:

```ts
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

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(50)).toBe(true);

      const entries = await ctx.db.creditEntry.findMany({ where: { customerId } });
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe('OVERPAYMENT');
      expect(new Prisma.Decimal(entries[0].delta).equals(50)).toBe(true);
      expect(new Prisma.Decimal(entries[0].balanceAfter).equals(50)).toBe(true);
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
      await ctx.db.customer.update({
        where: { id: customerId },
        data: { creditBalance: new Prisma.Decimal(50) },
      });
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

      const res = await request(ctx.server)
        .post(`/api/debts/customer/${customerId}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 40 });

      expect(res.status).toBe(201);
      expect(res.body.debts).toHaveLength(1);
      expect(res.body.debts[0].isPaid).toBe(true);
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

    it('serialises two concurrent payments without double-spending credit', async () => {
      const customerId = await makeCustomerWithDebt(0);
      await ctx.db.customer.update({
        where: { id: customerId },
        data: { creditBalance: new Prisma.Decimal(50) },
      });
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: the Task 1 block passes; the new block fails — the first test gets `400 لا توجد ديون…` or `400 المبلغ المدفوع … يتجاوز`.

- [ ] **Step 3: Create the transaction helpers**

Create `src/modules/debt/credit.tx.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import type { CreditReason } from 'generated/prisma/client';
import { creditToApply } from './credit.util';

/**
 * Transaction-scoped credit operations. Every function here assumes the
 * caller already holds SELECT ... FOR UPDATE on the customer row (via
 * lockCustomerForCredit) and is running inside a $transaction.
 *
 * Lock order across the whole codebase is Store → Customer → Debts →
 * Invoices. Taking the customer lock late — after tx.invoice.update, as
 * InvoiceService.update naturally would — deadlocks against
 * DebtService.payForCustomer, and PostgreSQL 40P01 is not mapped by
 * PrismaExceptionFilter so it reaches the till as a 500.
 */

type Tx = Prisma.TransactionClient;

export type LockedCustomer = {
  id: string;
  creditBalance: Prisma.Decimal;
};

/**
 * Lock the customer row. MUST be the first statement of any transaction that
 * touches a customer's debts, invoices, or credit — unconditionally, even
 * when no credit is involved. This single row is what serialises the
 * otherwise-inverted lock orders of the invoice and debt paths.
 */
export async function lockCustomerForCredit(
  tx: Tx,
  sid: string,
  customerId: string,
): Promise<LockedCustomer> {
  const rows = await tx.$queryRaw<LockedCustomer[]>`
    SELECT id, "creditBalance"
    FROM customers
    WHERE id = ${customerId}
      AND "storeId" = ${sid}
      AND "isDeleted" = false
    FOR UPDATE
  `;
  if (rows.length === 0) throw new NotFoundException('العميل غير موجود');
  return { id: rows[0].id, creditBalance: new Prisma.Decimal(rows[0].creditBalance) };
}

/** Add to the customer's credit and record the movement. Returns the new balance. */
export async function grantCredit(
  tx: Tx,
  args: {
    sid: string;
    customerId: string;
    currentBalance: Prisma.Decimal;
    amount: Prisma.Decimal;
    reason: Extract<CreditReason, 'OVERPAYMENT' | 'APPLIED_REVERSED'>;
    operationId?: string | null;
    debtPaymentId?: string | null;
    notes?: string | null;
  },
): Promise<Prisma.Decimal> {
  if (args.amount.lte(0)) return args.currentBalance;

  const newBalance = args.currentBalance.plus(args.amount);

  await tx.customer.update({
    where: { id: args.customerId },
    data: { creditBalance: { increment: args.amount } },
  });
  await tx.creditEntry.create({
    data: {
      delta: args.amount,
      balanceAfter: newBalance,
      reason: args.reason,
      notes: args.notes ?? null,
      customerId: args.customerId,
      storeId: args.sid,
      operationId: args.operationId ?? null,
      debtPaymentId: args.debtPaymentId ?? null,
    },
  });

  return newBalance;
}

/** Remove from the customer's credit and record the movement. Returns the new balance. */
export async function takeCredit(
  tx: Tx,
  args: {
    sid: string;
    customerId: string;
    currentBalance: Prisma.Decimal;
    amount: Prisma.Decimal;
    reason: Extract<CreditReason, 'APPLIED_TO_DEBT' | 'OVERPAYMENT_REVERSED'>;
    operationId?: string | null;
    debtPaymentId?: string | null;
    notes?: string | null;
  },
): Promise<Prisma.Decimal> {
  if (args.amount.lte(0)) return args.currentBalance;

  const newBalance = args.currentBalance.minus(args.amount);

  await tx.customer.update({
    where: { id: args.customerId },
    data: { creditBalance: { decrement: args.amount } },
  });
  await tx.creditEntry.create({
    data: {
      delta: args.amount.negated(),
      balanceAfter: newBalance,
      reason: args.reason,
      notes: args.notes ?? null,
      customerId: args.customerId,
      storeId: args.sid,
      operationId: args.operationId ?? null,
      debtPaymentId: args.debtPaymentId ?? null,
    },
  });

  return newBalance;
}

/**
 * Settle part or all of a debt from stored credit.
 *
 * Writes a real DebtPayment with source CREDIT and mirrors onto the invoice
 * exactly the way DebtService.pay does. The invoice write is NOT optional: if
 * the debt moves while the invoice stays at paid = 0, the next cash payment
 * makes paid + remaining ≠ total and invoice_balance_consistent rejects it as
 * an unmapped 500 — the debt becomes permanently unpayable.
 *
 * increment/decrement rather than absolute assignment, so PostgreSQL computes
 * both columns in one UPDATE and the CHECK only ever sees the final row. An
 * absolute `paid: applied` is correct only on a debt that was just created
 * with paid = 0, and silently destroys prior payments anywhere else.
 */
export async function spendCreditOnDebt(
  tx: Tx,
  args: {
    sid: string;
    customerId: string;
    currentBalance: Prisma.Decimal;
    debtId: string;
    debtRemaining: Prisma.Decimal;
    invoiceId: string | null;
    operationId?: string | null;
  },
): Promise<{ applied: Prisma.Decimal; newBalance: Prisma.Decimal }> {
  const applied = creditToApply(args.currentBalance, args.debtRemaining);
  if (applied.lte(0)) {
    return { applied: new Prisma.Decimal(0), newBalance: args.currentBalance };
  }

  const payment = await tx.debtPayment.create({
    data: {
      amount: applied,
      source: 'CREDIT',
      debtId: args.debtId,
      operationId: args.operationId ?? null,
      notes: 'مسدَّد من رصيد العميل',
    },
  });

  await tx.debt.update({
    where: { id: args.debtId },
    data: {
      paid: { increment: applied },
      remaining: { decrement: applied },
      // Explicit. Leaving the schema default on a remaining-0 debt poisons the
      // unpaid-debt lists and makes payForCustomer emit zero-amount payments.
      isPaid: args.debtRemaining.minus(applied).isZero(),
    },
  });

  if (args.invoiceId) {
    await tx.invoice.update({
      where: { id: args.invoiceId },
      data: {
        paid: { increment: applied },
        remaining: { decrement: applied },
      },
    });
  }

  const newBalance = await takeCredit(tx, {
    sid: args.sid,
    customerId: args.customerId,
    currentBalance: args.currentBalance,
    amount: applied,
    reason: 'APPLIED_TO_DEBT',
    operationId: args.operationId ?? null,
    debtPaymentId: payment.id,
  });

  return { applied, newBalance };
}
```

- [ ] **Step 4: Create the customer-level DTO**

Create `src/modules/debt/dto/pay-customer-debt.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Separate from PayDebtDto on purpose. The two pay routes share a controller
 * but not their semantics: only the customer-level route accepts an
 * overpayment and honours clientOperationId. Declaring the key on the shared
 * DTO would advertise an idempotency guarantee that POST /debts/:id/pay does
 * not implement.
 */
export class PayCustomerDebtDto {
  @ApiProperty({
    example: 150.0,
    description:
      'المبلغ المدفوع — يجب أن يكون أكبر من صفر. أي مبلغ يتجاوز إجمالي الديون يُحفَظ كرصيد للعميل',
  })
  @IsNotEmpty({ message: 'المبلغ المدفوع مطلوب' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ يجب أن يكون رقماً بحد أقصى خانتين عشريتين' })
  @IsPositive({ message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Type(() => Number)
  amount!: number;

  @ApiPropertyOptional({
    example: 'دفعة جزئية للدين',
    description: 'ملاحظات على الدفعة (اختياري)',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    example: 'outbox-3f9c1e2a',
    description:
      'مُعرّف العملية من الجهاز — لمنع تكرار الدفعة عند إعادة الإرسال. إعادة نفس المُعرّف تُرجِع نتيجة العملية الأصلية بدون تحريك أي مبلغ',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientOperationId?: string;
}
```

- [ ] **Step 5: Fix the now-false description on the shared DTO**

In `src/modules/debt/dto/pay-debt.dto.ts`, replace the `amount` `@ApiProperty` description:

```ts
    description:
      'المبلغ المدفوع — يجب أن يكون أكبر من صفر ولا يتجاوز المبلغ المتبقي على هذا الدين. للدفع الزائد استخدم POST /debts/customer/:customerId/pay',
```

- [ ] **Step 6: Swap the DTO and rewrite the Swagger on the route**

In `src/modules/debt/debt.controller.ts`, add the import next to the existing DTO imports:

```ts
import { PayCustomerDebtDto } from './dto/pay-customer-debt.dto';
```

Then replace the whole `payForCustomer` route block (currently lines 80-101) with:

```ts
  // ─── POST /debts/customer/:customerId/pay ─────────────────────────────────────

  @Post('customer/:customerId/pay')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({
    summary:
      'تسديد مبلغ من الدين الكلي للعميل — يوزّع المبلغ على الديون من الأقدم للأحدث، ويحفظ أي فائض كرصيد للعميل',
  })
  @ApiParam({ name: 'customerId', format: 'uuid', description: 'معرّف العميل' })
  @ApiResponse({
    status: 201,
    description:
      'تم تسجيل الدفعة — يعيد الديون المتأثرة والرصيد الجديد والملخص المحدّث. إعادة نفس clientOperationId تُرجِع النتيجة الأصلية بدون تحريك أي مبلغ',
  })
  @ApiResponse({ status: 400, description: 'المبلغ صفر أو سالب أو بأكثر من خانتين عشريتين' })
  @ApiResponse({ status: 404, description: 'العميل غير موجود' })
  @ApiResponse({ status: 409, description: 'طلب متزامن بنفس clientOperationId' })
  payForCustomer(
    @StoreId() sid: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: PayCustomerDebtDto,
  ) {
    return this.debtService.payForCustomer(sid, customerId, dto);
  }
```

- [ ] **Step 7: Rewrite `payForCustomer` in the service**

In `src/modules/debt/debt.service.ts`, add the imports:

```ts
import { PayCustomerDebtDto } from './dto/pay-customer-debt.dto';
import { signedBalance } from './credit.util';
import { lockCustomerForCredit, grantCredit, spendCreditOnDebt } from './credit.tx';
```

Replace the entire `payForCustomer` method with:

```ts
  // ─── Pay toward a customer's total debt ───────────────────────────────────────
  //
  // Cash is allocated oldest-first; whatever the cash leaves open is settled
  // from stored credit; whatever the cash exceeds becomes new credit.
  //
  // Cash before credit is deliberate: the customer is handing over money now,
  // so the shop should settle from that and leave the balance it already holds
  // untouched. The reverse order nets out to the same number but churns the
  // ledger with credit movements that immediately reverse.
  //
  // Concurrency: the customer row is locked FIRST, unconditionally, then every
  // unpaid debt. Two concurrent calls serialise on the customer row, so the
  // same credit can never be spent twice.

  async payForCustomer(sid: string, customerId: string, dto: PayCustomerDebtDto) {
    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.db.$transaction(
      async (tx) => {
        // 1) Customer lock — first statement, always. See credit.tx.ts.
        const locked = await lockCustomerForCredit(tx, sid, customerId);

        // 2) Idempotency short-circuit. No writes on a replay.
        if (dto.clientOperationId) {
          const existing = await tx.debtPaymentOperation.findFirst({
            where: { storeId: sid, clientOperationId: dto.clientOperationId },
            include: {
              payments: { select: { debtId: true, amount: true, source: true } },
              creditEntries: { select: { delta: true, reason: true } },
            },
          });
          if (existing) {
            return this.buildPayForCustomerResult(tx, sid, customerId, {
              paymentApplied: new Prisma.Decimal(existing.amount),
              payments: existing.payments,
              creditEntries: existing.creditEntries,
            });
          }
        }

        // 3) Lock every unpaid debt, oldest first.
        const unpaidDebts = await tx.$queryRaw<
          {
            id: string;
            paid: Prisma.Decimal;
            remaining: Prisma.Decimal;
            invoiceId: string | null;
          }[]
        >`
          SELECT id, paid, remaining, "invoiceId"
          FROM debts
          WHERE "customerId" = ${customerId}
            AND "storeId" = ${sid}
            AND "isPaid" = false
          ORDER BY date ASC
          FOR UPDATE
        `;

        // Written for every call, even with no surplus and no client key, so
        // the key always has an anchor and every payment has a parent.
        const operation = await tx.debtPaymentOperation.create({
          data: {
            amount,
            customerId,
            storeId: sid,
            clientOperationId: dto.clientOperationId ?? null,
          },
        });

        const zero = new Prisma.Decimal(0);
        const perDebt = new Map<
          string,
          { cash: Prisma.Decimal; credit: Prisma.Decimal; isPaid: boolean }
        >();
        const liveRemaining = new Map<string, Prisma.Decimal>();
        for (const d of unpaidDebts) {
          liveRemaining.set(d.id, new Prisma.Decimal(d.remaining));
        }

        // 4) Cash, oldest first.
        let budget = amount;
        for (const debt of unpaidDebts) {
          if (budget.lte(0)) break;
          const remaining = liveRemaining.get(debt.id)!;
          if (remaining.lte(0)) continue;

          const applyAmount = Prisma.Decimal.min(budget, remaining);
          budget = budget.minus(applyAmount);
          const newRemaining = remaining.minus(applyAmount);
          liveRemaining.set(debt.id, newRemaining);

          await tx.debtPayment.create({
            data: {
              amount: applyAmount,
              notes: dto.notes ?? null,
              debtId: debt.id,
              source: 'CASH',
              operationId: operation.id,
            },
          });
          await tx.debt.update({
            where: { id: debt.id },
            data: {
              paid: { increment: applyAmount },
              remaining: { decrement: applyAmount },
              isPaid: newRemaining.isZero(),
            },
          });
          if (debt.invoiceId) {
            await tx.invoice.update({
              where: { id: debt.invoiceId },
              data: {
                paid: { increment: applyAmount },
                remaining: { decrement: applyAmount },
              },
            });
          }

          perDebt.set(debt.id, {
            cash: applyAmount,
            credit: zero,
            isPaid: newRemaining.isZero(),
          });
        }

        // 5) Stored credit settles whatever the cash left open.
        let balance = locked.creditBalance;
        let creditApplied = zero;
        for (const debt of unpaidDebts) {
          if (balance.lte(0)) break;
          const remaining = liveRemaining.get(debt.id)!;
          if (remaining.lte(0)) continue;

          const { applied, newBalance } = await spendCreditOnDebt(tx, {
            sid,
            customerId,
            currentBalance: balance,
            debtId: debt.id,
            debtRemaining: remaining,
            invoiceId: debt.invoiceId,
            operationId: operation.id,
          });
          balance = newBalance;
          creditApplied = creditApplied.plus(applied);
          liveRemaining.set(debt.id, remaining.minus(applied));

          const prior = perDebt.get(debt.id) ?? { cash: zero, credit: zero, isPaid: false };
          perDebt.set(debt.id, {
            cash: prior.cash,
            credit: prior.credit.plus(applied),
            isPaid: remaining.minus(applied).isZero(),
          });
        }

        // 6) Cash the debts could not absorb becomes credit.
        const excess = budget;
        if (excess.gt(0)) {
          balance = await grantCredit(tx, {
            sid,
            customerId,
            currentBalance: balance,
            amount: excess,
            reason: 'OVERPAYMENT',
            operationId: operation.id,
            notes: dto.notes ?? null,
          });
        }

        return this.buildPayForCustomerResult(tx, sid, customerId, {
          paymentApplied: amount,
          affectedDebts: [...perDebt.entries()].map(([debtId, v]) => ({
            debtId,
            amountPaid: v.cash.toString(),
            creditPaid: v.credit.toString(),
            isPaid: v.isPaid,
          })),
          creditApplied,
          excessToCredit: excess,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    // AFTER the transaction. Busting sync:init before COMMIT lets a concurrent
    // read re-pin the pre-commit balance for the full 30s TTL, and a rollback
    // would have bust it for nothing.
    await this.cacheInvalidator.invalidateStoreData(sid);
    return result;
  }

  /**
   * Assemble the pay response. `affectedDebts` and the credit figures are
   * facts about the operation; `summary` and `debts` are read fresh, so a
   * replayed request never hands the client a stale balance to sync from.
   */
  private async buildPayForCustomerResult(
    tx: Prisma.TransactionClient,
    sid: string,
    customerId: string,
    src: {
      paymentApplied: Prisma.Decimal;
      affectedDebts?: {
        debtId: string;
        amountPaid: string;
        creditPaid: string;
        isPaid: boolean;
      }[];
      creditApplied?: Prisma.Decimal;
      excessToCredit?: Prisma.Decimal;
      payments?: { debtId: string; amount: Prisma.Decimal; source: string }[];
      creditEntries?: { delta: Prisma.Decimal; reason: string }[];
    },
  ) {
    const zero = new Prisma.Decimal(0);

    // Replay path: rebuild the operation's facts from its stored rows.
    let affectedDebts = src.affectedDebts;
    let creditApplied = src.creditApplied ?? zero;
    let excessToCredit = src.excessToCredit ?? zero;

    if (!affectedDebts && src.payments) {
      const perDebt = new Map<string, { cash: Prisma.Decimal; credit: Prisma.Decimal }>();
      for (const p of src.payments) {
        const prior = perDebt.get(p.debtId) ?? { cash: zero, credit: zero };
        const amt = new Prisma.Decimal(p.amount);
        perDebt.set(
          p.debtId,
          p.source === 'CREDIT'
            ? { cash: prior.cash, credit: prior.credit.plus(amt) }
            : { cash: prior.cash.plus(amt), credit: prior.credit },
        );
      }
      const settled = await tx.debt.findMany({
        where: { id: { in: [...perDebt.keys()] } },
        select: { id: true, isPaid: true },
      });
      const isPaidById = new Map(settled.map((d) => [d.id, d.isPaid]));
      affectedDebts = [...perDebt.entries()].map(([debtId, v]) => ({
        debtId,
        amountPaid: v.cash.toString(),
        creditPaid: v.credit.toString(),
        isPaid: isPaidById.get(debtId) ?? false,
      }));

      for (const e of src.creditEntries ?? []) {
        const delta = new Prisma.Decimal(e.delta);
        if (e.reason === 'APPLIED_TO_DEBT') creditApplied = creditApplied.plus(delta.abs());
        if (e.reason === 'OVERPAYMENT') excessToCredit = excessToCredit.plus(delta);
      }
    }

    const customer = await tx.customer.findFirst({
      where: { id: customerId, storeId: sid },
      select: { id: true, name: true, phone: true, creditBalance: true },
    });

    const debts = await tx.debt.findMany({
      where: { customerId, storeId: sid },
      include: {
        invoice: { select: { id: true, number: true, date: true, paymentMethod: true } },
        payments: {
          select: { id: true, amount: true, date: true, notes: true, source: true },
          orderBy: { date: 'desc' },
        },
      },
      orderBy: { date: 'desc' },
    });

    const totalAmount = debts.reduce((a, d) => a.plus(new Prisma.Decimal(d.amount)), zero);
    const totalPaid = debts.reduce((a, d) => a.plus(new Prisma.Decimal(d.paid)), zero);
    const totalRemaining = debts.reduce((a, d) => a.plus(new Prisma.Decimal(d.remaining)), zero);
    const creditBalance = new Prisma.Decimal(customer?.creditBalance ?? 0);

    return {
      customer: customer
        ? { id: customer.id, name: customer.name, phone: customer.phone }
        : null,
      paymentApplied: src.paymentApplied.toString(),
      affectedDebts: affectedDebts ?? [],
      creditApplied: creditApplied.toString(),
      excessToCredit: excessToCredit.toString(),
      debts,
      summary: {
        totalDebts: debts.length,
        unpaidCount: debts.filter((d) => !d.isPaid).length,
        totalAmount: totalAmount.toString(),
        totalPaid: totalPaid.toString(),
        totalRemaining: totalRemaining.toString(),
        totalDebt: totalAmount.toString(),
        creditBalance: creditBalance.toString(),
        balance: signedBalance(creditBalance, totalRemaining).toString(),
      },
    };
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: all Task 1 and Task 3 tests pass.

- [ ] **Step 9: Verify the tripwires did not move**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- ledger-integrity sync`

Expected: both pass. If `ledger-integrity` now reports two `201`s, the overpay relaxation leaked into `POST /debts/:id/pay` — revert that and keep the single-debt route strict.

- [ ] **Step 10: Lint the changed files**

Run: `npx eslint src/modules/debt/credit.tx.ts src/modules/debt/debt.service.ts src/modules/debt/debt.controller.ts src/modules/debt/dto/pay-customer-debt.dto.ts src/modules/debt/dto/pay-debt.dto.ts`

Expected: no output.

- [ ] **Step 11: Checkpoint — report, do not commit**

Report: "Task 3 complete — overpayment becomes credit, idempotent and concurrency-safe. Ready to commit." Suggested message:

```
feat(credit): store overpayment as customer credit with idempotent replay
```

---

### Task 4: Consume credit when a debt invoice is created

**Files:**
- Modify: `src/modules/invoice/invoice.service.ts` (`create`, step 4)
- Modify: `test/customer-credit.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `lockCustomerForCredit`, `spendCreditOnDebt` from `../debt/credit.tx`
- Produces: a `DebtPayment` with `source: CREDIT` and a matching `APPLIED_TO_DEBT` entry on every `DEBT`/`PARTIAL` invoice created for a customer holding credit

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/customer-credit.e2e-spec.ts`:

```ts
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
        .send({ paymentMethod: 'DEBT', customerId, items: [{ productId, quantity: 8 }] });

      expect(res.status).toBe(201);

      const debt = await ctx.db.debt.findFirst({ where: { invoiceId: res.body.id } });
      expect(new Prisma.Decimal(debt!.paid).equals(50)).toBe(true);
      expect(new Prisma.Decimal(debt!.remaining).equals(30)).toBe(true);
      expect(debt!.isPaid).toBe(false);

      const invoice = await ctx.db.invoice.findUnique({ where: { id: res.body.id } });
      expect(new Prisma.Decimal(invoice!.paid).equals(50)).toBe(true);
      expect(new Prisma.Decimal(invoice!.remaining).equals(30)).toBe(true);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(0)).toBe(true);

      const payments = await ctx.db.debtPayment.findMany({ where: { debtId: debt!.id } });
      expect(payments).toHaveLength(1);
      expect(payments[0].source).toBe('CREDIT');
    });

    it('marks the debt paid explicitly when credit covers it entirely', async () => {
      const customerId = await customerWithCredit(100);

      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ paymentMethod: 'DEBT', customerId, items: [{ productId, quantity: 10 }] });

      expect(res.status).toBe(201);

      const debt = await ctx.db.debt.findFirst({ where: { invoiceId: res.body.id } });
      expect(debt!.isPaid).toBe(true);
      expect(new Prisma.Decimal(debt!.remaining).equals(0)).toBe(true);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
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

      const invoice = await ctx.db.invoice.findUnique({ where: { id: res.body.id } });
      expect(new Prisma.Decimal(invoice!.paid).equals(100)).toBe(true);
      expect(new Prisma.Decimal(invoice!.remaining).equals(0)).toBe(true);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(40)).toBe(true);
    });

    it('leaves credit alone on a CASH sale', async () => {
      const customerId = await customerWithCredit(50);

      const res = await request(ctx.server)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ paymentMethod: 'CASH', items: [{ productId, quantity: 3 }] });

      expect(res.status).toBe(201);
      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(50)).toBe(true);
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
          .send({ paymentMethod: 'DEBT', customerId, items: [{ productId, quantity: 5 }] }),
        request(ctx.server)
          .post(`/api/debts/customer/${customerId}/pay`)
          .set('Authorization', `Bearer ${ctx.token}`)
          .send({ amount: 40 }),
      ]);

      const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
      expect(statuses.every((s) => s === 201)).toBe(true);
      expect(statuses).not.toContain(500);
    }, 30_000);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: the first test fails — `debt.paid` is `0` and `creditBalance` is still `50`.

- [ ] **Step 3: Add the imports to the invoice service**

In `src/modules/invoice/invoice.service.ts`, add:

```ts
import { lockCustomerForCredit, spendCreditOnDebt } from '../debt/credit.tx';
```

- [ ] **Step 4: Take the customer lock as the transaction's first statement**

Inside `create`'s `$transaction` callback, insert this **before** the existing `// 0) Idempotency short-circuit` block:

```ts
        // Lock order is Store → Customer → Debts → Invoices, and the customer
        // row must be taken first and unconditionally. Concurrent invoice
        // creates already serialise on the store row, but a concurrent
        // POST /debts/customer/:id/pay holds the customer and reaches for the
        // invoice, so anything that takes the invoice first can cycle.
        let lockedCustomer: Awaited<ReturnType<typeof lockCustomerForCredit>> | null = null;
        if (customerId) {
          lockedCustomer = await lockCustomerForCredit(tx, sid, customerId);
        }
```

- [ ] **Step 5: Consume credit right after the debt is created**

Replace the existing step 4 block (`// 4) Optional linked debt for DEBT / PARTIAL.` through its closing brace) with:

```ts
        // 4) Optional linked debt for DEBT / PARTIAL, then spend any credit
        //    the customer is holding against it.
        //
        //    This fires for PARTIAL too, and that is intended: credit settles
        //    the deferred portion exactly as a later cash payment would. The
        //    resulting `paymentMethod = PARTIAL, paid = total` state is not
        //    new — a partial invoice reaches it today the moment the customer
        //    clears the debt through DebtService.pay. The create-time
        //    `paidAmount.gte(total)` check validates the SUBMITTED paid, and
        //    runs before any of this.
        if (needsCustomer) {
          const debt = await tx.debt.create({
            data: {
              amount: remaining,
              paid: new Prisma.Decimal(0),
              remaining,
              customerId: customerId!,
              invoiceId: invoice.id,
              storeId: sid,
            },
          });

          if (lockedCustomer && lockedCustomer.creditBalance.gt(0) && remaining.gt(0)) {
            await spendCreditOnDebt(tx, {
              sid,
              customerId: customerId!,
              currentBalance: lockedCustomer.creditBalance,
              debtId: debt.id,
              debtRemaining: remaining,
              invoiceId: invoice.id,
            });
          }
        }
```

- [ ] **Step 6: Make the cache invalidation awaited**

At the end of `create`, replace:

```ts
    void this.cacheInvalidator.invalidateStoreData(sid);
```

with:

```ts
    // Awaited, not fire-and-forget: this path can move a customer's credit,
    // and a 30s stale balance is what the cashier decides how much cash to
    // take against.
    await this.cacheInvalidator.invalidateStoreData(sid);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: all Task 1, 3, and 4 tests pass.

- [ ] **Step 8: Verify nothing else broke**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e`

Expected: all pass except the 4 known `error-handling` 401s.

- [ ] **Step 9: Checkpoint — report, do not commit**

Report: "Task 4 complete — new debt invoices consume stored credit. Ready to commit." Suggested message:

```
feat(credit): consume customer credit when a debt invoice is created
```

---

### Task 5: Reversal — invoice delete, invoice edit, payment delete, customer archive

**Files:**
- Modify: `src/modules/invoice/invoice.service.ts` (`update` guards and transaction, `remove`)
- Modify: `src/modules/debt/debt.service.ts` (`deletePayment`)
- Modify: `src/modules/customer/customer.service.ts` (`remove`)
- Modify: `test/customer-credit.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `cashPaidOf` from `../debt/credit.util`; `lockCustomerForCredit`, `grantCredit`, `takeCredit`, `spendCreditOnDebt` from `../debt/credit.tx`
- Produces: `APPLIED_REVERSED` and `OVERPAYMENT_REVERSED` ledger entries; credit-aware guards

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/customer-credit.e2e-spec.ts`:

```ts
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
      expect(res.status).toBe(200);

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

      const debt = await ctx.db.debt.findFirst({ where: { invoiceId } });
      expect(new Prisma.Decimal(debt!.amount).equals(60)).toBe(true);
      expect(new Prisma.Decimal(debt!.remaining).equals(0)).toBe(true);

      const customer = await ctx.db.customer.findUnique({ where: { id: customerId } });
      expect(new Prisma.Decimal(customer!.creditBalance).equals(40)).toBe(true);
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

      // 50 withdrawn once, not twice — a second withdrawal would need the
      // balance to go negative and would be rejected by the CHECK.
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: the Task 5 block fails.

- [ ] **Step 3: Widen the `update` read so the guards can see the funding source**

In `src/modules/invoice/invoice.service.ts`, in `update`'s opening `findFirst` (around line 298), replace:

```ts
          payments: { select: { id: true } },
```

with:

```ts
          // `source` is load-bearing here, not diagnostic: these rows feed the
          // three pre-transaction guards below, and a CREDIT payment must not
          // count as "someone has paid this".
          payments: { select: { id: true, amount: true, source: true } },
```

Make the identical change in `remove`'s `findFirst` (around line 820):

```ts
        debt: {
          select: {
            id: true,
            isPaid: true,
            payments: { select: { id: true, amount: true, source: true } },
          },
        },
```

- [ ] **Step 4: Make the three pre-transaction guards credit-aware**

These guards run **before** the transaction opens, against the read above. A reversal inside the transaction is unreachable if they reject first — that is the whole bug.

In `src/modules/invoice/invoice.service.ts`, add the import:

```ts
import { cashPaidOf } from '../debt/credit.util';
```

Then, in section `// 6. Debt constraints`, replace the three guards with:

```ts
    // Payments funded from the customer's own credit are reversible, so they
    // must not count as "someone has paid this". Only cash locks an invoice.
    const cashPayments = invoice.debt?.payments.filter((p) => p.source === 'CASH') ?? [];

    if (wasDebt && !needsCustomer) {
      // Switching from DEBT/PARTIAL → CASH/ONLINE: block if cash was recorded
      if (cashPayments.length > 0) {
        throw new BadRequestException(
          'لا يمكن تغيير طريقة الدفع — الدين عليه دفعات مسجلة. قم بتسوية الدين أولاً.',
        );
      }
    }

    if (wasDebt && needsCustomer && invoice.debt) {
      // The new remaining must not fall below what was paid in CASH. Comparing
      // against debt.paid would be wrong: credit makes it non-zero from the
      // moment the debt is created, so a fully credit-covered invoice could
      // never be corrected downward.
      const alreadyPaidInCash = cashPaidOf(invoice.debt.paid, invoice.debt.payments);
      if (remaining.lt(alreadyPaidInCash)) {
        throw new BadRequestException(
          `لا يمكن تعديل الفاتورة — المبلغ المتبقي الجديد (${remaining.toString()}) أقل مما تم دفعه فعلاً على الدين (${alreadyPaidInCash.toString()})`,
        );
      }
    }

    if (
      dto.discount !== undefined &&
      wasDebt &&
      invoice.debt &&
      cashPayments.length > 0
    ) {
      throw new BadRequestException(
        'لا يمكن تعديل الخصم — الدين عليه دفعات مسجلة. قم بتسوية الدين أولاً.',
      );
    }
```

- [ ] **Step 5: Reverse and re-apply credit inside the `update` transaction**

At the very top of `update`'s `$transaction` callback — before the stock restore in step `a` — insert:

```ts
        // Lock order: customer first, always. When the invoice is being moved
        // to a different customer both rows are locked, ordered by id, so two
        // opposite reassignments cannot deadlock.
        const lockIds = [...new Set([invoice.customerId, customerId].filter(Boolean))]
          .sort() as string[];
        const lockedById = new Map<string, Awaited<ReturnType<typeof lockCustomerForCredit>>>();
        for (const cid of lockIds) {
          lockedById.set(cid, await lockCustomerForCredit(tx, sid, cid));
        }

        // Reverse every credit this invoice consumed, back to the customer
        // who funded it — NOT to whoever the invoice is being moved to.
        // Crediting the new customer would transfer one person's money to
        // another with no ledger trace.
        if (invoice.debt && invoice.customerId) {
          const creditPayments = invoice.debt.payments.filter((p) => p.source === 'CREDIT');
          for (const p of creditPayments) {
            const original = lockedById.get(invoice.customerId)!;
            const amount = new Prisma.Decimal(p.amount);
            await tx.debtPayment.delete({ where: { id: p.id } });
            await tx.debt.update({
              where: { id: invoice.debt.id },
              data: {
                paid: { decrement: amount },
                remaining: { increment: amount },
                isPaid: false,
              },
            });
            const newBalance = await grantCredit(tx, {
              sid,
              customerId: invoice.customerId,
              currentBalance: original.creditBalance,
              amount,
              reason: 'APPLIED_REVERSED',
              notes: `إرجاع رصيد — تعديل الفاتورة رقم ${invoice.number}`,
            });
            original.creditBalance = newBalance;
          }
        }
```

Then, at the end of the same callback — after the `else if (wasDebt && needsCustomer && invoice.debt)` branch that updates the existing debt, and **before** `return updatedInvoice;` — insert:

```ts
        // Re-apply credit to whatever the recomputed debt still owes, from the
        // customer the invoice now belongs to.
        if (needsCustomer && customerId) {
          const freshDebt = await tx.debt.findFirst({
            where: { invoiceId: id },
            select: { id: true, remaining: true },
          });
          const holder = lockedById.get(customerId);
          if (freshDebt && holder && holder.creditBalance.gt(0)) {
            const debtRemaining = new Prisma.Decimal(freshDebt.remaining);
            if (debtRemaining.gt(0)) {
              await spendCreditOnDebt(tx, {
                sid,
                customerId,
                currentBalance: holder.creditBalance,
                debtId: freshDebt.id,
                debtRemaining,
                invoiceId: id,
              });
            }
          }
        }
```

Add the imports at the top of the file:

```ts
import { lockCustomerForCredit, grantCredit, spendCreditOnDebt } from '../debt/credit.tx';
```

Finally, replace `void this.cacheInvalidator.invalidateStoreData(sid);` at the end of `update` with `await this.cacheInvalidator.invalidateStoreData(sid);`.

- [ ] **Step 6: Make `remove` credit-aware**

In `src/modules/invoice/invoice.service.ts`, replace the guard in `remove`:

```ts
    // Only CASH locks an invoice. A credit-funded payment is reversible and is
    // refunded below — the old guard let a fully credit-covered invoice through
    // (isPaid was true) and cascade-deleted the customer's money with it.
    const cashPayments = invoice.debt?.payments.filter((p) => p.source === 'CASH') ?? [];
    if (invoice.debt && !invoice.debt.isPaid && cashPayments.length > 0) {
      throw new BadRequestException(
        'لا يمكن حذف فاتورة مرتبطة بدين عليه دفعات. قم بتسوية الدين أولاً.',
      );
    }
```

And inside `remove`'s `$transaction` callback, insert before the stock-restore loop:

```ts
        // Customer lock first — same rule as create/update.
        if (invoice.customerId) {
          const locked = await lockCustomerForCredit(tx, sid, invoice.customerId);
          let balance = locked.creditBalance;
          for (const p of invoice.debt?.payments ?? []) {
            if (p.source !== 'CREDIT') continue;
            balance = await grantCredit(tx, {
              sid,
              customerId: invoice.customerId,
              currentBalance: balance,
              amount: new Prisma.Decimal(p.amount),
              reason: 'APPLIED_REVERSED',
              notes: `إرجاع رصيد — حذف الفاتورة رقم ${invoice.number}`,
            });
          }
        }
```

`remove`'s `findFirst` must also select `customerId` and `number`. Add both to its top-level select if they are not already returned by the default row read.

Replace `void this.cacheInvalidator.invalidateStoreData(sid);` at the end of `remove` with `await this.cacheInvalidator.invalidateStoreData(sid);`.

- [ ] **Step 7: Make `deletePayment` credit-aware**

In `src/modules/debt/debt.service.ts`, replace the whole `deletePayment` method with:

```ts
  // ─── Delete a single payment (Admin only — reverses the payment) ──────────────
  //
  // Three cases beyond the original cash reversal:
  //   - a CREDIT payment refunds the customer's balance;
  //   - a CASH payment whose operation produced an unspent surplus withdraws
  //     that surplus, exactly once across all the operation's sibling payments;
  //   - a CASH payment whose surplus was already spent is refused, because
  //     unwinding it would require clawing money back out of a later invoice.

  async deletePayment(sid: string, debtId: string, paymentId: string): Promise<void> {
    await this.db.$transaction(
      async (tx) => {
        const debtOwner = await tx.debt.findFirst({
          where: { id: debtId, storeId: sid },
          select: { customerId: true },
        });
        if (!debtOwner) throw new NotFoundException('الدين غير موجود');

        // Customer lock first — same rule as every other credit path.
        const locked = await lockCustomerForCredit(tx, sid, debtOwner.customerId);

        const debtRows = await tx.$queryRaw<
          {
            id: string;
            paid: Prisma.Decimal;
            remaining: Prisma.Decimal;
            invoiceId: string | null;
          }[]
        >`
          SELECT id, paid, remaining, "invoiceId"
          FROM debts
          WHERE id = ${debtId} AND "storeId" = ${sid}
          FOR UPDATE
        `;
        if (debtRows.length === 0) throw new NotFoundException('الدين غير موجود');
        const debt = debtRows[0];

        const payment = await tx.debtPayment.findFirst({
          where: { id: paymentId, debtId },
          select: { id: true, amount: true, source: true, operationId: true },
        });
        if (!payment) throw new NotFoundException('الدفعة غير موجودة');

        const paymentAmount = new Prisma.Decimal(payment.amount);
        let balance = locked.creditBalance;

        if (payment.source === 'CREDIT') {
          balance = await grantCredit(tx, {
            sid,
            customerId: debtOwner.customerId,
            currentBalance: balance,
            amount: paymentAmount,
            reason: 'APPLIED_REVERSED',
            notes: 'إرجاع رصيد — حذف دفعة ممولة من الرصيد',
          });
        } else if (payment.operationId) {
          // The surplus belongs to the OPERATION, not to this one payment: one
          // operation can hold N cash payments and a single OVERPAYMENT entry.
          const overpay = await tx.creditEntry.findFirst({
            where: { operationId: payment.operationId, reason: 'OVERPAYMENT' },
            select: { delta: true },
          });
          if (overpay) {
            const alreadyWithdrawn = await tx.creditEntry.findFirst({
              where: { operationId: payment.operationId, reason: 'OVERPAYMENT_REVERSED' },
              select: { id: true },
            });
            // Without this check, deleting a second payment from the same
            // operation withdraws the same surplus again.
            if (!alreadyWithdrawn) {
              const surplus = new Prisma.Decimal(overpay.delta);
              if (balance.lt(surplus)) {
                throw new BadRequestException(
                  'لا يمكن حذف هذه الدفعة — الرصيد الناتج عنها تم استخدامه',
                );
              }
              balance = await takeCredit(tx, {
                sid,
                customerId: debtOwner.customerId,
                currentBalance: balance,
                amount: surplus,
                reason: 'OVERPAYMENT_REVERSED',
                operationId: payment.operationId,
                notes: 'سحب رصيد — حذف الدفعة التي ولّدته',
              });
            }
          }
        }

        await tx.debtPayment.delete({ where: { id: paymentId } });

        await tx.debt.update({
          where: { id: debtId },
          data: {
            paid: { decrement: paymentAmount },
            remaining: { increment: paymentAmount },
            isPaid: false,
          },
        });

        if (debt.invoiceId) {
          await tx.invoice.update({
            where: { id: debt.invoiceId },
            data: {
              paid: { decrement: paymentAmount },
              remaining: { increment: paymentAmount },
            },
          });
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    await this.cacheInvalidator.invalidateStoreData(sid);
  }
```

Add `takeCredit` to the `credit.tx` import at the top of `debt.service.ts`.

- [ ] **Step 8: Block archiving a customer who holds credit**

In `src/modules/customer/customer.service.ts`, in `remove`, extend the read and add the guard:

```ts
    const customer = await this.db.customer.findFirst({
      where: { id, storeId: sid, isDeleted: false },
      select: {
        id: true,
        creditBalance: true,
        debts: { select: { id: true, isPaid: true } },
      },
    });

    if (!customer) throw new NotFoundException('Customer not found');

    const hasUnpaidDebts = customer.debts.some((d) => !d.isPaid);
    if (hasUnpaidDebts) {
      throw new BadRequestException(
        'Cannot delete customer with outstanding unpaid debts. Settle all debts first.',
      );
    }

    // Archiving hides the row from /customers and /sync/init (both filter
    // isDeleted: false) while the shop still owes the money.
    if (new Prisma.Decimal(customer.creditBalance).gt(0)) {
      throw new BadRequestException(
        'لا يمكن أرشفة العميل — لديه رصيد لم يُستخدم بعد. اصرف الرصيد أو احذف الدفعة التي ولّدته أولاً.',
      );
    }
```

Then change `void this.cacheInvalidator.invalidateStoreData(sid);` at the end of `remove` to `await …`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: all Task 1, 3, 4, and 5 tests pass.

- [ ] **Step 10: Run the whole suite**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e`

Expected: all pass except the 4 known `error-handling` 401s. Pay particular attention to `invoice-discount.e2e-spec.ts` — the discount guard was rewritten.

- [ ] **Step 11: Checkpoint — report, do not commit**

Report: "Task 5 complete — every reversal path returns or withdraws credit correctly. Ready to commit." Suggested message:

```
feat(credit): reverse consumed credit on invoice delete, edit, and payment delete
```

---

### Task 6: Expose `creditBalance` and `balance` on read endpoints

**Files:**
- Modify: `src/modules/customer/customer.service.ts` (`findAll`, `findOne`, `getDebtSummary`)
- Modify: `src/modules/debt/debt.service.ts` (`findByCustomer`, `getSummary`)
- Modify: `test/customer-credit.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `signedBalance` from `../debt/credit.util`
- Produces: `creditBalance` and `balance` on customer reads and both debt-summary shapes; `totalCredit` and `netRemaining` on `GET /debts/summary`

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/customer-credit.e2e-spec.ts`:

```ts
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
      const credited = res.body.data.find((c: { id: string }) => c.id === creditedId);
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
      for (const key of ['totalAmount', 'totalPaid', 'totalRemaining', 'creditBalance', 'balance']) {
        expect(typeof res.body.summary[key]).toBe('string');
        // Decimal.toString() never pads — "50", never "50.00".
        expect(res.body.summary[key]).not.toMatch(/\.\d0$/);
      }
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: the Task 6 block fails on `undefined` fields.

- [ ] **Step 3: Add `creditBalance` and `balance` to `findByCustomer`**

In `src/modules/debt/debt.service.ts`, in `findByCustomer`, extend the customer read and the returned summary:

```ts
    const customer = await this.db.customer.findFirst({
      where: { id: customerId, storeId: sid, isDeleted: false },
      select: { id: true, name: true, phone: true, creditBalance: true },
    });
```

and in the `return`:

```ts
    const creditBalance = new Prisma.Decimal(customer.creditBalance);

    return {
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      summary: {
        totalDebts: debts.length,
        unpaidCount,
        totalAmount: totalAmount.toString(),
        totalPaid: totalPaid.toString(),
        totalRemaining: totalRemaining.toString(),
        totalDebt: totalAmount.toString(),
        creditBalance: creditBalance.toString(),
        balance: signedBalance(creditBalance, totalRemaining).toString(),
      },
      debts,
    };
```

- [ ] **Step 4: Add `totalCredit` and `netRemaining` to `getSummary`**

In `src/modules/debt/debt.service.ts`, replace `getSummary` with:

```ts
  async getSummary(sid: string) {
    const [allDebts, unpaidDebts, perCustomer, credits] = await this.db.$transaction([
      this.db.debt.aggregate({
        where: { storeId: sid },
        _sum: { amount: true, paid: true, remaining: true },
        _count: { id: true },
      }),
      this.db.debt.aggregate({
        where: { storeId: sid, isPaid: false },
        _sum: { remaining: true },
        _count: { id: true },
      }),
      this.db.debt.groupBy({
        by: ['customerId'],
        where: { storeId: sid, isPaid: false },
        _sum: { remaining: true },
      }),
      this.db.customer.findMany({
        // No isDeleted filter, deliberately: the existing totalRemaining above
        // aggregates debts with no customer filter at all, so it already counts
        // archived customers. Filtering only the new fields would leave the two
        // numbers unable to reconcile.
        where: { storeId: sid },
        select: { id: true, creditBalance: true },
      }),
    ]);

    const zero = new Prisma.Decimal(0);
    const creditById = new Map(
      credits.map((c) => [c.id, new Prisma.Decimal(c.creditBalance)]),
    );
    const totalCredit = credits.reduce(
      (acc, c) => acc.plus(new Prisma.Decimal(c.creditBalance)),
      zero,
    );

    // Netted PER CUSTOMER. One customer's credit does not settle another
    // customer's debt, so subtracting the store-wide totals would understate
    // what is actually owed.
    const netRemaining = perCustomer.reduce((acc, row) => {
      const owed = new Prisma.Decimal(row._sum.remaining ?? 0);
      const credit = creditById.get(row.customerId) ?? zero;
      return acc.plus(Prisma.Decimal.max(owed.minus(credit), zero));
    }, zero);

    return {
      totalDebts: allDebts._count.id,
      totalAmount: new Prisma.Decimal(allDebts._sum.amount ?? 0).toString(),
      totalPaid: new Prisma.Decimal(allDebts._sum.paid ?? 0).toString(),
      totalRemaining: new Prisma.Decimal(allDebts._sum.remaining ?? 0).toString(),
      unpaidCount: unpaidDebts._count.id,
      unpaidRemaining: new Prisma.Decimal(unpaidDebts._sum.remaining ?? 0).toString(),
      totalCredit: totalCredit.toString(),
      netRemaining: netRemaining.toString(),
    };
  }
```

- [ ] **Step 5: Add `balance` to the customer list and detail**

In `src/modules/customer/customer.service.ts`, add the import:

```ts
import { signedBalance } from '../debt/credit.util';
```

Replace the `return` of `findAll` with:

```ts
    // One groupBy for the whole page, not a query per row.
    const owed = await this.db.debt.groupBy({
      by: ['customerId'],
      where: { storeId: sid, isPaid: false, customerId: { in: data.map((c) => c.id) } },
      _sum: { remaining: true },
    });
    const owedById = new Map(
      owed.map((o) => [o.customerId, new Prisma.Decimal(o._sum.remaining ?? 0)]),
    );
    const zero = new Prisma.Decimal(0);

    const withBalance = data.map((c) => ({
      ...c,
      balance: signedBalance(
        new Prisma.Decimal(c.creditBalance),
        owedById.get(c.id) ?? zero,
      ).toString(),
    }));

    return paginatedResponse(withBalance, total, page, limit);
```

Widen the `PaginatedCustomers` type accordingly:

```ts
export type CustomerWithBalance = Customer & { balance: string };

export type PaginatedCustomers = {
  data: CustomerWithBalance[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};
```

In `findOne`, after the customer is fetched and the not-found check passes, compute and attach the same field:

```ts
    const owed = await this.db.debt.aggregate({
      where: { customerId: id, storeId: sid, isPaid: false },
      _sum: { remaining: true },
    });
    const totalRemaining = new Prisma.Decimal(owed._sum.remaining ?? 0);

    return {
      ...customer,
      balance: signedBalance(
        new Prisma.Decimal(customer.creditBalance),
        totalRemaining,
      ).toString(),
    };
```

- [ ] **Step 6: Add credit to the narrow `getDebtSummary`**

In `src/modules/customer/customer.service.ts`, in `getDebtSummary`, widen the select — this is the one customer read with an explicit `select`, so it is the one that silently drops the new column:

```ts
      select: { id: true, name: true, phone: true, creditBalance: true },
```

and extend the returned summary:

```ts
    const creditBalance = new Prisma.Decimal(customer.creditBalance);

    return {
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      summary: {
        totalDebt: totalDebt.toString(),
        totalPaid: totalPaid.toString(),
        totalRemaining: totalRemaining.toString(),
        unpaidCount,
        totalDebts: debts.length,
        totalAmount: totalDebt.toString(),
        creditBalance: creditBalance.toString(),
        balance: signedBalance(creditBalance, totalRemaining).toString(),
      },
      debts,
    };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: all tests through Task 6 pass.

- [ ] **Step 8: Checkpoint — report, do not commit**

Report: "Task 6 complete — creditBalance and signed balance on every read surface. Ready to commit." Suggested message:

```
feat(credit): expose creditBalance and signed balance on read endpoints
```

---

### Task 7: Reports

**Files:**
- Modify: `src/modules/invoice/invoice.service.ts` (`getDailySales`)
- Modify: `src/modules/backup/backup.service.ts` (`fetchCustomerDebts`)
- Modify: `test/customer-credit.e2e-spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `credit_entries` rows written by Tasks 3-5
- Produces: `totalCreditReceived` and `totalCreditApplied` on `GET /invoices/daily-sales`; net-of-credit debtor rows in the nightly PDF

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/customer-credit.e2e-spec.ts`:

```ts
  // ─── Task 7 — reports ─────────────────────────────────────────────────────
  describe('Credit in reports', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await bootstrap();
    });

    afterAll(async () => {
      await teardown(ctx);
    });

    const get = (path: string) =>
      request(ctx.server).get(path).set('Authorization', `Bearer ${ctx.token}`);

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
      const received = new Prisma.Decimal(before.body.summary.totalCreditReceived);

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

    it('leaves daily profit untouched by a pure credit movement', async () => {
      const before = await get('/api/reports/daily-profit');
      const netProfitBefore = before.body.netProfit ?? before.body.summary?.netProfit;

      const customer = await ctx.db.customer.create({
        data: { name: 'ProfitNeutral', storeId: ctx.storeId },
      });
      await ctx.db.debt.create({
        data: {
          amount: new Prisma.Decimal(20),
          paid: new Prisma.Decimal(0),
          remaining: new Prisma.Decimal(20),
          customerId: customer.id,
          storeId: ctx.storeId,
        },
      });
      await request(ctx.server)
        .post(`/api/debts/customer/${customer.id}/pay`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: 70 });

      const after = await get('/api/reports/daily-profit');
      const netProfitAfter = after.body.netProfit ?? after.body.summary?.netProfit;
      expect(netProfitAfter).toEqual(netProfitBefore);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: the first two fail on `undefined`.

- [ ] **Step 3: Add the credit lines to `getDailySales`**

In `src/modules/invoice/invoice.service.ts`, inside `getDailySales`, after the existing `invoices` query, add:

```ts
    // Credit movements are cash-vs-revenue, not sales. Two separate lines
    // because they mean opposite things: money that entered the drawer but is
    // not revenue, and revenue recognised without any cash arriving.
    //
    // Both are NET of their reversals — the CreditReason enum is directional
    // precisely so a same-day void nets out instead of leaving a phantom.
    const creditEntries = await this.db.creditEntry.findMany({
      where: { storeId: sid, date: { gte: startOfDay, lt: endOfDay } },
      select: { delta: true, reason: true },
    });

    const totalCreditReceived = creditEntries
      .filter((e) => e.reason === 'OVERPAYMENT' || e.reason === 'OVERPAYMENT_REVERSED')
      .reduce((acc, e) => acc.plus(new Prisma.Decimal(e.delta)), new Prisma.Decimal(0));

    const totalCreditApplied = creditEntries
      .filter((e) => e.reason === 'APPLIED_TO_DEBT' || e.reason === 'APPLIED_REVERSED')
      .reduce((acc, e) => acc.minus(new Prisma.Decimal(e.delta)), new Prisma.Decimal(0));
```

and extend the returned `summary`:

```ts
        totalDebt: totalDebt.toString(),
        totalCreditReceived: totalCreditReceived.toString(),
        totalCreditApplied: totalCreditApplied.toString(),
```

- [ ] **Step 4: Net credit before ranking debtors in the nightly PDF**

In `src/modules/backup/backup.service.ts`, replace `fetchCustomerDebts` with:

```ts
  private async fetchCustomerDebts(
    storeId: string,
  ): Promise<CustomerDebtRow[]> {
    const customers = await this.db.customer.findMany({
      where: {
        storeId,
        debts: { some: { isPaid: false } },
      },
      select: {
        name: true,
        phone: true,
        creditBalance: true,
        debts: {
          where: { isPaid: false },
          select: { remaining: true, date: true },
        },
      },
    });

    const now = Date.now();
    const rows = customers.flatMap<CustomerDebtRow>((c) => {
      const gross = c.debts.reduce(
        (acc, d) => acc.plus(new Prisma.Decimal(d.remaining)),
        new Prisma.Decimal(0),
      );
      // Net the customer's own credit against their own debt. A customer whose
      // credit covers what they owe is not a debtor and must not appear in the
      // "الأولوية القصوى" list or in debtorCount.
      const net = gross.minus(new Prisma.Decimal(c.creditBalance));
      if (net.lte(0)) return [];

      const oldestMs = c.debts.reduce(
        (min, d) => Math.min(min, d.date.getTime()),
        now,
      );
      const oldestDebtDays = Math.max(0, Math.floor((now - oldestMs) / DAY_MS));

      return [
        {
          name: c.name,
          phone: c.phone,
          totalRemaining: net,
          debtCount: c.debts.length,
          // Deliberate simplification: for a partially covered customer the
          // amount is netted but the age is not. Notional settlement does not
          // pick a specific debt, and attributing credit to the oldest one
          // would shift the aging bucket with no real ledger movement. This
          // number is an attention flag, not an accounting figure.
          oldestDebtDays,
        },
      ];
    });

    rows.sort((a, b) => b.totalRemaining.comparedTo(a.totalRemaining));
    return rows;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- customer-credit`

Expected: all tests through Task 7 pass.

- [ ] **Step 6: Verify the timezone tripwire**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e -- report-timezone`

Expected: pass. `getDailyProfit` was not touched; if this fails, a credit read leaked into the profit path.

- [ ] **Step 7: Checkpoint — report, do not commit**

Report: "Task 7 complete — credit reported as its own line, debtor list netted. Ready to commit." Suggested message:

```
feat(credit): report credit received and applied, net credit in the debt PDF
```

---

### Task 8: Frontend contract doc and final verification

**Files:**
- Modify: `docs/API_CHANGES_FOR_FRONTEND.md`

**Interfaces:**
- Consumes: everything from Tasks 1-7
- Produces: nothing in code

- [ ] **Step 1: Append the credit section to the frontend contract doc**

Add to `docs/API_CHANGES_FOR_FRONTEND.md`:

```markdown
## رصيد الزبون (Customer Credit) — 2026-08-23

### ترتيب النشر إلزامي: الباك‌إند أولاً

`ValidationPipe` مضبوط على `forbidNonWhitelisted: true`. أي واجهة تبعت
`clientOperationId` قبل نزول الباك‌إند بتاخد
`400 property clientOperationId should not exist` — يعني زر الدفع بيتوقف كلياً،
مش بيتدهور.

### `POST /api/debts/customer/:customerId/pay`

نفس المسار ونفس الحالة (`201`). الجديد:

- الطلب بيقبل `clientOperationId` اختياري (نص، حد أقصى ٢٠٠ حرف). إعادة نفس
  المُعرّف بترجّع نتيجة العملية الأصلية بدون تحريك أي مبلغ. طلبان متزامنان
  بنفس المُعرّف: واحد `201` وواحد `409`.
- الدفع الزائد صار **مقبول**. الفائض بينحفظ كرصيد للزبون.
- زبون ما عليه ديون صار يقدر يدفع — كامل المبلغ بيصير رصيد.
- حقول جديدة في الرد: `creditApplied`, `excessToCredit`, `debts`,
  و `summary.totalDebt` / `summary.creditBalance` / `summary.balance`.
- كل صف في `affectedDebts` صار عنده `creditPaid` جنب `amountPaid`.
  **`amountPaid` هو الكاش فقط** (نفس معناه اليوم)، والرصيد المستهلَك في
  `creditPaid`. `paymentApplied` هو الكاش **المُسلَّم** من الزبون، مش الكاش
  اللي انصرف على الديون — لما في فائض، الفرق بينهم بيروح لـ `excessToCredit`.
  العلاقتان اللي بتنمسكا دايماً هما:
  `Σ amountPaid + excessToCredit = paymentApplied` و
  `Σ creditPaid = creditApplied`.
- `debts` بيرجّع **كل ديون العميل** بعد العملية — المسدَّدة والمفتوحة.

### قاعدة الإشارة

```
balance = creditBalance − totalRemaining
```

سالب = على الزبون دين. موجب = المحل مدين له. صفر = متساويين.

### حقول جديدة على القراءة

| المسار | الجديد |
|---|---|
| `GET /api/customers` | `creditBalance`, `balance` على كل صف |
| `GET /api/customers/:id` | `creditBalance`, `balance` |
| `GET /api/customers/:id/debt-summary` | `creditBalance`, `balance`, `totalAmount` |
| `GET /api/debts/customer/:id` | `creditBalance`, `balance`, `totalDebt` |
| `GET /api/debts/summary` | `totalCredit`, `netRemaining` |
| `GET /api/invoices/daily-sales` | `totalCreditReceived`, `totalCreditApplied` |
| `GET /api/sync/init` | `creditBalance` ضمن صفوف الزبائن |

ولا حقل قائم اتغيّر اسمه أو نوعه أو معناه.

⚠️ `summary.totalDebts` **عدد** الديون. `summary.totalDebt` **مبلغ**. الاسمان
متشابهان لمطابقة عقد الـ handoff.

### صيغة المبالغ

كل المبالغ نصوص `Decimal.toString()` **بدون عدد منازل مضمون** — `"50"` مش
`"50.00"`، و`"0"` مش `"0.00"`. هذي صيغة كل مبلغ في الـ API اليوم، مش قاعدة
جديدة. استعملوا `parseFloat` أو مكتبة decimal، ولا تقارنوا نصوص.

### سلوك جديد لازم تعرفوه

1. **فاتورة دين لزبون عنده رصيد بتأكل منه أوتوماتيك** — `DEBT` و `PARTIAL`
   الاتنين. الفاتورة بترجع بـ `paid` أكبر من صفر من أول لحظة.
2. **بيعة دين أوف‌لاين ما بتأكل رصيد** وقت الرفع عبر `POST /sync/push`. الرصيد
   بيضل محفوظ وبيتقاصّ بأول دفعة أو فاتورة أونلاين بعدها. الرقم الموقَّع
   (`balance`) صحيح بكل الأحوال لأنه محسوب من الطرفين.
3. **`POST /debts/:id/pay` (الدين المفرد) ما بيقبل دفع زائد** وما بيدعم
   `clientOperationId`. خارج النطاق عمداً.
4. **حذف دفعة كاش ولّدت رصيداً انصرف بيرجع `400`** برسالة
   `لا يمكن حذف هذه الدفعة — الرصيد الناتج عنها تم استخدامه`.
5. **أرشفة زبون معه رصيد بترجع `400`.**
6. حذف أو تعديل فاتورة أكلت رصيداً بيرجّع الرصيد للزبون تلقائياً.
```

- [ ] **Step 2: Run the full unit suite**

Run: `npx jest src/`

Expected: all pass, including the 17 `credit.util` tests.

- [ ] **Step 3: Run the full e2e suite**

Run: `DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e`

Expected: all specs pass except the 4 known pre-existing 401 failures in `error-handling.e2e-spec.ts`. Record the exact pass/fail counts in the report.

- [ ] **Step 4: Verify the build compiles**

Run: `npm run build`

Expected: no TypeScript errors.

- [ ] **Step 5: Lint every changed file**

Run:

```bash
npx eslint src/modules/debt src/modules/invoice/invoice.service.ts src/modules/customer/customer.service.ts src/modules/backup/backup.service.ts test/customer-credit.e2e-spec.ts
```

Expected: no output. Do **not** add `--fix`.

- [ ] **Step 6: Confirm the migration is still additive**

Run: `cat prisma/migrations/*_add_customer_credit/migration.sql | grep -nE "UPDATE|DROP|SET NOT NULL|DELETE"`

Expected: no output. Any hit means the migration would rewrite production data — stop and report.

- [ ] **Step 7: Final checkpoint — report, do not commit**

Report to the user:
- exact pass/fail counts for `npx jest src/` and `npm run test:e2e`
- confirmation that `ledger-integrity`, `sync`, and `report-timezone` are green
- confirmation that `npm run build` is clean
- the full list of changed and created files

Suggested message:

```
docs(credit): document the customer credit contract for the frontend
```

Then stop. The user commits, pushes, and opens the PR against `development`.

---

## Deployment Order

1. Merge this work into `development`, verify against a staging or local database.
2. Release backend to production (merge to `main` → Railway builds → the container's `CMD` runs `prisma migrate deploy` before the app starts).
3. Verify in production: an overpayment stores credit, a replayed `clientOperationId` is a no-op, a new debt invoice consumes credit.
4. Only then release the frontend.

Reversing steps 2 and 4 takes the pay button down completely — see the `forbidNonWhitelisted` note in Global Constraints.
