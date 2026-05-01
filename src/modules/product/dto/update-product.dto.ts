import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsPositive,
  IsOptional,
  IsInt,
  IsBoolean,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Coca-Cola 500ml', description: 'اسم المنتج' })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    example: '6001234567890',
    description: 'الباركود — يجب أن يكون فريداً داخل المتجر',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @ApiPropertyOptional({
    example: 3.0,
    description: 'سعر الوحدة للبيع (حتى منزلتين عشريتين)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  price?: number;

  @ApiPropertyOptional({ example: 50, description: 'كمية المخزون المطلوب تعيينها' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  stock?: number;

  @ApiPropertyOptional({ example: 10, description: 'حد تنبيه المخزون المنخفض' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  minStock?: number;

  @ApiPropertyOptional({ example: true, description: 'تفعيل أو تعطيل المنتج' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
