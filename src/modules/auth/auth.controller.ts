import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDTO, LoginDTO, SuperAdminLoginDTO, VerifyEmailDTO, ForgotPasswordDTO, ResetPasswordDTO } from './dto/auth.dto';

@ApiTags('المصادقة')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @ApiOperation({ summary: 'تسجيل متجر جديد مع حساب مدير' })
  @ApiResponse({ status: 201, description: 'تم إنشاء المتجر والمدير — بانتظار موافقة المشرف العام' })
  @ApiResponse({ status: 409, description: 'نطاق المتجر الفرعي مستخدم مسبقاً' })
  register(@Body() dto: RegisterDTO) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'تسجيل الدخول: النطاق الفرعي + اسم المستخدم + كلمة المرور' })
  @ApiResponse({ status: 200, description: 'تم تسجيل الدخول بنجاح — يُعاد رمز JWT' })
  @ApiResponse({ status: 404, description: 'المتجر غير موجود' })
  @ApiResponse({ status: 401, description: 'بيانات الدخول غير صحيحة أو الحساب معطّل' })
  login(@Body() dto: LoginDTO) {
    return this.authService.login(dto);
  }

  @Post('super-admin/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'دخول المشرف العام — اسم المستخدم وكلمة المرور فقط (بدون نطاق فرعي)' })
  @ApiResponse({ status: 200, description: 'تم تسجيل الدخول — يُعاد JWT بدور SUPER_ADMIN' })
  @ApiResponse({ status: 401, description: 'بيانات الدخول غير صحيحة أو الحساب معطّل' })
  superAdminLogin(@Body() dto: SuperAdminLoginDTO) {
    return this.authService.superAdminLogin(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: 'تأكيد البريد الإلكتروني باستخدام رمز مكوّن من 6 أرقام' })
  @ApiResponse({ status: 200, description: 'تم التحقق من البريد — المتجر بانتظار موافقة المشرف العام' })
  @ApiResponse({ status: 400, description: 'رمز غير صالح أو البريد مُؤكَّد مسبقاً' })
  @ApiResponse({ status: 404, description: 'لا يوجد حساب بهذا البريد' })
  verifyEmail(@Body() dto: VerifyEmailDTO) {
    return this.authService.verifyEmail(dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60 * 60_000 } })
  @ApiOperation({ summary: 'طلب رابط إعادة تعيين كلمة المرور عبر البريد' })
  @ApiResponse({ status: 200, description: 'يُرسل الرابط إن وُجد البريد في النظام' })
  forgotPassword(@Body() dto: ForgotPasswordDTO) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: 'إعادة تعيين كلمة المرور باستخدام الرمز من البريد' })
  @ApiResponse({ status: 200, description: 'تم تغيير كلمة المرور بنجاح' })
  @ApiResponse({ status: 400, description: 'انتهت صلاحية الرمز' })
  @ApiResponse({ status: 404, description: 'رمز غير صالح أو منتهٍ' })
  resetPassword(@Body() dto: ResetPasswordDTO) {
    return this.authService.resetPassword(dto);
  }
}
