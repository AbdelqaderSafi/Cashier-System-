import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsPositive,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductDto {
  @ApiProperty({ example: 'Coca-Cola 500ml', description: 'اسم المنتج' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    example: '6001234567890',
    description: 'الباركود — يجب أن يكون فريداً داخل المتجر',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @ApiProperty({
    example: 2.5,
    description: 'سعر الوحدة للبيع (حتى منزلتين عشريتين)',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  price!: number;

  @ApiPropertyOptional({
    example: 1.8,
    default: 0,
    description: 'سعر الجملة / تكلفة الشراء (حتى منزلتين عشريتين)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  wholesalePrice?: number;

  @ApiPropertyOptional({ example: 100, default: 0, description: 'كمية المخزون الابتدائية' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  stock?: number;

  @ApiPropertyOptional({
    example: 5,
    default: 5,
    description: 'حد تنبيه المخزون المنخفض — يُنبَّه عندما يصبح المخزون أقل من هذا الرقم',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  minStock?: number;
}
