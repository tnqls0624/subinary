/**
 * Slack module (Phase 6 Build Spec §5.4).
 *
 * - Imports {@link StorageModule} for `ObjectStorageService` (raw-bundle writes
 *   to MinIO).
 * - Registers the `slack-import` queue so the service can enqueue parse jobs;
 *   the BullMQ root connection is provided by the app-level `QueueModule`
 *   (`forRootAsync`).
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs every Slack
 * route, so neither is re-imported here.
 */
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUE_DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '@family/shared';

import { StorageModule } from '../storage/storage.module';
import { SlackController } from './slack.controller';
import { SlackService } from './slack.service';

@Module({
  imports: [
    StorageModule,
    BullModule.registerQueue({
    name: QUEUE_NAMES.SLACK_IMPORT,
    defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS,
  }),
  ],
  controllers: [SlackController],
  providers: [SlackService],
})
export class SlackModule {}
