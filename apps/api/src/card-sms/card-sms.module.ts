/**
 * Card-SMS module (Phase 3 Build Spec §5.2).
 *
 * - Imports {@link DevicesModule} to consume its exported `DeviceHmacGuard`,
 *   which authenticates the `POST /v1/mobile-events/card-sms` ingest route.
 * - Imports {@link StorageModule} for `ObjectStorageService` (raw-object writes).
 * - Registers the `card-sms-parse` queue so the ingest service can enqueue
 *   parse jobs; the BullMQ root connection is provided by the app-level
 *   `QueueModule` (`forRootAsync`).
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs the
 * `card-sms-events` query routes, so neither is re-imported here.
 */
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUE_DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '@family/shared';

import { DevicesModule } from '../devices/devices.module';
import { StorageModule } from '../storage/storage.module';
import { CardSmsEventsController } from './card-sms-events.controller';
import { CardSmsIngestService } from './card-sms-ingest.service';
import { CardSmsQueryService } from './card-sms-query.service';
import { CardSmsController } from './card-sms.controller';

@Module({
  imports: [
    DevicesModule,
    StorageModule,
    BullModule.registerQueue({
    name: QUEUE_NAMES.CARD_SMS_PARSE,
    defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS,
  }),
  ],
  controllers: [CardSmsController, CardSmsEventsController],
  providers: [CardSmsIngestService, CardSmsQueryService],
})
export class CardSmsModule {}
