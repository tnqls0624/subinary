import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createProviders } from '@family/ai-providers';
import type { AppConfig } from '@family/config';

import { AnalyticsModule } from '../analytics/analytics.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { AiQueryController } from './ai-query.controller';
import { AiQueryService } from './ai-query.service';
import { FinanceAiController } from './finance-ai.controller';
import { FinanceAiService } from './finance-ai.service';
import { AI_PROVIDERS } from './ai.constants';

/**
 * Model-agnostic AI provider boundary (PRD 3.4).
 *
 * Provides `AI_PROVIDERS` (`{ llm, embedding, reranker }`) selected by
 * `config.ai.provider` — Phase 0 wired mock providers only. Phase 7 adds the
 * hybrid-RAG query surface: `AiQueryService`/`AiQueryController` orchestrate
 * retrieval → evidence check → grounded answer (spec §6.3/§6.4).
 *
 * Marked `@Global` (like `DatabaseModule`) so `AI_PROVIDERS` is a single
 * app-wide instance reachable by consumers — notably `RetrievalService` in
 * {@link RetrievalModule} — without an explicit import. That also keeps the
 * module graph acyclic: this module imports `RetrievalModule` (for
 * `RetrievalService`), while `RetrievalModule` reaches `AI_PROVIDERS` through
 * the global registration rather than importing this module back.
 */
@Global()
@Module({
  // AnalyticsModule: FinanceAiService가 권한 검증된 SQL 집계(AnalyticsService)를
  // 재사용한다(금액은 LLM이 아닌 집계에서만 온다).
  imports: [RetrievalModule, AnalyticsModule],
  controllers: [AiQueryController, FinanceAiController],
  providers: [
    {
      provide: AI_PROVIDERS,
      inject: [ConfigService],
      useFactory: (
        configService: ConfigService,
      ): ReturnType<typeof createProviders> => {
        const ai = configService.get<AppConfig['ai']>('ai');
        if (!ai) {
          throw new Error('AI configuration is missing');
        }
        return createProviders(ai);
      },
    },
    AiQueryService,
    FinanceAiService,
  ],
  exports: [AI_PROVIDERS],
})
export class AiModule {}
