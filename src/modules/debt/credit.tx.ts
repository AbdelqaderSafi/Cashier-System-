import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import type { CreditReason, PaymentSource } from 'generated/prisma/client';
import { creditToApply } from './credit.util';

// Ceiling for customers.creditBalance and credit_entries.balanceAfter, both
// DECIMAL(10,2) columns — not a business rule. The DTO's @Max on `amount`
// only bounds a single tender; it cannot see the running total, so a customer
// with an existing balance can still push creditBalance past this ceiling
// with two individually-legal payments. grantCredit is the one place every
// balance-increasing caller passes through, so the guard lives here.
export const MAX_CREDIT_BALANCE = 99999999.99;

/**
 * Transaction-scoped credit operations. Every function here assumes the
 * caller already holds SELECT ... FOR UPDATE on the customer row (via
 * lockCustomerForCredit) and is running inside a $transaction.
 *
 * Lock order across the whole codebase is Store → Customer → Debts →
 * Invoices. Taking the customer lock late — after tx.invoice.update, as
 * InvoiceService.update naturally would — deadlocks against
 * DebtService.payForCustomer, and PostgreSQL 40P01 is not mapped by
 * PrismaExceptionFilter so it reaches the till as a 500.
 */

type Tx = Prisma.TransactionClient;

export type LockedCustomer = {
  id: string;
  creditBalance: Prisma.Decimal;
};

/**
 * Lock the customer row. MUST be the first statement of any transaction that
 * touches a customer's debts, invoices, or credit — unconditionally, even
 * when no credit is involved. This single row is what serialises the
 * otherwise-inverted lock orders of the invoice and debt paths.
 *
 * `allowArchived` breaks the tie between two conflicting rules: an archived
 * (isDeleted) customer must never take on new money (a fresh debt, a new
 * cash/credit tender), but a customer can only be archived once their debts
 * are settled and their credit is spent — so reversing money that already
 * belongs to them (undoing a payment/invoice, deleting a historical invoice)
 * must keep working after archiving, exactly as it did before this customer
 * had any credit at all. Reversal call sites pass `true`; every path that
 * hands out new debt or spends/grants credit for a *new* operation keeps the
 * default `false`.
 */
export async function lockCustomerForCredit(
  tx: Tx,
  sid: string,
  customerId: string,
  options: { allowArchived?: boolean } = {},
): Promise<LockedCustomer> {
  const { allowArchived = false } = options;
  const rows = allowArchived
    ? await tx.$queryRaw<LockedCustomer[]>`
        SELECT id, "creditBalance"
        FROM customers
        WHERE id = ${customerId}
          AND "storeId" = ${sid}
        FOR UPDATE
      `
    : await tx.$queryRaw<LockedCustomer[]>`
        SELECT id, "creditBalance"
        FROM customers
        WHERE id = ${customerId}
          AND "storeId" = ${sid}
          AND "isDeleted" = false
        FOR UPDATE
      `;
  if (rows.length === 0) throw new NotFoundException('العميل غير موجود');
  return {
    id: rows[0].id,
    creditBalance: new Prisma.Decimal(rows[0].creditBalance),
  };
}

/** Add to the customer's credit and record the movement. Returns the new balance. */
export async function grantCredit(
  tx: Tx,
  args: {
    sid: string;
    customerId: string;
    currentBalance: Prisma.Decimal;
    amount: Prisma.Decimal;
    reason: Extract<CreditReason, 'OVERPAYMENT' | 'APPLIED_REVERSED'>;
    operationId?: string | null;
    debtPaymentId?: string | null;
    notes?: string | null;
  },
): Promise<Prisma.Decimal> {
  if (args.amount.lte(0)) return args.currentBalance;

  const newBalance = args.currentBalance.plus(args.amount);

  if (newBalance.gt(MAX_CREDIT_BALANCE)) {
    throw new BadRequestException(
      `رصيد العميل بعد هذه العملية يتجاوز الحد الأقصى المسموح به (${MAX_CREDIT_BALANCE})`,
    );
  }

  await tx.customer.update({
    where: { id: args.customerId },
    data: {
      creditBalance: { increment: args.amount },
      // CustomerService.remove refuses to archive a customer who still
      // holds credit, precisely so an archived (isDeleted) row can never
      // owe money the shop is hiding from /customers and /sync/init. A
      // reversal (allowArchived: true on the lock) can still grant credit
      // to a customer who was archived AFTER their balance hit zero — e.g.
      // deleting the CREDIT payment or invoice that settled them. The
      // moment that happens the invariant CustomerService.remove protects
      // is broken again, so un-archive here, unconditionally and in the
      // same statement as the balance write. This is deliberately not left
      // to each caller: every present and future grantCredit call site
      // must inherit it, and for a customer that was never archived this
      // is a no-op (isDeleted already false, deletedAt already null).
      isDeleted: false,
      deletedAt: null,
    },
  });
  await tx.creditEntry.create({
    data: {
      delta: args.amount,
      balanceAfter: newBalance,
      reason: args.reason,
      notes: args.notes ?? null,
      customerId: args.customerId,
      storeId: args.sid,
      operationId: args.operationId ?? null,
      debtPaymentId: args.debtPaymentId ?? null,
    },
  });

  return newBalance;
}

