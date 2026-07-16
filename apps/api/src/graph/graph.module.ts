/**
 * Graph module (Phase 9 Build Spec §6.4).
 *
 * Registers the `graph-extract` queue so {@link GraphService} can enqueue
 * deterministic rule-based graph extraction jobs; the BullMQ root connection is
 * provided by the app-level `QueueModule` (`forRootAsync`).
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs every graph
 * route, so neither is re-imported here.
 */
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUE_NAMES } from '@family/shared';

import { GraphController } from './graph.controller';
import { GraphService } from './graph.service';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_NAMES.GRAPH_EXTRACT })],
  controllers: [GraphController],
  providers: [GraphService],
})
export class GraphModule {}
