-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'ONLINE';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "storeId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "products_storeId_idx" ON "products"("storeId");
