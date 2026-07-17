/**
 * Memory module (Phase 8 Build Spec §6.4).
 *
 * Registers the `memory-extract` queue so {@link MemoryService} can enqueue
 * rule-based extraction jobs; the BullMQ root connection is provided by the
 * app-level `QueueModule` (`forRootAsync`).
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs every memory
 * route, so neither is re-imported here.
 */
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUE_DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '@family/shared';

import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

@Module({
  imports: [BullModule.registerQueue({
    name: QUEUE_NAMES.MEMORY_EXTRACT,
    defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS,
  })],
  controllers: [MemoryController],
  providers: [MemoryService],
})
export class MemoryModule {}
