import { Prisma } from 'generated/prisma/client';
import type { PaymentSource } from 'generated/prisma/client';

/**
 * Pure Decimal arithmetic for customer credit. No database access lives here
 * so the rules can be unit-tested without a connection; everything that needs
 * a transaction is in credit.tx.ts.
 */

type DecimalLike = Prisma.Decimal | string | number;

const dec = (v: DecimalLike): Prisma.Decimal => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);

/** A debt payment as far as credit arithmetic is concerned. */
export type PaymentLike = {
  amount: DecimalLike;
  source: PaymentSource;
};

/**
 * The portion of a debt's `paid` that came from real cash, and therefore
 * cannot be handed back by reversing credit.
 *
 * Every guard that compared against `debt.paid` must compare against this
 * instead. Once credit can settle a debt, `debt.paid` is non-zero from the
 * moment the debt is created, which would make a credit-covered invoice
 * permanently uneditable.
 */
export function cashPaidOf(
  paid: DecimalLike,
  payments: readonly PaymentLike[],
): Prisma.Decimal {
  const creditPortion = payments
    .filter((p) => p.source === 'CREDIT')
    .reduce((acc, p) => acc.plus(dec(p.amount)), ZERO);

  return Prisma.Decimal.max(dec(paid).minus(creditPortion), ZERO);
}

/**
 * What the customer actually handed over AT THE TILL when the invoice was
 * rung up, recovered from a live `invoices.paid`.
 *
 * `invoices.paid` is not that number. Every later repayment against the
 * linked debt is mirrored onto it — DebtService.pay, payForCustomer's cash
 * loop and spendCreditOnDebt all do `invoice.paid { increment }` — so it
 * grows toward `total` as the debt is settled. Subtracting ALL of those
 * payments (cash and credit alike) leaves the original at-sale amount.
 *
 * This is deliberately NOT cashPaidOf. That one answers a different question
 * about a different column: which part of `debts.paid` is unrefundable cash,
 * so it strips only CREDIT rows. Using it here left every CASH repayment
 * inside the figure, and since `update()` derives the debt principal as
 * `total − paidAtSale`, each repayment was subtracted from the principal a
 * second time — a notes-only PATCH silently shrank the debt by exactly the
 * amount the customer had already paid.
 */
export function paidAtSaleOf(
  invoicePaid: DecimalLike,
  debtPayments: readonly PaymentLike[],
): Prisma.Decimal {
  const repayments = debtPayments.reduce(
    (acc, p) => acc.plus(dec(p.amount)),
    ZERO,
  );

  return Prisma.Decimal.max(dec(invoicePaid).minus(repayments), ZERO);
}

/**
 * How much stored credit to spend on a debt: the smaller of what the customer
 * holds and what the debt still needs. Both inputs are clamped at zero so a
 * corrupt row can never mint credit or drive a balance negative.
 */
export function creditToApply(
  creditBalance: DecimalLike,
  debtRemaining: DecimalLike,
): Prisma.Decimal {
  const available = Prisma.Decimal.max(dec(creditBalance), ZERO);
  const needed = Prisma.Decimal.max(dec(debtRemaining), ZERO);
  return Prisma.Decimal.min(available, needed);
}

/**
 * The signed number the cashier sees: negative when the customer owes,
 * positive when the shop is holding their money.
 *
 * Correct even while a credit and a debt sit side by side unsettled — the
 * offline case, where a sale synced without consuming credit.
 */
export function signedBalance(
  creditBalance: DecimalLike,
  totalRemaining: DecimalLike,
): Prisma.Decimal {
  return dec(creditBalance).minus(dec(totalRemaining));
}
