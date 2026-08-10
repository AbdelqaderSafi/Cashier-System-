import { BadRequestException } from '@nestjs/common';
import { Prisma, type SaleUnit } from 'generated/prisma/client';

/** The product columns needed to price an invoice line. */
export type PricingProduct = {
  id: string;
  name: string;
  barcode: string | null;
  price: Prisma.Decimal;
  wholesalePrice: Prisma.Decimal;
  piecesPerCarton: number | null;
  cartonPurchasePrice: Prisma.Decimal | null;
  cartonSalePrice: Prisma.Decimal | null;
};

/** A fully-priced invoice line, shaped for a Prisma nested create. */
export type BuiltInvoiceItem = {
  productName: string;
  barcode: string | null;
  price: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  quantity: number;
  total: Prisma.Decimal;
  saleUnit: SaleUnit;
  stockQuantity: number;
  productId: string;
};

/**
 * Prices one line from the DB product row. Client-sent prices and carton
 * sizes are never consulted — the caller passes only a product id, a
 * quantity, and the unit being sold.
 *
 * `quantity` is counted in `saleUnit`s (pieces or cartons). `stockQuantity`
 * is always in pieces and is what the stock ledger moves by; storing it on
 * the line freezes the carton size at sale time, so later edits to
 * `piecesPerCarton` cannot corrupt an old invoice's stock restore.
 */
export function buildInvoiceItem(
  product: PricingProduct,
  quantity: number,
  saleUnit: SaleUnit = 'UNIT',
): BuiltInvoiceItem {
  if (saleUnit === 'CARTON') {
    if (
      product.piecesPerCarton == null ||
      product.cartonSalePrice == null ||
      product.cartonPurchasePrice == null
    ) {
      throw new BadRequestException(
        `المنتج "${product.name}" غير معرّف كمنتج كرتونة — لا يمكن بيعه بالكرتونة`,
      );
    }
    const price = new Prisma.Decimal(product.cartonSalePrice);
    return {
      productName: product.name,
      barcode: product.barcode,
      price,
      unitCost: new Prisma.Decimal(product.cartonPurchasePrice),
      quantity,
      total: price.times(quantity),
      saleUnit: 'CARTON',
      stockQuantity: quantity * product.piecesPerCarton,
      productId: product.id,
    };
  }

  const price = new Prisma.Decimal(product.price);
  return {
    productName: product.name,
    barcode: product.barcode,
    price,
    unitCost: new Prisma.Decimal(product.wholesalePrice),
    quantity,
    total: price.times(quantity),
    saleUnit: 'UNIT',
    stockQuantity: quantity,
    productId: product.id,
  };
}

/**
 * Pieces to move on the stock ledger for a line already stored in the DB.
 *
 * Lines written before carton support have `stockQuantity = NULL` and were
 * always piece sales, so `quantity` is their correct piece count. Every
 * restore and deduct path MUST go through this helper — reading
 * `stockQuantity` directly silently restores the wrong amount for every
 * legacy invoice.
 */
export function stockPiecesOf(item: {
  quantity: number;
  stockQuantity: number | null;
}): number {
  return item.stockQuantity ?? item.quantity;
}
