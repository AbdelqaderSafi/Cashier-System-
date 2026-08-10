import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import {
  assertCartonGroupValid,
  isCartonGroupComplete,
  openingStockFromCartons,
  unitCostFromCarton,
} from './carton.util';

describe('isCartonGroupComplete', () => {
  it('is true only when all three fields are present', () => {
    expect(
      isCartonGroupComplete({
        piecesPerCarton: 24,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      }),
    ).toBe(true);
  });

  it('is false when any field is missing', () => {
    expect(
      isCartonGroupComplete({ piecesPerCarton: 24, cartonPurchasePrice: 48 }),
    ).toBe(false);
    expect(isCartonGroupComplete({})).toBe(false);
  });
});

describe('assertCartonGroupValid', () => {
  it('accepts a complete group', () => {
    expect(() =>
      assertCartonGroupValid({
        piecesPerCarton: 24,
        cartonPurchasePrice: 48,
        cartonSalePrice: 60,
      }),
    ).not.toThrow();
  });

  it('accepts an entirely empty group', () => {
    expect(() => assertCartonGroupValid({})).not.toThrow();
    expect(() =>
      assertCartonGroupValid({
        piecesPerCarton: null,
        cartonPurchasePrice: null,
        cartonSalePrice: null,
      }),
    ).not.toThrow();
  });

  it('rejects a partial group', () => {
    expect(() =>
      assertCartonGroupValid({ piecesPerCarton: 24, cartonPurchasePrice: 48 }),
    ).toThrow(BadRequestException);
    expect(() => assertCartonGroupValid({ cartonSalePrice: 60 })).toThrow(
      BadRequestException,
    );
  });

  it('treats a Decimal-valued group (a row read back from the DB) as complete', () => {
    expect(() =>
      assertCartonGroupValid({
        piecesPerCarton: 24,
        cartonPurchasePrice: new Prisma.Decimal(48),
        cartonSalePrice: new Prisma.Decimal(60),
      }),
    ).not.toThrow();
  });
});

describe('unitCostFromCarton', () => {
  it('divides the carton purchase price by the carton size', () => {
    expect(unitCostFromCarton(48, 24).equals(2)).toBe(true);
  });

  it('accepts a Decimal purchase price', () => {
    expect(unitCostFromCarton(new Prisma.Decimal(48), 24).equals(2)).toBe(true);
  });

  it('rounds to 2 decimal places to match the DECIMAL(10,2) column', () => {
    // 100 / 3 = 33.3333... — the returned Decimal must carry no more
    // precision than the column. Asserting on toString() (not toFixed(),
    // which rounds for display regardless) is what makes this test fail if
    // the .toDecimalPlaces(2) call is ever dropped.
    const cost = unitCostFromCarton(100, 3);
    expect(cost.toString()).toBe('33.33');
    expect(cost.decimalPlaces()).toBe(2);
  });
});

describe('openingStockFromCartons', () => {
  it('adds loose pieces on top of the carton pieces', () => {
    expect(openingStockFromCartons(2, 24, 5)).toBe(53);
  });

  it('handles zero loose pieces', () => {
    expect(openingStockFromCartons(2, 24, 0)).toBe(48);
  });

  it('handles zero cartons', () => {
    expect(openingStockFromCartons(0, 24, 7)).toBe(7);
  });
});
