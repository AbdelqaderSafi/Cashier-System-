import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, MaxLength } from 'class-validator';

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
}
