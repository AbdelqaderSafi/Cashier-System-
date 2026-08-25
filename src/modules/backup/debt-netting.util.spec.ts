import { Prisma } from 'generated/prisma/client';
import { netCustomerDebt } from './debt-netting.util';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('netCustomerDebt', () => {
  it('drops a customer whose credit fully covers their debt', () => {
    const result = netCustomerDebt({
      grossRemaining: d(100),
      creditBalance: d(150),
      oldestDebtDays: 10,
    });
    expect(result).toBeNull();
  });

  it('drops a customer whose credit exactly equals their debt', () => {
    const result = netCustomerDebt({
      grossRemaining: d(100),
      creditBalance: d(100),
      oldestDebtDays: 10,
    });
    expect(result).toBeNull();
  });

  it('nets the amount for a partially covered customer and leaves the age untouched', () => {
    const result = netCustomerDebt({
      grossRemaining: d(100),
      creditBalance: d(40),
      oldestDebtDays: 45,
    });
    expect(result).not.toBeNull();
    expect(result!.totalRemaining.equals(60)).toBe(true);
    expect(result!.oldestDebtDays).toBe(45);
  });

  it('leaves the gross amount unchanged when the customer holds no credit', () => {
    const result = netCustomerDebt({
      grossRemaining: d(75),
      creditBalance: d(0),
      oldestDebtDays: 3,
    });
    expect(result).not.toBeNull();
    expect(result!.totalRemaining.equals(75)).toBe(true);
    expect(result!.oldestDebtDays).toBe(3);
  });

  it('nets a fractional case with exact Decimal arithmetic, no float drift', () => {
    const result = netCustomerDebt({
      grossRemaining: d('100.33'),
      creditBalance: d('25.11'),
      oldestDebtDays: 12,
    });
    expect(result).not.toBeNull();
    expect(result!.totalRemaining.toString()).toBe('75.22');
  });

  it('accepts string/number inputs the way DB rows and computed sums arrive', () => {
    const result = netCustomerDebt({
      grossRemaining: 50,
      creditBalance: '10.5',
      oldestDebtDays: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.totalRemaining.toString()).toBe('39.5');
  });
});
