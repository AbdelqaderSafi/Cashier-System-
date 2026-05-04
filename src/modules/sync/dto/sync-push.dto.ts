import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from 'generated/prisma/client';

// ─── Invoice Item ─────────────────────────────────────────────────────────────

export class SyncInvoiceItemDto {
  @ApiProperty({ example: 'uuid-v4', description: 'معرّف البند (مولَّد من المتصفح)' })
  @IsUUID()
  id!: string;

  @ApiProperty({ example: 'كيس سكر 1 كغ', description: 'اسم المنتج وقت البيع' })
  @IsString()
  @IsNotEmpty()
  productName!: string;

  @ApiPropertyOptional({ example: '6281234567890', description: 'الباركود' })
  @IsOptional()
  @IsString()
  barcode?: string;

  @ApiProperty({ example: 12.5, description: 'سعر الوحدة' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  price!: number;

  @ApiProperty({ example: 3, description: 'الكمية المباعة' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity!: number;

  @ApiProperty({ example: 37.5, description: 'إجمالي البند (سعر × كمية)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  total!: number;

  @ApiPropertyOptional({ example: 'product-uuid', description: 'معرّف المنتج في قاعدة البيانات (لخصم المخزون)' })
  @IsOptional()
  @IsUUID()
  productId?: string;
}

// ─── Invoice ──────────────────────────────────────────────────────────────────

export class SyncInvoiceDto {
  @ApiProperty({ example: 'uuid-v4', description: 'معرّف الفاتورة (مولَّد من المتصفح — UUID)' })
  @IsUUID()
  id!: string;

  @ApiProperty({
    example: '2026-05-04T10:30:00.000Z',
    description: 'تاريخ البيع الفعلي (وقت إنشاء الفاتورة على الجهاز أوف‌لاين)',
  })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 150.0, description: 'المبلغ الإجمالي للفاتورة' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  total!: number;

  @ApiProperty({ example: 50.0, description: 'المبلغ المدفوع فعلاً' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  paid!: number;

  @ApiProperty({ example: 100.0, description: 'المبلغ المتبقي (دين)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  remaining!: number;

  @ApiProperty({ enum: PaymentMethod, example: 'PARTIAL', description: 'طريقة الدفع' })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({ example: 'customer-uuid', description: 'معرّف العميل (مطلوب عند DEBT أو PARTIAL)' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ example: 'ملاحظة على الفاتورة', description: 'ملاحظات اختيارية' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiProperty({ type: [SyncInvoiceItemDto], description: 'بنود الفاتورة' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncInvoiceItemDto)
  items!: SyncInvoiceItemDto[];
}

// ─── Debt ─────────────────────────────────────────────────────────────────────

export class SyncDebtDto {
  @ApiProperty({ example: 'uuid-v4', description: 'معرّف الدين (مولَّد من المتصفح)' })
  @IsUUID()
  id!: string;

  @ApiProperty({ example: 100.0, description: 'المبلغ الأصلي للدين' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  amount!: number;

  @ApiProperty({ example: 0.0, description: 'المبلغ المسدَّد حتى الآن' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  paid!: number;

  @ApiProperty({ example: 100.0, description: 'المبلغ المتبقي' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  remaining!: number;

  @ApiProperty({ example: false, description: 'هل سُدِّد الدين بالكامل؟' })
  @IsBoolean()
  isPaid!: boolean;

  @ApiProperty({
    example: '2026-05-04T10:30:00.000Z',
    description: 'تاريخ نشوء الدين (الوقت الفعلي أوف‌لاين)',
  })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 'customer-uuid', description: 'معرّف العميل' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ example: 'invoice-uuid', description: 'معرّف الفاتورة المرتبطة بالدين' })
  @IsUUID()
  invoiceId!: string;
}

// ─── Debt Payment ─────────────────────────────────────────────────────────────

export class SyncDebtPaymentDto {
  @ApiProperty({ example: 'uuid-v4', description: 'معرّف الدفعة (مولَّد من المتصفح)' })
  @IsUUID()
  id!: string;

  @ApiProperty({ example: 50.0, description: 'مبلغ الدفعة' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  amount!: number;

  @ApiProperty({
    example: '2026-05-04T14:00:00.000Z',
    description: 'تاريخ الدفعة الفعلي (الوقت الفعلي أوف‌لاين)',
  })
  @IsDateString()
  date!: string;

  @ApiPropertyOptional({ example: 'دفعة جزئية', description: 'ملاحظات على الدفعة' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiProperty({ example: 'debt-uuid', description: 'معرّف الدين المراد الدفع عليه' })
  @IsUUID()
  debtId!: string;
}

// ─── Root Push DTO ────────────────────────────────────────────────────────────

export class SyncPushDto {
  @ApiProperty({
    type: [SyncInvoiceDto],
    description: 'الفواتير المُنشأة أوف‌لاين (مع بنودها)',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncInvoiceDto)
  invoices!: SyncInvoiceDto[];

  @ApiProperty({
    type: [SyncDebtDto],
    description: 'سجلات الديون المُنشأة أوف‌لاين',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncDebtDto)
  debts!: SyncDebtDto[];

  @ApiProperty({
    type: [SyncDebtPaymentDto],
    description: 'دفعات الديون المُسجَّلة أوف‌لاين',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncDebtPaymentDto)
  debtPayments!: SyncDebtPaymentDto[];
}
