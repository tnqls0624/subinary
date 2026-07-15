import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { loadConfig } from '@family/config';

import { AiModule } from './ai/ai.module';
import { DatabaseModule } from './database/database.module';
import { DevModule } from './dev/dev.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';

/**
 * DevModule exposes development-only endpoints (echo, test-job, storage-test)
 * and must never be mounted in production.
 */
const devOnlyModules = process.env.NODE_ENV !== 'production' ? [DevModule] : [];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfig] }),
    DatabaseModule,
    StorageModule,
    QueueModule,
    AiModule,
    HealthModule,
    ...devOnlyModules,
  ],
})
export class AppModule {}
