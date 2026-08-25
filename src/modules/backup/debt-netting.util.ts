import { Prisma } from 'generated/prisma/client';

type DecimalLike = Prisma.Decimal | string | number;

const dec = (v: DecimalLike): Prisma.Decimal => new Prisma.Decimal(v);

/**
 * Pure Decimal arithmetic for the nightly debt-backup report. No database
 * access lives here so the netting rule can be unit-tested without a
 * connection — see backup.service.ts's fetchCustomerDebts for the caller.
 */

export type NettedDebtRow = {
  totalRemaining: Prisma.Decimal;
  oldestDebtDays: number;
};

/**
 * Nets a customer's own credit against their own gross unpaid-debt total. A
 * customer whose credit covers what they owe is not a debtor and must not
 * appear in the "الأولوية القصوى" list or in debtorCount — signalled by
 * returning null so the caller can drop the row entirely.
 *
 * Deliberate simplification: for a partially covered customer the amount is
 * netted but the age is not. Notional settlement does not pick a specific
 * debt, and attributing credit to the oldest one would shift the aging
 * bucket with no real ledger movement. `oldestDebtDays` is an attention
 * flag, not an accounting figure, so it passes through unchanged.
 */
export function netCustomerDebt(args: {
  grossRemaining: DecimalLike;
  creditBalance: DecimalLike;
  oldestDebtDays: number;
}): NettedDebtRow | null {
  const net = dec(args.grossRemaining).minus(dec(args.creditBalance));
  if (net.lte(0)) return null;

  return { totalRemaining: net, oldestDebtDays: args.oldestDebtDays };
}
