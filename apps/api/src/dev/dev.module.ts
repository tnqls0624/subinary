import { Module } from '@nestjs/common';

import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { DevController } from './dev.controller';

/**
 * Development-only module. Conditionally imported by AppModule
 * when NODE_ENV !== 'production' — never mounted in production.
 */
@Module({
  imports: [QueueModule, StorageModule],
  controllers: [DevController],
})
export class DevModule {}
