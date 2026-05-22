import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { TimingInterceptor } from './common/interceptors/timing.interceptor';
import { PrismaExceptionFilter } from './common/filters/prisma.filter';
import { env } from './common/config/env';

export function configureApp(app: INestApplication): void {
  app.use(helmet());
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));

  if (env.ALLOWED_ORIGINS.length > 0) {
    app.enableCors({
      origin: env.ALLOWED_ORIGINS,
      credentials: true,
    });
  }

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalInterceptors(new TimingInterceptor());
  app.useGlobalFilters(new PrismaExceptionFilter());
  app.enableShutdownHooks();
}
