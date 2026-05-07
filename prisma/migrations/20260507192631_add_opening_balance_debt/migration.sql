-- AlterTable
ALTER TABLE "debts" ADD COLUMN     "notes" TEXT,
ALTER COLUMN "invoiceId" DROP NOT NULL;
