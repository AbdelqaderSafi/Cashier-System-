import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { applyInvoiceDiscount } from './invoice-discount.util';

const gross = (n: number) => new Prisma.Decimal(n);

describe('applyInvoiceDiscount', () => {
  it('subtracts the discount from the gross total', () => {
    const result = applyInvoiceDiscount(gross(60), 10);
    expect(result.total.equals(50)).toBe(true);
    expect(result.discount.equals(10)).toBe(true);
  });

  it('treats an omitted discount as zero and leaves the total untouched', () => {
    const result = applyInvoiceDiscount(gross(60));
    expect(result.total.equals(60)).toBe(true);
    expect(result.discount.equals(0)).toBe(true);
  });

  it('treats null the same as omitted', () => {
    const result = applyInvoiceDiscount(gross(60), null);
    expect(result.total.equals(60)).toBe(true);
    expect(result.discount.equals(0)).toBe(true);
  });

  it('accepts an explicit zero', () => {
    const result = applyInvoiceDiscount(gross(60), 0);
    expect(result.total.equals(60)).toBe(true);
    expect(result.discount.equals(0)).toBe(true);
  });

  it('accepts a Decimal discount (a value read back from a DB row)', () => {
    const result = applyInvoiceDiscount(gross(60), new Prisma.Decimal(10));
    expect(result.total.equals(50)).toBe(true);
  });

  it('keeps two-decimal precision', () => {
    const result = applyInvoiceDiscount(gross(60), 10.55);
    expect(result.total.toFixed(2)).toBe('49.45');
  });

  it('rejects a discount equal to the gross total', () => {
    // A zero net violates CHECK (total > 0) and would surface as an unmapped
    // 500 from the database instead of a readable message.
    expect(() => applyInvoiceDiscount(gross(60), 60)).toThrow(BadRequestException);
  });

  it('rejects a discount larger than the gross total', () => {
    expect(() => applyInvoiceDiscount(gross(60), 70)).toThrow(BadRequestException);
  });

  it('rejects a negative discount', () => {
    expect(() => applyInvoiceDiscount(gross(60), -5)).toThrow(BadRequestException);
  });
});
