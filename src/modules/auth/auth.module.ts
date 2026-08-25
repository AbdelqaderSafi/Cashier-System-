import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { StoreModule } from '../store/store.module';
import { MailModule } from '../mail/mail.module';
import { env } from '../../common/config/env';

@Module({
  imports: [
    StoreModule,
    MailModule,
    JwtModule.register({
      global: true,
      secret: env.JWT_SECRET,
      // Raised from 7d. There is no refresh endpoint anywhere in this API, so
      // an expired token has exactly one recovery: log out and log in again.
      // At 7d the shop hit that every week — and because the till is an
      // offline-first PWA, a device that stayed offline came back with a dead
      // token and failed its whole queued batch at once.
      //
      // This is a mitigation, not a cure: it lengthens the window rather than
      // removing it, and a stolen token now stays usable for 30 days. The real
      // fix is a refresh flow (or re-issuing the token on each response), both
      // of which need frontend work.
      signOptions: { expiresIn: '30d' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
