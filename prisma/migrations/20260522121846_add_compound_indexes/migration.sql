-- DropIndex
DROP INDEX "products_storeId_idx";

-- CreateIndex
CREATE INDEX "customers_storeId_createdAt_idx" ON "customers"("storeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "customers_storeId_name_idx" ON "customers"("storeId", "name");

-- CreateIndex
CREATE INDEX "debt_payments_debtId_date_idx" ON "debt_payments"("debtId", "date" DESC);

-- CreateIndex
CREATE INDEX "debts_storeId_isPaid_date_idx" ON "debts"("storeId", "isPaid", "date" DESC);

-- CreateIndex
CREATE INDEX "debts_storeId_customerId_isPaid_idx" ON "debts"("storeId", "customerId", "isPaid");

-- CreateIndex
CREATE INDEX "debts_customerId_idx" ON "debts"("customerId");

-- CreateIndex
CREATE INDEX "invoice_items_invoiceId_idx" ON "invoice_items"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_items_productId_idx" ON "invoice_items"("productId");

-- CreateIndex
CREATE INDEX "invoices_storeId_date_idx" ON "invoices"("storeId", "date" DESC);

-- CreateIndex
CREATE INDEX "invoices_storeId_paymentMethod_date_idx" ON "invoices"("storeId", "paymentMethod", "date");

-- CreateIndex
CREATE INDEX "invoices_storeId_customerId_date_idx" ON "invoices"("storeId", "customerId", "date" DESC);

-- CreateIndex
CREATE INDEX "invoices_customerId_idx" ON "invoices"("customerId");

-- CreateIndex
CREATE INDEX "products_storeId_isActive_idx" ON "products"("storeId", "isActive");

-- CreateIndex
CREATE INDEX "products_storeId_name_idx" ON "products"("storeId", "name");

-- CreateIndex
CREATE INDEX "users_storeId_role_idx" ON "users"("storeId", "role");
