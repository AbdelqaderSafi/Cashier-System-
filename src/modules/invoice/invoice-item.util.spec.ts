import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import {
  buildInvoiceItem,
  stockPiecesOf,
  type PricingProduct,
} from './invoice-item.util';

const cartonProduct: PricingProduct = {
  id: 'p1',
  name: 'Pepsi 330ml',
  barcode: '6001',
  price: new Prisma.Decimal(3),
  wholesalePrice: new Prisma.Decimal(2),
  piecesPerCarton: 24,
  cartonPurchasePrice: new Prisma.Decimal(48),
  cartonSalePrice: new Prisma.Decimal(60),
};

const plainProduct: PricingProduct = {
  id: 'p2',
  name: 'Loose Item',
  barcode: null,
  price: new Prisma.Decimal(10),
  wholesalePrice: new Prisma.Decimal(6),
  piecesPerCarton: null,
  cartonPurchasePrice: null,
  cartonSalePrice: null,
};

describe('buildInvoiceItem — piece sales', () => {
  it('prices from the product price and wholesale price', () => {
    const item = buildInvoiceItem(plainProduct, 3);
    expect(item.price.equals(10)).toBe(true);
    expect(item.unitCost.equals(6)).toBe(true);
    expect(item.total.equals(30)).toBe(true);
    expect(item.saleUnit).toBe('UNIT');
    expect(item.stockQuantity).toBe(3);
    expect(item.productId).toBe('p2');
    expect(item.productName).toBe('Loose Item');
    expect(item.barcode).toBeNull();
  });

  it('treats an explicit UNIT the same as an omitted saleUnit', () => {
    expect(buildInvoiceItem(plainProduct, 3, 'UNIT')).toEqual(
      buildInvoiceItem(plainProduct, 3),
    );
  });

  it('sells pieces of a carton product at the piece price', () => {
    const item = buildInvoiceItem(cartonProduct, 3, 'UNIT');
    expect(item.price.equals(3)).toBe(true);
    expect(item.unitCost.equals(2)).toBe(true);
    expect(item.stockQuantity).toBe(3);
  });
});

describe('buildInvoiceItem — carton sales', () => {
  it('prices from the carton prices and deducts whole cartons in pieces', () => {
    const item = buildInvoiceItem(cartonProduct, 2, 'CARTON');
    expect(item.price.equals(60)).toBe(true);
    expect(item.unitCost.equals(48)).toBe(true);
    expect(item.total.equals(120)).toBe(true); // 60 × 2 cartons
    expect(item.quantity).toBe(2); // cartons
    expect(item.stockQuantity).toBe(48); // 2 × 24 pieces
    expect(item.saleUnit).toBe('CARTON');
  });

  it('rejects a carton sale of a product with no carton data', () => {
    expect(() => buildInvoiceItem(plainProduct, 1, 'CARTON')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a carton sale when the group is incomplete', () => {
    expect(() =>
      buildInvoiceItem(
        { ...cartonProduct, cartonSalePrice: null },
        1,
        'CARTON',
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a carton sale when only piecesPerCarton is missing', () => {
    // Without this case, deleting the `piecesPerCarton == null` clause from the
    // guard would go unnoticed — and `quantity * null` writes NaN toward the
    // stock ledger rather than failing loudly.
    expect(() =>
      buildInvoiceItem({ ...cartonProduct, piecesPerCarton: null }, 1, 'CARTON'),
    ).toThrow(BadRequestException);
  });

  it('rejects a carton sale when only cartonPurchasePrice is missing', () => {
    // Without this case, deleting the `cartonPurchasePrice == null` clause
    // would surface as a raw Decimal error (500) instead of an Arabic 400.
    expect(() =>
      buildInvoiceItem(
        { ...cartonProduct, cartonPurchasePrice: null },
        1,
        'CARTON',
      ),
    ).toThrow(BadRequestException);
  });
});

describe('stockPiecesOf', () => {
  it('uses stockQuantity when present', () => {
    expect(stockPiecesOf({ quantity: 2, stockQuantity: 48 })).toBe(48);
  });

  it('falls back to quantity for pre-migration rows', () => {
    expect(stockPiecesOf({ quantity: 3, stockQuantity: null })).toBe(3);
  });

  it('does not treat a legitimate zero as missing', () => {
    expect(stockPiecesOf({ quantity: 5, stockQuantity: 0 })).toBe(0);
  });
});
