import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: 'محمد أحمد', description: 'اسم العميل' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: '0501234567', description: 'رقم الهاتف' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}
