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
