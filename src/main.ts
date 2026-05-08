import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { Request, Response } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  const config = new DocumentBuilder()
    .setTitle('واجهة نظام الكاشير')
    .setDescription('واجهة برمجية لنظام نقاط البيع السحابي متعدد المتاجر.')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'رمز الوصول JWT (الصق القيمة فقط، بدون كلمة Bearer)',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'توثيق واجهة نظام الكاشير',
  });

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
