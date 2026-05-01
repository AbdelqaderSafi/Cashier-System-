/*
  Warnings:

  - You are about to drop the column `isActive` on the `stores` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "StoreStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- AlterTable
ALTER TABLE "stores" DROP COLUMN "isActive",
ADD COLUMN     "status" "StoreStatus" NOT NULL DEFAULT 'PENDING';
