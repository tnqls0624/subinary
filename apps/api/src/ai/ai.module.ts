import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createProviders } from '@family/ai-providers';
import type { AppConfig } from '@family/config';

import { AI_PROVIDERS } from './ai.constants';

/**
 * Model-agnostic AI provider boundary (PRD 3.4).
 *
 * Phase 0 wires mock providers only — no HTTP endpoints, no LLM calls.
 * Later phases inject `AI_PROVIDERS` to reach LLM/Embedding/Reranker
 * implementations selected by `config.ai.provider`.
 */
@Module({
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
  ],
  exports: [AI_PROVIDERS],
})
export class AiModule {}
