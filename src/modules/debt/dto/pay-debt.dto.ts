import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PayDebtDto {
  @ApiProperty({
    example: 250.0,
    description:
      'المبلغ المدفوع — يجب أن يكون أكبر من صفر ولا يتجاوز المبلغ المتبقي على هذا الدين. للدفع الزائد استخدم POST /debts/customer/:customerId/pay',
  })
  @IsNotEmpty({ message: 'المبلغ المدفوع مطلوب' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ يجب أن يكون رقماً بحد أقصى خانتين عشريتين' })
  @IsPositive({ message: 'المبلغ يجب أن يكون أكبر من صفر' })
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
}
