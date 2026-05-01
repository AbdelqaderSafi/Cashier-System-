import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { StoreModule } from '../store/store.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    StoreModule,
    MailModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? 'dev_secret',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
