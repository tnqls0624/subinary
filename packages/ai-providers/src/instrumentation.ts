/**
 * AI Provider 관측 래퍼(ADR-0017 P0).
 *
 * 원문 입력은 프로세스 메모리에서 SHA-256 지문을 계산하는 데만 사용하며,
 * observer로는 절대 전달하지 않는다. observer 저장 실패는 사용자 AI 호출을
 * 실패시키지 않는다.
 */
import { createHash, randomUUID } from 'node:crypto';

import type {
  AiInvocationEvent,
  AiInvocationObserver,
  AiRequestMetadata,
  EmbeddingProvider,
  GenerateRequest,
  LlmProvider,
  RerankerProvider,
} from './types.js';
import type { ProviderSet } from './factory.js';

/** {@link instrumentProviders} 옵션. */
export interface InstrumentProvidersOptions {
  observer: AiInvocationObserver;
  /** metadata.task가 없을 때 사용할 안전한 기본 태스크명. */
  defaultTask?: string;
}

/** 원문을 외부로 내보내지 않고 결정적 SHA-256 지문만 만든다. */
function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

/** 비어 있는 메타데이터를 trace용 안전한 값으로 정규화한다. */
function traceMetadata(
  metadata: AiRequestMetadata | undefined,
  defaultTask: string,
): {
  task: string;
  promptVersion: string | null;
  pipelineRunId: string | null;
  modelAliasId: string | null;
  modelAliasRevision: number | null;
  modelRegistryId: string | null;
  trafficPolicyId: string | null;
  trafficMode: 'shadow' | 'live' | null;
  trafficRole: 'primary' | 'candidate' | null;
  trafficBucket: number | null;
  trafficSelected: boolean | null;
} {
  const task = metadata?.task?.trim();
  const promptVersion = metadata?.promptVersion?.trim();
  const pipelineRunId = metadata?.pipelineRunId?.trim();
  const modelAliasId = metadata?.modelAliasId?.trim();
  const modelAliasRevision = metadata?.modelAliasRevision;
  const modelRegistryId = metadata?.modelRegistryId?.trim();
  const trafficPolicyId = metadata?.trafficPolicyId?.trim();
  const trafficMode = metadata?.trafficMode;
  const trafficRole = metadata?.trafficRole;
  const trafficBucket = metadata?.trafficBucket;
  const trafficSelected = metadata?.trafficSelected;
  const hasServingTrace =
    modelAliasId !== undefined &&
    modelAliasId.length > 0 &&
    Number.isInteger(modelAliasRevision) &&
    (modelAliasRevision ?? 0) > 0 &&
    modelRegistryId !== undefined &&
    modelRegistryId.length > 0;
  const hasTrafficTrace =
    trafficPolicyId !== undefined &&
    trafficPolicyId.length > 0 &&
    (trafficMode === 'shadow' || trafficMode === 'live') &&
    (trafficRole === 'primary' || trafficRole === 'candidate') &&
    Number.isInteger(trafficBucket) &&
    (trafficBucket ?? -1) >= 0 &&
    (trafficBucket ?? 10_000) < 10_000 &&
    typeof trafficSelected === 'boolean';
  return {
    task: task && task.length > 0 ? task : defaultTask,
    promptVersion:
      promptVersion && promptVersion.length > 0 ? promptVersion : null,
    pipelineRunId:
      pipelineRunId && pipelineRunId.length > 0 ? pipelineRunId : null,
    modelAliasId: hasServingTrace ? modelAliasId : null,
    modelAliasRevision: hasServingTrace ? modelAliasRevision ?? null : null,
    modelRegistryId: hasServingTrace ? modelRegistryId : null,
    trafficPolicyId: hasTrafficTrace ? trafficPolicyId : null,
    trafficMode: hasTrafficTrace ? trafficMode : null,
    trafficRole: hasTrafficTrace ? trafficRole : null,
    trafficBucket: hasTrafficTrace ? trafficBucket ?? null : null,
    trafficSelected: hasTrafficTrace ? trafficSelected : null,
  };
}

/** 오류 원문 대신 안정적인 class/name만 기록한다. */
function errorCode(error: unknown): string {
  return error instanceof Error && error.name.length > 0
    ? error.name
    : 'UnknownError';
}

/** observer 장애가 실제 AI 경로를 오염시키지 않게 격리한다. */
async function recordSafely(
  observer: AiInvocationObserver,
  event: AiInvocationEvent,
): Promise<boolean> {
  try {
    await observer.record(event);
    return true;
  } catch {
    // 관측 실패에는 원문/오류 메시지를 로그하지 않는다.
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[@family/ai-providers] AI invocation observer failed');
    }
    return false;
  }
}

