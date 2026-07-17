import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@family/config';
import { QUEUE_DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '@family/shared';

import { QueueService } from './queue.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redis = configService.get<AppConfig['redis']>('redis');
        const queue = configService.get<AppConfig['queue']>('queue');
        if (!redis || !queue) {
          throw new Error('Redis/queue configuration is missing');
        }
        return {
          connection: { host: redis.host, port: redis.port },
          prefix: queue.prefix,
        };
      },
    }),
    BullModule.registerQueue({
    name: QUEUE_NAMES.TEST,
    defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS,
  }),
  ],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
