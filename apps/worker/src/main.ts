import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '@family/config';
import { createLogger } from '@family/shared';

import { AppModule } from './app.module';

const DEFAULT_WORKER_PORT = 3002;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig['app']>('app');
  const port = appConfig?.workerPort ?? DEFAULT_WORKER_PORT;
  const isProduction = appConfig?.nodeEnv === 'production';

  const logger = createLogger('worker', { pretty: !isProduction });

  await app.listen(port, '0.0.0.0');
  logger.info({ service: 'worker', port }, 'worker service is listening');
}

bootstrap().catch((error: unknown) => {
  // 부팅 실패 시 secret/개인정보가 포함될 수 있는 전체 객체 대신 메시지(및 dev 한정 스택)만 출력한다.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[worker] bootstrap failed: ${message}`);
  if (process.env.NODE_ENV !== 'production' && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
