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
import { MoneyModule } from '../money/money.module';
import { StorageModule } from '../storage/storage.module';
import { CardSmsEventsController } from './card-sms-events.controller';
import { CardSmsIngestService } from './card-sms-ingest.service';
import { CardSmsQueryService } from './card-sms-query.service';
import { CardSmsReviewService } from './card-sms-review.service';
import { CardSmsController } from './card-sms.controller';
import { ManualEntryController } from './manual-entry.controller';
import { ManualEntryService } from './manual-entry.service';

@Module({
  // MoneyModule: ADR-0027 3단계 — 수동 입력·사람 검토가 만든 거래를 새 금액 계약과
  // 대조해 기록만 한다(쓰기 경로는 그대로).
  imports: [DevicesModule, MoneyModule, StorageModule],
  controllers: [
    CardSmsController,
    CardSmsEventsController,
    ManualEntryController,
  ],
  providers: [
    CardSmsIngestService,
    CardSmsQueryService,
    // 격리·실패 건의 사람 확정 → 거래 승격 + 학습 라벨 생산(ADR-0023 S3).
    CardSmsReviewService,
    ManualEntryService,
  ],
})
export class CardSmsModule {}
