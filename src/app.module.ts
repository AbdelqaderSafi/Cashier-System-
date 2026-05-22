import * as crypto from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { LoggerModule } from 'nestjs-pino';
import { AppCacheModule } from './common/cache/cache.module';
import { DatabaseModule } from './modules/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { StoreModule } from './modules/store/store.module';
import { UserModule } from './modules/user/user.module';
import { ProductModule } from './modules/product/product.module';
import { CustomerModule } from './modules/customer/customer.module';
import { InvoiceModule } from './modules/invoice/invoice.module';
import { DebtModule } from './modules/debt/debt.module';
import { BackupModule } from './modules/backup/backup.module';
import { SyncModule } from './modules/sync/sync.module';
import { ReportsModule } from './modules/reports/reports.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // nestjs-pino: structured JSON logs in production (parsed by Datadog/Loki),
    // pretty-printed in dev for human reading. The HTTP autologger writes one
    // line per request — TimingInterceptor still emits its own perf log on top.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  colorize: true,
                  translateTime: 'SYS:HH:MM:ss.l',
                  ignore: 'pid,hostname,req,res,responseTime',
                },
              },
        // Drop noisy fields and redact common secrets.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.token',
          ],
          censor: '[REDACTED]',
        },
        // Build a stable request id so the timing log and the request log
        // can be correlated downstream.
        genReqId: (req) => req.headers['x-request-id'] ?? crypto.randomUUID(),
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      },
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 200 }],
    }),
    // In-memory LRU cache. Each individual entry sets its own TTL on .set().
    // `isGlobal: true` exposes CACHE_MANAGER everywhere without re-importing.
    CacheModule.register({ isGlobal: true, max: 1000 }),
    AppCacheModule,
    DatabaseModule,
    AuthModule,
    StoreModule,
    UserModule,
    ProductModule,
    CustomerModule,
    InvoiceModule,
    DebtModule,
    BackupModule,
    SyncModule,
    ReportsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
