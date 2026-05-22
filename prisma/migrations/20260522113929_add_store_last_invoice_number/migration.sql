-- AlterTable: add the atomic counter column with a safe default.
ALTER TABLE "stores" ADD COLUMN "lastInvoiceNumber" INTEGER NOT NULL DEFAULT 0;

-- Backfill: seed the counter for any store that already has invoices so the
-- next allocated number doesn't collide with existing rows on the
-- (number, storeId) unique index. Stores with no invoices stay at 0.
UPDATE "stores" s
SET "lastInvoiceNumber" = COALESCE(
  (SELECT MAX(number) FROM "invoices" WHERE "storeId" = s.id),
  0
);
