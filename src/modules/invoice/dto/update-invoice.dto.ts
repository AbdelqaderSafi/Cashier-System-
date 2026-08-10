import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsNumber,
  IsPositive,
  IsInt,
  IsEnum,
  IsUUID,
  IsArray,
  ValidateNested,
  Min,
  MaxLength,
  IsString,
  ValidateIf,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod, SaleUnit } from 'generated/prisma/client';

export class UpdateInvoiceItemDto {
  @ApiPropertyOptional({ example: 'product-uuid', description: 'معرّف المنتج' })
  @IsNotEmpty()
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional({ example: 3, description: 'الكمية المطلوبة', minimum: 1 })
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity!: number;

  @ApiPropertyOptional({
    enum: SaleUnit,
    example: 'UNIT',
    default: 'UNIT',
    description:
      'وحدة البيع — UNIT: قطعة (الافتراضي عند عدم الإرسال) | CARTON: كرتونة كاملة',
  })
  @IsOptional()
  @IsEnum(SaleUnit)
  saleUnit?: SaleUnit;
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional({
    enum: PaymentMethod,
    example: 'CASH',
    description: 'طريقة الدفع الجديدة',
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({
    example: 100.0,
    description: 'المبلغ المدفوع — مطلوب فقط عند تحديد PARTIAL كطريقة دفع',
  })
  @ValidateIf((o) => o.paymentMethod === 'PARTIAL')
  @IsNotEmpty({ message: 'المبلغ المدفوع مطلوب عند الدفع الجزئي' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  paid?: number;

  @ApiPropertyOptional({
    example: 'customer-uuid',
    description: 'معرّف العميل — مطلوب عند تغيير طريقة الدفع إلى DEBT أو PARTIAL',
  })
  @ValidateIf((o) => o.paymentMethod === 'DEBT' || o.paymentMethod === 'PARTIAL')
  @IsNotEmpty({ message: 'معرّف العميل مطلوب عند الدفع بالآجل أو الجزئي' })
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ example: 'ملاحظة جديدة', description: 'ملاحظات اختيارية' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    type: () => [UpdateInvoiceItemDto],
    description:
      'قائمة البنود الجديدة — إذا أُرسلت تُستبدل جميع البنود القديمة. إذا لم تُرسل تبقى البنود كما هي.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateInvoiceItemDto)
  items?: UpdateInvoiceItemDto[];
}
