import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
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

  // Slack export 번들 업로드(Phase 6)용 multipart 파서. 파일 크기 50MB, 1개 제한.
  // multipart는 별도 content-type 파서로 처리되어 JSON bodyLimit(16KB)과 무관하다.
  await app.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  });

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig['app']>('app');
  const port = appConfig?.apiPort ?? DEFAULT_API_PORT;

  // web(3000)→api(3001)는 cross-origin. refresh 쿠키를 주고받기 위해
  // credentials 허용 + 명시적 origin(와일드카드 금지). listen 이전에 등록.
  const webConfig = configService.get<AppConfig['web']>('web');
  app.enableCors({
    origin: webConfig?.corsOrigin ?? 'http://localhost:3000',
    credentials: true,
  });

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
