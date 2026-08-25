import { Prisma } from 'generated/prisma/client';
import {
  cashPaidOf,
  creditToApply,
  paidAtSaleOf,
  signedBalance,
} from './credit.util';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('cashPaidOf', () => {
  it('returns the whole paid amount when every payment is cash', () => {
    const result = cashPaidOf(d(100), [
      { amount: d(60), source: 'CASH' },
      { amount: d(40), source: 'CASH' },
    ]);
    expect(result.equals(100)).toBe(true);
  });

  it('subtracts credit-funded payments', () => {
    const result = cashPaidOf(d(100), [
      { amount: d(60), source: 'CASH' },
      { amount: d(40), source: 'CREDIT' },
    ]);
    expect(result.equals(60)).toBe(true);
  });

  it('returns zero when the debt was settled entirely by credit', () => {
    const result = cashPaidOf(d(100), [{ amount: d(100), source: 'CREDIT' }]);
    expect(result.equals(0)).toBe(true);
  });

  it('returns paid unchanged when there are no payment rows', () => {
    expect(cashPaidOf(d(30), []).equals(30)).toBe(true);
  });

  it('accepts string and number amounts without float drift', () => {
    const result = cashPaidOf('0.3', [
      { amount: '0.1', source: 'CREDIT' },
      { amount: 0.2, source: 'CASH' },
    ]);
    expect(result.toString()).toBe('0.2');
  });

  it('never returns a negative number', () => {
    // Defensive: a corrupt ledger where credit payments exceed paid must not
    // produce a negative "cash paid" that then passes a >= guard.
    const result = cashPaidOf(d(10), [{ amount: d(40), source: 'CREDIT' }]);
    expect(result.equals(0)).toBe(true);
  });
});

describe('paidAtSaleOf', () => {
  it('returns invoice.paid untouched when the debt has no payments yet', () => {
    expect(paidAtSaleOf(d(30), []).equals(30)).toBe(true);
  });

  it('subtracts a CASH repayment, which cashPaidOf would have left in', () => {
    // The defect this function exists to fix: a PARTIAL invoice rung up at 30,
    // then 10 repaid in cash, leaves invoices.paid at 40. The at-sale figure
    // is still 30.
    const payments = [{ amount: d(10), source: 'CASH' as const }];
    expect(paidAtSaleOf(d(40), payments).equals(30)).toBe(true);
    // Contrast — the old behaviour, which is what made the principal shrink:
    expect(cashPaidOf(d(40), payments).equals(40)).toBe(true);
  });

  it('subtracts a CREDIT repayment too', () => {
    expect(
      paidAtSaleOf(d(70), [{ amount: d(40), source: 'CREDIT' as const }]).equals(30),
    ).toBe(true);
  });

  it('subtracts cash and credit repayments together', () => {
    const payments = [
      { amount: d(10), source: 'CASH' as const },
      { amount: d(40), source: 'CREDIT' as const },
    ];
    expect(paidAtSaleOf(d(80), payments).equals(30)).toBe(true);
  });

  it('returns zero for a DEBT invoice fully settled by repayments', () => {
    // Rung up at 0 down, 100 repaid over time -> invoices.paid 100.
    const payments = [{ amount: d(100), source: 'CASH' as const }];
    expect(paidAtSaleOf(d(100), payments).equals(0)).toBe(true);
  });

  it('never returns a negative number', () => {
    expect(paidAtSaleOf(d(10), [{ amount: d(40), source: 'CASH' as const }]).equals(0)).toBe(
      true,
    );
  });

  it('is exact on fractional money', () => {
    expect(
      paidAtSaleOf('0.3', [{ amount: '0.1', source: 'CASH' as const }]).toString(),
    ).toBe('0.2');
  });
});

describe('creditToApply', () => {
  it('spends the whole balance when the debt is larger', () => {
    expect(creditToApply(d(50), d(80)).equals(50)).toBe(true);
  });

  it('spends only what the debt needs when the balance is larger', () => {
    expect(creditToApply(d(100), d(60)).equals(60)).toBe(true);
  });

  it('returns zero when there is no credit', () => {
    expect(creditToApply(d(0), d(80)).equals(0)).toBe(true);
  });

  it('returns zero when the debt is already settled', () => {
    expect(creditToApply(d(50), d(0)).equals(0)).toBe(true);
  });

  it('clamps a negative input to zero rather than minting money', () => {
    expect(creditToApply(d(-10), d(80)).equals(0)).toBe(true);
    expect(creditToApply(d(50), d(-10)).equals(0)).toBe(true);
  });

  it('is exact on two-decimal money', () => {
    expect(creditToApply(d('0.1'), d('0.2')).toString()).toBe('0.1');
  });
});

describe('signedBalance', () => {
  it('is negative when the customer owes', () => {
    expect(signedBalance(d(0), d(100)).toString()).toBe('-100');
  });

  it('is positive when the shop owes the customer', () => {
    expect(signedBalance(d(50), d(0)).toString()).toBe('50');
  });

  it('is zero when they are square', () => {
    expect(signedBalance(d(0), d(0)).toString()).toBe('0');
  });

  it('nets an uncleared credit against an open debt', () => {
    // The offline case: credit and debt both recorded, not yet settled.
    expect(signedBalance(d(50), d(80)).toString()).toBe('-30');
  });

  it('is exact on fractional money', () => {
    expect(signedBalance(d('0.3'), d('0.1')).toString()).toBe('0.2');
  });
});
