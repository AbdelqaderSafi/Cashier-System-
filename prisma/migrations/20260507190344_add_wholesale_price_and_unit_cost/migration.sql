-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "unitCost" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "wholesalePrice" DECIMAL(10,2) NOT NULL DEFAULT 0;
