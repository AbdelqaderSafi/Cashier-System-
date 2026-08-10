import { BadRequestException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';

/**
 * Applies an invoice-level discount and returns the pair that gets stored.
 *
 * The returned `total` is the NET amount, and that is what the invoice row
 * holds — invoice_balance_consistent enforces `paid + remaining = total`, so
 * storing the gross while paying the net would make the database reject the
 * write. The gross stays derivable as `total + discount`.
 *
 * A discount is rejected unless it is strictly less than the gross: an
 * invoice that nets to zero violates `CHECK (total > 0)` and would reach the
 * cashier as an unmapped 500 rather than a readable Arabic message.
 */
export function applyInvoiceDiscount(
  grossTotal: Prisma.Decimal,
  discount?: number | Prisma.Decimal | null,
): { discount: Prisma.Decimal; total: Prisma.Decimal } {
  const value = new Prisma.Decimal(discount ?? 0);

  if (value.lt(0)) {
    throw new BadRequestException('الخصم لا يمكن أن يكون بالسالب');
  }

  if (value.gt(0) && value.gte(grossTotal)) {
    throw new BadRequestException(
      `الخصم (${value.toString()}) يجب أن يكون أقل من إجمالي الفاتورة (${grossTotal.toString()})`,
    );
  }

  return { discount: value, total: grossTotal.minus(value) };
}
