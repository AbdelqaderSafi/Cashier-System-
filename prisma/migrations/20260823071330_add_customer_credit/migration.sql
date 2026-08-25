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
