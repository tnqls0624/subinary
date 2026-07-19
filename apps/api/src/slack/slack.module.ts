/**
 * Slack module (Phase 6 Build Spec §5.4).
 *
 * - Imports {@link StorageModule} for `ObjectStorageService` (raw-bundle writes
 *   to MinIO).
 * - Import 요청은 DB transactional outbox에 기록하고 Worker dispatcher가
 *   `slack-import` queue로 발행한다.
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs every Slack
 * route, so neither is re-imported here.
 */
import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { SlackController } from './slack.controller';
import { SlackMessageMutationService } from './slack-message-mutation.service';
import { SlackService } from './slack.service';

@Module({
  imports: [StorageModule],
  controllers: [SlackController],
  providers: [SlackService, SlackMessageMutationService],
})
export class SlackModule {}
