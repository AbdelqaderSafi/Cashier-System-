import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsInt,
  IsEnum,
  IsUUID,
  IsArray,
  ValidateNested,
  Min,
  MaxLength,
  IsString,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from 'generated/prisma/client';

export class CreateInvoiceItemDto {
  @ApiProperty({ example: 'product-uuid', description: 'معرّف المنتج' })
  @IsNotEmpty()
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: 3, description: 'الكمية المطلوبة', minimum: 1 })
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity!: number;
}

export class CreateInvoiceDto {
  @ApiProperty({
    enum: PaymentMethod,
    example: 'CASH',
    description:
      'طريقة الدفع — CASH: نقدي بالكامل | ONLINE: إلكتروني بالكامل | DEBT: آجل بالكامل (يتطلب عميل) | PARTIAL: دفع جزئي (يتطلب عميل + المبلغ المدفوع)',
  })
  @IsNotEmpty()
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({
    example: 150.0,
    description: 'المبلغ المدفوع — يظهر فقط عند الدفع الجزئي PARTIAL',
  })
  @ValidateIf((o) => o.paymentMethod === 'PARTIAL')
  @IsNotEmpty({ message: 'المبلغ المدفوع مطلوب عند الدفع الجزئي' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  paid?: number;

  @ApiPropertyOptional({
    example: 'customer-uuid',
    description: 'معرّف العميل — مطلوب فقط عند DEBT أو PARTIAL. في CASH و ONLINE يُتجاهل (بيع مباشر)',
  })
  @ValidateIf((o) => o.paymentMethod === 'DEBT' || o.paymentMethod === 'PARTIAL')
  @IsNotEmpty({ message: 'معرّف العميل مطلوب عند الدفع بالآجل أو الجزئي' })
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ example: 'فاتورة طلبية صباحية', description: 'ملاحظات اختيارية' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    example: 'offline-invoice-1716640200000',
    description:
      'مفتاح idempotency من العميل (مثلاً الـ localId المُولَّد وقت الحفظ أوف لاين). ' +
      'إذا تم إرسال نفس المفتاح مرتين لنفس المتجر، السيرفر يعيد الفاتورة الأصلية بدون إنشاء فاتورة مكررة. ' +
      'استخدمه دائماً في المسارات التي تُعيد المحاولة (sync queue / outbox).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientInvoiceId?: string;

  @ApiProperty({
    type: [CreateInvoiceItemDto],
    description: 'بنود الفاتورة (منتج واحد على الأقل)',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceItemDto)
  items!: CreateInvoiceItemDto[];
}