/** Remove from the customer's credit and record the movement. Returns the new balance. */
export async function takeCredit(
  tx: Tx,
  args: {
    sid: string;
    customerId: string;
    currentBalance: Prisma.Decimal;
    amount: Prisma.Decimal;
    reason: Extract<CreditReason, 'APPLIED_TO_DEBT' | 'OVERPAYMENT_REVERSED'>;
    operationId?: string | null;
    debtPaymentId?: string | null;
    notes?: string | null;
  },
): Promise<Prisma.Decimal> {
  if (args.amount.lte(0)) return args.currentBalance;

  const newBalance = args.currentBalance.minus(args.amount);

  await tx.customer.update({
    where: { id: args.customerId },
    data: { creditBalance: { decrement: args.amount } },
  });
  await tx.creditEntry.create({
    data: {
      delta: args.amount.negated(),
      balanceAfter: newBalance,
      reason: args.reason,
      notes: args.notes ?? null,
      customerId: args.customerId,
      storeId: args.sid,
      operationId: args.operationId ?? null,
      debtPaymentId: args.debtPaymentId ?? null,
    },
  });

  return newBalance;
}

/**
 * Settle part or all of a debt from stored credit.
 *
 * Writes a real DebtPayment with source CREDIT and mirrors onto the invoice
 * exactly the way DebtService.pay does. The invoice write is NOT optional: if
 * the debt moves while the invoice stays at paid = 0, the next cash payment
 * makes paid + remaining ≠ total and invoice_balance_consistent rejects it as
 * an unmapped 500 — the debt becomes permanently unpayable.
 *
 * increment/decrement rather than absolute assignment, so PostgreSQL computes
 * both columns in one UPDATE and the CHECK only ever sees the final row. An
 * absolute `paid: applied` is correct only on a debt that was just created
 * with paid = 0, and silently destroys prior payments anywhere else.
 */
export async function spendCreditOnDebt(
  tx: Tx,
  args: {
    sid: string;
    customerId: string;
    currentBalance: Prisma.Decimal;
    debtId: string;
    debtRemaining: Prisma.Decimal;
    invoiceId: string | null;
    operationId?: string | null;
  },
): Promise<{ applied: Prisma.Decimal; newBalance: Prisma.Decimal }> {
  const applied = creditToApply(args.currentBalance, args.debtRemaining);
  if (applied.lte(0)) {
    return { applied: new Prisma.Decimal(0), newBalance: args.currentBalance };
  }

  const payment = await tx.debtPayment.create({
    data: {
      amount: applied,
      source: 'CREDIT',
      debtId: args.debtId,
      operationId: args.operationId ?? null,
      notes: 'مسدَّد من رصيد العميل',
    },
  });

  await tx.debt.update({
    where: { id: args.debtId },
    data: {
      paid: { increment: applied },
      remaining: { decrement: applied },
      // Explicit. Leaving the schema default on a remaining-0 debt poisons the
      // unpaid-debt lists and makes payForCustomer emit zero-amount payments.
      isPaid: args.debtRemaining.minus(applied).isZero(),
    },
  });

  if (args.invoiceId) {
    await tx.invoice.update({
      where: { id: args.invoiceId },
      data: {
        paid: { increment: applied },
        remaining: { decrement: applied },
      },
    });
  }

  const newBalance = await takeCredit(tx, {
    sid: args.sid,
    customerId: args.customerId,
    currentBalance: args.currentBalance,
    amount: applied,
    reason: 'APPLIED_TO_DEBT',
    operationId: args.operationId ?? null,
    debtPaymentId: payment.id,
  });

  return { applied, newBalance };
}

/**
 * Reverse every CREDIT-sourced payment on one invoice's debt, crediting the
 * customer who funded them back. Shared by InvoiceService.update (editing an
 * invoice) and InvoiceService.remove (deleting one) — the two places that
 * must undo whatever spendCreditOnDebt previously applied.
 *
 * The two callers differ in whether the debt/invoice rows survive the
 * operation:
 *   - update() keeps both rows around, so the CREDIT payment must be deleted
 *     and debt.paid/remaining AND invoice.paid/remaining must be walked back
 *     explicitly — pass `debtId` and `invoiceId` to get this. Skipping the
 *     invoice side here is exactly what let a no-op edit mint credit: the
 *     caller's own paid/remaining recompute (which runs before this
 *     transaction even opens) has to see a credit-free invoice.paid, and the
 *     row this writes has to agree with what that recompute produced.
 *   - remove() is about to delete the invoice outright, and Debt/DebtPayment
 *     cascade away with it — so mutating those rows first would be wasted
 *     work. Omit `debtId`/`invoiceId` and only the credit grant happens.
 *
 * Returns the customer's credit balance after every reversal, so the caller
 * can fold it back into its own locked-customer bookkeeping.
 */
export async function reverseCreditOnDebt(
  tx: Tx,
  args: {
    sid: string;
    customerId: string;
    currentBalance: Prisma.Decimal;
    payments: readonly {
      id: string;
      amount: Prisma.Decimal | string;
      source: PaymentSource;
    }[];
    invoiceNumber: number;
    notesLabel: string;
    debtId?: string;
    invoiceId?: string;
  },
): Promise<Prisma.Decimal> {
  let balance = args.currentBalance;
  const creditPayments = args.payments.filter((p) => p.source === 'CREDIT');

  for (const p of creditPayments) {
    const amount = new Prisma.Decimal(p.amount);

    if (args.debtId && args.invoiceId) {
      await tx.debtPayment.delete({ where: { id: p.id } });
      await tx.debt.update({
        where: { id: args.debtId },
        data: {
          paid: { decrement: amount },
          remaining: { increment: amount },
          isPaid: false,
        },
      });
      await tx.invoice.update({
        where: { id: args.invoiceId },
        data: {
          paid: { decrement: amount },
          remaining: { increment: amount },
        },
      });
    }

    balance = await grantCredit(tx, {
      sid: args.sid,
      customerId: args.customerId,
      currentBalance: balance,
      amount,
      reason: 'APPLIED_REVERSED',
      notes: `إرجاع رصيد — ${args.notesLabel} رقم ${args.invoiceNumber}`,
    });
  }

  return balance;
}
