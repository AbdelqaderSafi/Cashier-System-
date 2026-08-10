-- Invoice-level discount. Additive only: no existing row is read or rewritten.
--
-- A constant DEFAULT is metadata-only in PostgreSQL 11+, so this does NOT
-- rewrite the invoices table; every existing invoice reads as 0.
--
-- Note that `invoices.total` stores the NET amount (gross − discount). It has
-- to: invoice_balance_consistent (added in 20260522114500) enforces
-- paid + remaining = total AND total > 0.
ALTER TABLE "invoices" ADD COLUMN "discount" DECIMAL(10,2) NOT NULL DEFAULT 0;
