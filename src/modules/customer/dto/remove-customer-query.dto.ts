import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export class RemoveCustomerQueryDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'إسقاط رصيد العميل نهائياً وتسجيله في السجل ثم أرشفة العميل، رغم وجود رصيد لم يُستخدم (للمدير فقط)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  forfeitCredit?: boolean;
}
