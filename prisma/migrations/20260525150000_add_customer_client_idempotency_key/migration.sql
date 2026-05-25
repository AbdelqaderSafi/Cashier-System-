-- Mirror the invoice idempotency key on customers — offline-created customers
-- (where the frontend's outbox can re-send the same record after a flaky
-- network drop) now dedupe by (storeId, clientCustomerId) instead of stacking
-- duplicates on every retry.
ALTER TABLE "customers" ADD COLUMN "clientCustomerId" TEXT;

-- NULLs are treated as distinct in PostgreSQL unique indexes, so existing
-- rows (and any future online-only customer that omits the key) coexist
-- without constraint violations.
CREATE UNIQUE INDEX "customers_storeId_clientCustomerId_key"
  ON "customers" ("storeId", "clientCustomerId");
