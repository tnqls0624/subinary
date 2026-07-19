/**
 * Card-SMS module (Phase 3 Build Spec §5.2).
 *
 * - Imports {@link DevicesModule} to consume its exported `DeviceHmacGuard`,
 *   which authenticates the `POST /v1/mobile-events/card-sms` ingest route.
 * - Imports {@link StorageModule} for `ObjectStorageService` (raw-object writes).
 * - 수집 요청은 DB transactional outbox에 기록하고 Worker dispatcher가
 *   `card-sms-parse` queue로 발행한다.
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs the
 * `card-sms-events` query routes, so neither is re-imported here.
 */
import { Module } from '@nestjs/common';

import { DevicesModule } from '../devices/devices.module';
import { StorageModule } from '../storage/storage.module';
import { CardSmsEventsController } from './card-sms-events.controller';
import { CardSmsIngestService } from './card-sms-ingest.service';
import { CardSmsQueryService } from './card-sms-query.service';
import { CardSmsController } from './card-sms.controller';

@Module({
  imports: [DevicesModule, StorageModule],
  controllers: [CardSmsController, CardSmsEventsController],
  providers: [CardSmsIngestService, CardSmsQueryService],
})
export class CardSmsModule {}
