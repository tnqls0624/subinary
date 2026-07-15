import {
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import type { AppConfig } from '@family/config';

import { StorageModule } from '../storage/storage.module';
import { REDIS_HEALTH_CLIENT } from './health.constants';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [StorageModule],
  controllers: [HealthController],
  providers: [
    {
      provide: REDIS_HEALTH_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const redis = configService.get<AppConfig['redis']>('redis');
        if (!redis) {
          throw new Error('Redis configuration is missing');
        }
        return new Redis({
          host: redis.host,
          port: redis.port,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 2_000,
          commandTimeout: 3_000,
        });
      },
    },
    HealthService,
  ],
})
export class HealthModule implements OnModuleDestroy {
  private readonly logger = new Logger(HealthModule.name);

  constructor(@Inject(REDIS_HEALTH_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Redis quit failed, forcing disconnect: ${message}`);
      this.redis.disconnect();
    }
  }
}
