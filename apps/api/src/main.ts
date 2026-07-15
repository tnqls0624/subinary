import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import type { AppConfig } from '@family/config';
import { createLogger } from '@family/shared';

import { AppModule } from './app.module';

const DEFAULT_API_PORT = 3001;

async function bootstrap(): Promise<void> {
  const logger = createLogger('api', {
    pretty: process.env.NODE_ENV !== 'production',
  });

  // bodyLimit은 config 로딩 이전이므로 상수를 사용한다(MOBILE_MAX_BODY_BYTES 기본값과 동일).
  // rawBody:true 는 장치 HMAC 서명 대상(원본 바이트) 접근을 위해 필수.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 16384 }),
    { rawBody: true },
  );

  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();

  // HttpOnly refresh-token 쿠키 지원(Fastify 어댑터). listen 이전에 등록.
  await app.register(fastifyCookie);

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig['app']>('app');
  const port = appConfig?.apiPort ?? DEFAULT_API_PORT;

  await app.listen(port, '0.0.0.0');
  logger.info({ port, prefix: 'v1' }, 'API server listening');
}

bootstrap().catch((error: unknown) => {
  // Secrets/PII must never be logged; error message only.
  const message = error instanceof Error ? error.message : 'unknown error';
  // eslint-disable-next-line no-console
  console.error(`Fatal error during API bootstrap: ${message}`);
  process.exit(1);
});
