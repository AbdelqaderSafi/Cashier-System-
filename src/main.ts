import * as dns from 'node:dns';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { env } from './common/config/env';

dns.setDefaultResultOrder('ipv4first');

async function bootstrap() {
  // `bufferLogs: true` queues bootstrap logs until pino is wired below — so
  // the very first log line is already JSON instead of Nest's default text.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  configureApp(app);

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

  await app.listen(env.PORT, '0.0.0.0');
}
bootstrap();
