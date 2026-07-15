/**
 * Analytics module (Phase 5 Build Spec §5.1).
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs these routes, so
 * neither is re-imported here. The service enforces household membership and
 * per-row visibility scope in the service layer (PRD §26).
 *
 * `AppModule` imports this module (owned by the P3 partition, per spec §10).
 */
import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
