import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '@family/config';
import { createLogger } from '@family/shared';

import { AppModule } from './app.module';

const DEFAULT_WORKER_PORT = 3002;

async function bootstrap(): Promise<void> {
  // forceCloseConnections:true 는 종료 시 keep-alive 연결을 강제 종료해 리슨
  // 소켓(포트)을 즉시 반납한다(nest --watch 재시작 시 EADDRINUSE 방지).
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ forceCloseConnections: true }),
  );

  app.setGlobalPrefix('v1');

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig['app']>('app');
  const port = appConfig?.workerPort ?? DEFAULT_WORKER_PORT;
  const isProduction = appConfig?.nodeEnv === 'production';

  const logger = createLogger('worker', { pretty: !isProduction });

  // Graceful shutdown: nest --watch(SWC)가 파일 변경 시 이전 프로세스 종료를
  // 기다리지 않고 새 프로세스를 spawn하므로, SIGTERM/SIGINT에서 즉시 close→exit
  // 하여 포트를 반납하고 잔여 핸들(BullMQ/Redis)에 매이지 않게 확실히 종료한다.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ service: 'worker', signal }, 'worker shutting down');
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

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
