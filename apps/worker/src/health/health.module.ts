import { Inject, Module } from '@nestjs/common';
import type { OnModuleDestroy, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import { createLogger } from '@family/shared';
import { Redis } from 'ioredis';

import { HealthController } from './health.controller';
import { REDIS_CLIENT } from './health.constants';
import { HealthService } from './health.service';

const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const redis = configService.get<AppConfig['redis']>('redis');
    if (!redis) {
      throw new Error('Redis configuration is missing');
    }

    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    const logger = createLogger('worker:health-redis', { pretty: nodeEnv !== 'production' });

    // 헬스체크 전용 클라이언트: 게으른 연결 + 빠른 실패(maxRetriesPerRequest 1).
    const client = new Redis({
      host: redis.host,
      port: redis.port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    client.on('error', (error: Error) => {
      // 연결 오류는 readiness 응답(down)으로 드러나므로 경고만 남긴다. 상세 payload 로그 금지.
      logger.warn({ reason: error.message }, 'health redis client error');
    });

    return client;
  },
};

@Module({
  controllers: [HealthController],
  providers: [redisClientProvider, HealthService],
})
export class HealthModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // quit이 실패하면(예: 연결 전 종료) 강제로 연결을 끊는다.
      this.redis.disconnect();
    }
  }
}
