import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsString,
  MaxLength,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

// Ceiling matches the DECIMAL(10,2) column on every money sink this route
// writes to (debt_payment_operations.amount, customers.creditBalance,
// credit_entries.delta). Anything above it would overflow Postgres as a
// 22003 the PrismaExceptionFilter doesn't map, surfacing an unmapped 500
// instead of a clear 400.
const MAX_PAYMENT_AMOUNT = 99999999.99;

/**
 * Separate from PayDebtDto on purpose. The two pay routes share a controller
 * but not their semantics: only the customer-level route accepts an
 * overpayment and honours clientOperationId. Declaring the key on the shared
 * DTO would advertise an idempotency guarantee that POST /debts/:id/pay does
 * not implement.
 */
export class PayCustomerDebtDto {
  @ApiProperty({
    example: 150.0,
    description:
      'المبلغ المدفوع — يجب أن يكون أكبر من صفر ولا يتجاوز 99999999.99. أي مبلغ يتجاوز إجمالي الديون يُحفَظ كرصيد للعميل',
  })
  @IsNotEmpty({ message: 'المبلغ المدفوع مطلوب' })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'المبلغ يجب أن يكون رقماً بحد أقصى خانتين عشريتين' },
  )
  @IsPositive({ message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(MAX_PAYMENT_AMOUNT, {
    message: 'المبلغ يتجاوز الحد الأقصى المسموح به (99999999.99)',
  })
  @Type(() => Number)
  amount!: number;

  @ApiPropertyOptional({
    example: 'دفعة جزئية للدين',
    description: 'ملاحظات على الدفعة (اختياري)',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    example: 'outbox-3f9c1e2a',
    description:
      'مُعرّف العملية من الجهاز — لمنع تكرار الدفعة عند إعادة الإرسال. إعادة نفس المُعرّف تُرجِع نتيجة العملية الأصلية بدون تحريك أي مبلغ',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientOperationId?: string;
}
