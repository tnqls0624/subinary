/**
 * AI work-query service (Phase 7 Build Spec §6.3).
 *
 * Orchestrates retrieval → evidence check → grounded answer:
 *   1. {@link RetrievalService.search} runs the hybrid FTS + vector search
 *      (owner-only; 403 for non-owners) over the workspace.
 *   2. Evidence sufficiency is decided by app logic, not the LLM (spec §1.3):
 *      when no retrieved item carries a FTS match the query is `refused` and
 *      the LLM is never called.
 *   3. Otherwise ownership is re-verified immediately before the context is
 *      handed to the LLM (PRD §26), and the LLM explains the retrieved passages
 *      into a grounded answer with 100% citation coverage.
 *
 * The LLM never judges sufficiency or ranking — it only describes context
 * (spec §0/§1.3). Logs carry counts/model ids only, never question text,
 * passages, PII, or secrets (spec §0).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ProviderSet } from '@family/ai-providers';
import type { RetrievalResponse, WorkQueryResponse } from '@family/contracts';

import { RetrievalService } from '../retrieval/retrieval.service';
import { AI_PROVIDERS } from './ai.constants';

/** Human-readable reason returned when a query lacks grounding evidence. */
const REFUSAL_REASON = '근거를 찾지 못했습니다';

/** Options for {@link AiQueryService.workQuery}. */
export interface WorkQueryOptions {
  workspaceId: string;
  question: string;
}

/** Options for {@link AiQueryService.retrieve}. */
export interface RetrieveOptions {
  workspaceId: string;
  query: string;
  topK?: number;
}

@Injectable()
export class AiQueryService {
  private readonly logger = new Logger(AiQueryService.name);

  constructor(
    private readonly retrieval: RetrievalService,
    @Inject(AI_PROVIDERS) private readonly providers: ProviderSet,
  ) {}

  /**
   * Answers a natural-language question grounded in the owner's Slack workspace,
   * or refuses when there is no keyword evidence.
   */
  async workQuery(
    userId: string,
    options: WorkQueryOptions,
  ): Promise<WorkQueryResponse> {
    const { workspaceId, question } = options;
    const result = await this.retrieval.search(userId, {
      workspaceId,
      query: question,
    });

    if (!result.hasEvidence) {
      // App logic refuses without evidence — the LLM is not called (spec §1.3).
      this.logger.log(
        `work-query refused workspace=${workspaceId} ` +
          `retrieved=${result.items.length}`,
      );
      return {
        refused: true,
        answer: null,
        reason: REFUSAL_REASON,
        citations: [],
        meta: { retrievedCount: result.items.length, model: '' },
      };
    }

    // Re-verify ownership immediately before the LLM sees any context (PRD §26).
    await this.retrieval.assertOwnedWorkspace(userId, workspaceId);

    const context = result.items.map((it) => ({
      id: it.chunkId,
      text: it.text,
    }));
    const generated = await this.providers.llm.generate({
      question,
      context,
      // Fallback prompt for providers that do not read `context` directly; the
      // mock keys on `context`, so its answer cites the passages.
      prompt: buildPrompt(question, context),
    });

    const citations = result.items.map((it) => it.citation);
    this.logger.log(
      `work-query answered workspace=${workspaceId} ` +
        `retrieved=${result.items.length} model=${generated.model}`,
    );

    return {
      refused: false,
      answer: generated.text,
      reason: null,
      citations,
      meta: { retrievedCount: result.items.length, model: generated.model },
    };
  }

  /**
   * Debug/verification hybrid search (no answer generation). Maps the internal
   * retrieval result to the `retrievalResponseSchema` shape (drops chunk text).
   */
  async retrieve(
    userId: string,
    options: RetrieveOptions,
  ): Promise<RetrievalResponse> {
    const result = await this.retrieval.search(userId, {
      workspaceId: options.workspaceId,
      query: options.query,
      topK: options.topK,
    });

    return {
      hasEvidence: result.hasEvidence,
      items: result.items.map((it) => ({
        chunkId: it.chunkId,
        snippet: it.snippet,
        score: it.score,
        hasFtsMatch: it.hasFtsMatch,
        citation: it.citation,
      })),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Composes a grounded prompt from the question and retrieved passages. */
function buildPrompt(
  question: string,
  context: { id: string; text: string }[],
): string {
  const passages = context
    .map((passage, index) => `[${index + 1}] ${passage.text}`)
    .join('\n\n');
  return `질문: ${question}\n\n참고 기록:\n${passages}`;
}
