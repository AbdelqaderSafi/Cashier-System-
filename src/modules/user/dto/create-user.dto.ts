import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

/** أدوار الموظفين التي يمكن للمدير تعيينها (لا يشمل SUPER_ADMIN). */
export enum StoreStaffRole {
  ADMIN = 'ADMIN',
  CASHIER = 'CASHIER',
}

export class CreateUserDto {
  @ApiProperty({ example: 'cashier_ahmad', description: 'اسم المستخدم' })
  @IsNotEmpty()
  @IsString()
  username!: string;

  @ApiProperty({ example: 'cashier@store.com', description: 'البريد الإلكتروني' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123', description: 'كلمة المرور (6 أحرف على الأقل)' })
  @IsNotEmpty()
  @MinLength(6)
  password!: string;

  @ApiPropertyOptional({
    enum: StoreStaffRole,
    default: StoreStaffRole.CASHIER,
    description: 'الدور: ADMIN أو CASHIER — الافتراضي CASHIER عند عدم الإرسال',
  })
  @IsOptional()
  @IsEnum(StoreStaffRole)
  role?: StoreStaffRole;
}
