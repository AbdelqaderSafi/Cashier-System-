import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';

/**
 * The three fields that together make a product sellable by the carton.
 * Values may arrive as numbers (from a DTO) or as Decimals (from a DB row),
 * so both are accepted — every check here is presence-only.
 */
export type CartonGroup = {
  piecesPerCarton?: number | null;
  cartonPurchasePrice?: number | Prisma.Decimal | null;
  cartonSalePrice?: number | Prisma.Decimal | null;
};

export function isCartonGroupComplete(g: CartonGroup): boolean {
  return (
    g.piecesPerCarton != null &&
    g.cartonPurchasePrice != null &&
    g.cartonSalePrice != null
  );
}

function isCartonGroupEmpty(g: CartonGroup): boolean {
  return (
    g.piecesPerCarton == null &&
    g.cartonPurchasePrice == null &&
    g.cartonSalePrice == null
  );
}

/**
 * All three or none.
 *
 * A partial group (pieces + purchase price, no sale price) looks like a carton
 * product in the UI but fails at the first carton sale, so it is rejected at
 * write time rather than left to surface a week later.
 */
export function assertCartonGroupValid(g: CartonGroup): void {
  if (!isCartonGroupComplete(g) && !isCartonGroupEmpty(g)) {
    throw new BadRequestException(
      'بيانات الكرتونة غير مكتملة — يجب إرسال عدد القطع في الكرتونة وسعر شراء الكرتونة وسعر بيع الكرتونة معاً، أو عدم إرسال أي منها',
    );
  }
}

/**
 * Cost of a single piece, derived from the carton purchase price.
 *
 * Rounded to 2dp to match the DECIMAL(10,2) column — a carton size that does
 * not divide evenly leaves a sub-cent drift on piece sales, which is accepted
 * (see spec §12).
 */
export function unitCostFromCarton(
  cartonPurchasePrice: number | Prisma.Decimal,
  piecesPerCarton: number,
): Prisma.Decimal {
  return new Prisma.Decimal(cartonPurchasePrice)
    .dividedBy(piecesPerCarton)
    .toDecimalPlaces(2);
}

/**
 * Opening stock in PIECES.
 *
 * `loosePieces` is the "الكمية" field from the product form. In carton mode the
 * owner uses it for pieces held outside a full carton, so it adds on top of the
 * carton pieces rather than replacing them.
 */
export function openingStockFromCartons(
  cartonCount: number,
  piecesPerCarton: number,
  loosePieces: number,
): number {
  return cartonCount * piecesPerCarton + loosePieces;
}
