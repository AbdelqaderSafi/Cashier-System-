import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDTO, LoginDTO, SuperAdminLoginDTO, VerifyEmailDTO, ForgotPasswordDTO, ResetPasswordDTO } from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new store with an admin account' })
  @ApiResponse({ status: 201, description: 'Store and admin created — pending super-admin approval' })
  @ApiResponse({ status: 409, description: 'Store subdomain already taken' })
  register(@Body() dto: RegisterDTO) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with subdomain + username + password' })
  @ApiResponse({ status: 200, description: 'Login successful, returns JWT token' })
  @ApiResponse({ status: 404, description: 'Store not found' })
  @ApiResponse({ status: 401, description: 'Invalid credentials or account disabled' })
  login(@Body() dto: LoginDTO) {
    return this.authService.login(dto);
  }

  @Post('super-admin/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Super Admin login — username + password only (no subdomain)' })
  @ApiResponse({ status: 200, description: 'Login successful, returns JWT with SUPER_ADMIN role' })
  @ApiResponse({ status: 401, description: 'Invalid credentials or account disabled' })
  superAdminLogin(@Body() dto: SuperAdminLoginDTO) {
    return this.authService.superAdminLogin(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email using the 6-digit OTP sent after registration' })
  @ApiResponse({ status: 200, description: 'Email verified — store is now awaiting super-admin approval' })
  @ApiResponse({ status: 400, description: 'Invalid OTP or email already verified' })
  @ApiResponse({ status: 404, description: 'No account found with this email' })
  verifyEmail(@Body() dto: VerifyEmailDTO) {
    return this.authService.verifyEmail(dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset link via email' })
  @ApiResponse({ status: 200, description: 'Reset link sent if the email exists' })
  forgotPassword(@Body() dto: ForgotPasswordDTO) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using the token from the email' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Token expired' })
  @ApiResponse({ status: 404, description: 'Invalid or expired token' })
  resetPassword(@Body() dto: ResetPasswordDTO) {
    return this.authService.resetPassword(dto);
  }
}
