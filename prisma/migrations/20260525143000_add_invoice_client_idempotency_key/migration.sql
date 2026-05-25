-- Add the optional client-supplied idempotency key. The frontend sends its
-- offline localId here; the (storeId, clientInvoiceId) unique index turns
-- retries-after-network-drop into a no-op instead of a duplicate invoice.
ALTER TABLE "invoices" ADD COLUMN "clientInvoiceId" TEXT;

-- Per-store uniqueness. PostgreSQL treats NULLs as distinct in unique indexes
-- by default, so existing rows (and any future online-only invoice that omits
-- the key) coexist without constraint violations.
CREATE UNIQUE INDEX "invoices_storeId_clientInvoiceId_key"
  ON "invoices" ("storeId", "clientInvoiceId");
