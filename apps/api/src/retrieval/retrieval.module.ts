/**
 * Retrieval module (Phase 7 Build Spec §6.2).
 *
 * Provides and exports {@link RetrievalService} — the hybrid FTS + vector
 * search used by `AiQueryService`. Its dependencies are both global providers,
 * so no module imports are needed here:
 *   - `DB` from the global `DatabaseModule`.
 *   - `AI_PROVIDERS` from the global `AiModule` (embedding + reranker).
 *
 * Deliberately does *not* import `AiModule` (which would create a cycle, since
 * `AiModule` imports this module to reach `RetrievalService`). The global
 * `AI_PROVIDERS` provider is resolved without an explicit import.
 *
 * The global `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs the
 * HTTP surface that reaches this service.
 */
import { Module } from '@nestjs/common';

import { RetrievalService } from './retrieval.service';

@Module({
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
