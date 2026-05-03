import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { DatabaseService } from '../database/database.service';
import { StoreService } from '../store/store.service';
import { MailService } from '../mail/mail.service';
import {
  RegisterDTO,
  LoginDTO,
  SuperAdminLoginDTO,
  VerifyEmailDTO,
  ForgotPasswordDTO,
  ResetPasswordDTO,
  RegisterResponseDTO,
  UserResponseDTO,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly storeService: StoreService,
    private readonly mailService: MailService,
  ) {}

  async register(dto: RegisterDTO): Promise<RegisterResponseDTO> {
    const subdomain = await this.storeService.generateUniqueSubdomain(dto.name);

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await this.db.$transaction(async (tx) => {
      const t = tx as unknown as typeof this.db;

      const store = await t.store.create({
        data: { name: dto.name, subdomain },
      });

      await t.user.create({
        data: {
          username: dto.username,
          email: dto.email,
          password: hashedPassword,
          role: 'ADMIN',
          storeId: store.id,
          emailVerificationCode: otp,
        },
      });
    });

    await this.mailService.sendEmailVerificationOtp(dto.email, dto.username, otp);

    return {
      message: 'Registration successful. A 6-digit verification code has been sent to your email. Please verify your email to proceed.',
    };
  }

  async verifyEmail(dto: VerifyEmailDTO): Promise<{ message: string }> {
    const user = await this.db.user.findUnique({ where: { email: dto.email } });

    if (!user) throw new NotFoundException('No account found with this email');

    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    if (user.emailVerificationCode !== dto.otp) {
      throw new BadRequestException('Invalid OTP code. Please check your email and try again.');
    }

    await this.db.user.update({
      where: { id: user.id },
      data: { isEmailVerified: true, emailVerificationCode: null },
    });

    return {
      message: 'Email verified successfully. Your store registration is now under review by our team.',
    };
  }

  async login(dto: LoginDTO): Promise<UserResponseDTO> {
    const store = await this.storeService.findBySubdomain(dto.subdomain);

    if (store.status !== 'APPROVED') {
      throw new UnauthorizedException(
        'Your store has not been approved yet. Please wait for admin approval.',
      );
    }

    const user = await this.db.user.findUnique({
      where: {
        username_storeId: { username: dto.username, storeId: store.id },
      },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) throw new UnauthorizedException('Invalid credentials');

    if (!user.isActive) throw new UnauthorizedException('Account is disabled');

    const token = this.jwt.sign({
      sub: user.id,
      storeId: store.id,
      role: user.role,
    });

    const { password: _, store: __, ...userData } = user as any;
    return { token, userData };
  }

  async superAdminLogin(dto: SuperAdminLoginDTO): Promise<UserResponseDTO> {
    const user = await this.db.user.findFirst({
      where: { username: dto.username, role: 'SUPER_ADMIN' },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) throw new UnauthorizedException('Invalid credentials');

    if (!user.isActive) throw new UnauthorizedException('Account is disabled');

    const token = this.jwt.sign({
      sub: user.id,
      storeId: null,
      role: user.role,
    });

    const { password: _, store: __, ...userData } = user as any;
    return { token, userData };
  }

  async forgotPassword(dto: ForgotPasswordDTO): Promise<{ message: string }> {
    const user = await this.db.user.findUnique({ where: { email: dto.email } });

    // Always return success — never reveal whether the email exists
    if (!user) {
      return { message: 'If this email exists, a reset link has been sent.' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.db.user.update({
      where: { id: user.id },
      data: { resetToken: token, resetTokenExpiry: expiry },
    });

    const resetLink = `https://safi-pos.com/reset-password?token=${token}`;
    await this.mailService.sendPasswordResetEmail(user.email, user.username, resetLink);

    return { message: 'If this email exists, a reset link has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDTO): Promise<{ message: string }> {
    const user = await this.db.user.findUnique({
      where: { resetToken: dto.token },
    });

    if (!user || !user.resetTokenExpiry) {
      throw new NotFoundException('Invalid or expired reset token');
    }

    if (user.resetTokenExpiry < new Date()) {
      throw new BadRequestException('Reset token has expired. Please request a new one.');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);

    await this.db.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    return { message: 'Password has been reset successfully. You can now log in.' };
  }
}