/** LLM provider에 원문 없는 호출 관측을 추가한다. */
function instrumentLlm(
  provider: LlmProvider,
  options: InstrumentProvidersOptions,
): LlmProvider {
  return {
    provider: provider.provider,
    model: provider.model,
    async generate(request: GenerateRequest) {
      const traceId = randomUUID();
      const startedAt = new Date();
      const metadata = traceMetadata(
        request.metadata,
        options.defaultTask ?? 'unspecified',
      );
      const inputFingerprint = fingerprint({
        prompt: request.prompt ?? null,
        system: request.system ?? null,
        question: request.question ?? null,
        context: request.context ?? [],
        maxTokens: request.maxTokens ?? null,
        temperature: request.temperature ?? null,
      });

      try {
        const response = await provider.generate(request);
        const finishedAt = new Date();
        const recorded = await recordSafely(options.observer, {
          traceId,
          ...metadata,
          operation: 'llm_generate',
          provider: provider.provider,
          model: response.model,
          inputFingerprint,
          inputCount: 1,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          outcome: 'succeeded',
          errorCode: null,
          startedAt,
          finishedAt,
        });
        return recorded ? { ...response, traceId } : response;
      } catch (error: unknown) {
        const finishedAt = new Date();
        await recordSafely(options.observer, {
          traceId,
          ...metadata,
          operation: 'llm_generate',
          provider: provider.provider,
          model: provider.model,
          inputFingerprint,
          inputCount: 1,
          inputTokens: null,
          outputTokens: null,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          outcome: 'failed',
          errorCode: errorCode(error),
          startedAt,
          finishedAt,
        });
        throw error;
      }
    },
  };
}

/** Embedding provider에 원문/벡터 없는 호출 관측을 추가한다. */
function instrumentEmbedding(
  provider: EmbeddingProvider,
  options: InstrumentProvidersOptions,
): EmbeddingProvider {
  return {
    provider: provider.provider,
    model: provider.model,
    dimensions: provider.dimensions,
    async embed(texts: string[], requestMetadata?: AiRequestMetadata) {
      const traceId = randomUUID();
      const startedAt = new Date();
      const metadata = traceMetadata(
        requestMetadata,
        options.defaultTask ?? 'unspecified',
      );
      const inputFingerprint = fingerprint(texts);

      try {
        const vectors = await provider.embed(texts, requestMetadata);
        const finishedAt = new Date();
        await recordSafely(options.observer, {
          traceId,
          ...metadata,
          operation: 'embedding',
          provider: provider.provider,
          model: provider.model,
          inputFingerprint,
          inputCount: texts.length,
          inputTokens: null,
          outputTokens: null,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          outcome: 'succeeded',
          errorCode: null,
          startedAt,
          finishedAt,
        });
        return vectors;
      } catch (error: unknown) {
        const finishedAt = new Date();
        await recordSafely(options.observer, {
          traceId,
          ...metadata,
          operation: 'embedding',
          provider: provider.provider,
          model: provider.model,
          inputFingerprint,
          inputCount: Array.isArray(texts) ? texts.length : 0,
          inputTokens: null,
          outputTokens: null,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          outcome: 'failed',
          errorCode: errorCode(error),
          startedAt,
          finishedAt,
        });
        throw error;
      }
    },
  };
}

/** Reranker provider에 질의/문서 원문 없는 호출 관측을 추가한다. */
function instrumentReranker(
  provider: RerankerProvider,
  options: InstrumentProvidersOptions,
): RerankerProvider {
  return {
    provider: provider.provider,
    model: provider.model,
    async rerank(request) {
      const traceId = randomUUID();
      const startedAt = new Date();
      const metadata = traceMetadata(
        request.metadata,
        options.defaultTask ?? 'unspecified',
      );
      const inputFingerprint = fingerprint({
        query: request.query,
        documents: request.documents,
        topK: request.topK ?? null,
      });

      try {
        const response = await provider.rerank(request);
        const finishedAt = new Date();
        await recordSafely(options.observer, {
          traceId,
          ...metadata,
          operation: 'rerank',
          provider: provider.provider,
          model: response.model,
          inputFingerprint,
          inputCount: request.documents.length,
          inputTokens: null,
          outputTokens: null,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          outcome: 'succeeded',
          errorCode: null,
          startedAt,
          finishedAt,
        });
        return response;
      } catch (error: unknown) {
        const finishedAt = new Date();
        await recordSafely(options.observer, {
          traceId,
          ...metadata,
          operation: 'rerank',
          provider: provider.provider,
          model: provider.model,
          inputFingerprint,
          inputCount: Array.isArray(request.documents)
            ? request.documents.length
            : 0,
          inputTokens: null,
          outputTokens: null,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          outcome: 'failed',
          errorCode: errorCode(error),
          startedAt,
          finishedAt,
        });
        throw error;
      }
    },
  };
}

/** ProviderSet 전체에 동일한 observer를 적용한다. */
export function instrumentProviders(
  providers: ProviderSet,
  options: InstrumentProvidersOptions,
): ProviderSet {
  return {
    llm: instrumentLlm(providers.llm, options),
    embedding: instrumentEmbedding(providers.embedding, options),
    reranker: instrumentReranker(providers.reranker, options),
  };
}
