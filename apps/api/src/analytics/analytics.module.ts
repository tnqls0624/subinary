/**
 * Analytics module (Phase 5 Build Spec §5.1).
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs these routes, so
 * neither is re-imported here. The service enforces household membership and
 * per-row visibility scope in the service layer (PRD §26).
 *
 * `AppModule` imports this module (owned by the P3 partition, per spec §10).
 * `AnalyticsService` is exported so the AI module (`FinanceAiService`) can
 * reuse the permission-checked SQL aggregations for finance queries/insights.
 */
import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
