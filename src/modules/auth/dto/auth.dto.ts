import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Length, MinLength } from 'class-validator';

export class RegisterDTO {
  @ApiProperty({ example: 'Ibrahim Market', description: 'اسم المتجر' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: 'ibrahim_admin', description: 'اسم المستخدم لمدير المتجر' })
  @IsNotEmpty()
  @IsString()
  username!: string;

  @ApiProperty({ example: 'admin@ibrahim-market.com', description: 'البريد الإلكتروني للمدير' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'strongpassword123', description: 'كلمة المرور (6 أحرف على الأقل)' })
  @IsNotEmpty()
  @MinLength(6)
  password!: string;
}

export class LoginDTO {
  @ApiProperty({
    example: 'ibrahim-market',
    description: 'النطاق الفرعي للمتجر — يُستخرج عادةً من الرابط في الواجهة',
  })
  @IsNotEmpty()
  subdomain!: string;

  @ApiProperty({ example: 'ibrahim_admin', description: 'اسم المستخدم' })
  @IsNotEmpty()
  username!: string;

  @ApiProperty({ example: 'strongpassword123', description: 'كلمة المرور' })
  @IsNotEmpty()
  password!: string;
}

export class SuperAdminLoginDTO {
  @ApiProperty({ example: 'super_admin', description: 'اسم مستخدم المشرف العام' })
  @IsNotEmpty()
  @IsString()
  username!: string;

  @ApiProperty({ example: 'superSecretPassword', description: 'كلمة المرور' })
  @IsNotEmpty()
  @IsString()
  password!: string;
}

export class VerifyEmailDTO {
  @ApiProperty({ example: 'admin@ibrahim-market.com', description: 'البريد المُسجَّل' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: '483920',
    description: 'رمز مكوّن من 6 أرقام أُرسل إلى البريد بعد التسجيل',
  })
  @IsNotEmpty()
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  otp!: string;
}

export class ForgotPasswordDTO {
  @ApiProperty({ example: 'admin@ibrahim-market.com', description: 'البريد لإرسال رابط إعادة التعيين' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDTO {
  @ApiProperty({ description: 'الرمز المُستلم في بريد إعادة تعيين كلمة المرور' })
  @IsNotEmpty()
  @IsString()
  token!: string;

  @ApiProperty({ example: 'newStrongPassword123', description: 'كلمة المرور الجديدة (6 أحرف على الأقل)' })
  @IsNotEmpty()
  @MinLength(6)
  newPassword!: string;
}

export type RegisterResponseDTO = {
  message: string;
};

export type UserResponseDTO = {
  token: string;
  userData: Record<string, unknown>;
};
