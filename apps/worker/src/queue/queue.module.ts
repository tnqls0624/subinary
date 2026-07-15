import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';

/**
 * BullMQ 루트 설정 — connection(host/port) + prefix.
 * ConfigService에서 값을 읽어야 하므로 forRootAsync를 사용한다(반환 shape는 forRoot와 동일).
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redis = configService.get<AppConfig['redis']>('redis');
        const queue = configService.get<AppConfig['queue']>('queue');
        if (!redis || !queue) {
          throw new Error('Redis/Queue configuration is missing');
        }
        return {
          connection: { host: redis.host, port: redis.port },
          prefix: queue.prefix,
        };
      },
    }),
  ],
})
export class QueueModule {}
