import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Length, MinLength } from 'class-validator';

export class RegisterDTO {
  @ApiProperty({ example: 'Ibrahim Market' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: 'ibrahim_admin' })
  @IsNotEmpty()
  @IsString()
  username!: string;

  @ApiProperty({ example: 'admin@ibrahim-market.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'strongpassword123' })
  @IsNotEmpty()
  @MinLength(6)
  password!: string;
}

export class LoginDTO {
  @ApiProperty({
    example: 'ibrahim-market',
    description: 'Sent automatically by the frontend from the URL — not entered by the user',
  })
  @IsNotEmpty()
  subdomain!: string;

  @ApiProperty({ example: 'ibrahim_admin' })
  @IsNotEmpty()
  username!: string;

  @ApiProperty({ example: 'strongpassword123' })
  @IsNotEmpty()
  password!: string;
}

export class SuperAdminLoginDTO {
  @ApiProperty({ example: 'super_admin' })
  @IsNotEmpty()
  @IsString()
  username!: string;

  @ApiProperty({ example: 'superSecretPassword' })
  @IsNotEmpty()
  @IsString()
  password!: string;
}

export class VerifyEmailDTO {
  @ApiProperty({ example: 'admin@ibrahim-market.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '483920', description: '6-digit OTP sent to the registered email' })
  @IsNotEmpty()
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  otp!: string;
}

export class ForgotPasswordDTO {
  @ApiProperty({ example: 'admin@ibrahim-market.com' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDTO {
  @ApiProperty({ description: 'Token received in the password reset email' })
  @IsNotEmpty()
  @IsString()
  token!: string;

  @ApiProperty({ example: 'newStrongPassword123' })
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
