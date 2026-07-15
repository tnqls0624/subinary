import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadConfig } from '@family/config';

import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ProcessorsModule } from './processors/processors.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    // load: [loadConfig] — 최상위 그룹 키(app/database/redis/queue/storage/ai)가 config 루트가 된다.
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfig] }),
    DatabaseModule,
    QueueModule,
    ProcessorsModule,
    HealthModule,
  ],
})
export class AppModule {}
