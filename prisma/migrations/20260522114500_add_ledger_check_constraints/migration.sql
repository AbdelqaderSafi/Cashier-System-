-- Ledger integrity safety-net: even if application code regresses, the DB
-- refuses to write a balance that doesn't reconcile.
--
-- These constraints intentionally use `=` rather than a tolerance window
-- because every column is stored as DECIMAL(10,2), so arithmetic is exact.

-- Debts: paid + remaining must equal amount, and neither column may go
-- negative.
ALTER TABLE "debts"
  ADD CONSTRAINT "debt_balance_consistent"
  CHECK (paid + remaining = amount AND paid >= 0 AND remaining >= 0);

-- Invoices: same invariant on total/paid/remaining, plus total must be
-- strictly positive (zero-total invoices are never legitimate in this POS).
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoice_balance_consistent"
  CHECK (paid + remaining = total AND paid >= 0 AND remaining >= 0 AND total > 0);

-- Products: stock can never be negative — the atomic-decrement UPDATE in
-- InvoiceService already filters on `stock >= qty`, but this is the final
-- backstop against any other write path.
ALTER TABLE "products"
  ADD CONSTRAINT "stock_non_negative"
  CHECK (stock >= 0);
