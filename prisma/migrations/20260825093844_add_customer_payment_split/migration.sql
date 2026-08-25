-- Make the customer-payment record readable.
--
-- debt_payment_operations already stored the FULL amount taken across the
-- counter, but nothing ever read it — the row existed purely to anchor the
-- idempotency key. These three columns turn it into the payment record the
-- shop actually needs: 150 received, 100 applied to debt, 50 added to credit.
--
-- Additive only: three nullable ADD COLUMNs, no DEFAULT, so this is
-- metadata-only in PostgreSQL 11+ and does not rewrite the table.
--
-- Deliberately NULLABLE rather than DEFAULT 0. Rows written before this
-- migration have an UNKNOWN split, not a zero one, and backfilling them is
-- forbidden by the additive-only rule this repo follows for production. The
-- read path derives the split from the linked debt_payments and credit_entries
-- when these are null, so historical rows report the truth instead of zeros.
--
-- appliedToDebt/addedToCredit are stored rather than always derived because
-- deleting an invoice cascades its debt_payments away; a derived figure would
-- then silently rewrite what the customer was recorded as having paid.
ALTER TABLE "debt_payment_operations" ADD COLUMN "appliedToDebt" DECIMAL(10,2);
ALTER TABLE "debt_payment_operations" ADD COLUMN "addedToCredit" DECIMAL(10,2);
ALTER TABLE "debt_payment_operations" ADD COLUMN "notes" TEXT;
