import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, IsNumber, Min, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCustomerDto {
  @ApiProperty({ example: 'محمد أحمد', description: 'اسم العميل' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: '0501234567', description: 'رقم الهاتف' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({
    example: 150.0,
    description: 'دين سابق (رصيد افتتاحي) قبل استخدام النظام. يُنشئ سجل دين مباشرةً عند إضافة العميل.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  initialDebt?: number;

  @ApiPropertyOptional({
    example: 'offline-customer-1716640200000',
    description:
      'مفتاح idempotency من العميل (مثلاً الـ localId المُولَّد وقت الحفظ أوف لاين). ' +
      'إذا تم إرسال نفس المفتاح مرتين لنفس المتجر، السيرفر يعيد العميل الأصلي بدون إنشاء عميل مكرر. ' +
      'استخدمه دائماً في المسارات التي تُعيد المحاولة (sync queue / outbox).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientCustomerId?: string;
}
