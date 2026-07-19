import { describe, expect, it, vi } from 'vitest';

import { createProviders } from './factory.js';
import { instrumentProviders } from './instrumentation.js';
import type { AiInvocationEvent, ProviderSet } from './index.js';

/** 테스트 observer: 실제 DB 대신 원문 없는 event만 메모리에 수집한다. */
function collectingObserver(events: AiInvocationEvent[]) {
  return {
    record(event: AiInvocationEvent): void {
      events.push(event);
    },
  };
}

describe('instrumentProviders', () => {
  it('records LLM/embedding/rerank success without raw inputs or outputs', async () => {
    const events: AiInvocationEvent[] = [];
    const providers = instrumentProviders(createProviders(), {
      observer: collectingObserver(events),
    });
    const pipelineRunId = '00000000-0000-4000-8000-000000000001';

    const generated = await providers.llm.generate({
      question: '절대 저장하면 안 되는 질문 원문',
      context: [{ id: 'chunk-secret', text: '민감한 Slack 원문' }],
      metadata: {
        task: 'rag-work-query',
        promptVersion: 'work-query-v1',
        pipelineRunId,
        modelAliasId: '00000000-0000-4000-8000-000000000010',
        modelAliasRevision: 3,
        modelRegistryId: '00000000-0000-4000-8000-000000000011',
        trafficPolicyId: '00000000-0000-4000-8000-000000000012',
        trafficMode: 'shadow',
        trafficRole: 'candidate',
        trafficBucket: 412,
        trafficSelected: false,
        ignored: '내보내면 안 되는 임의 메타데이터',
      },
    });
    await providers.embedding.embed(['민감한 임베딩 입력'], {
      task: 'rag-query-embedding',
      promptVersion: 'embedding-input-v1',
    });
    await providers.reranker.rerank({
      query: '민감한 검색 질의',
      documents: [{ id: 'c1', text: '민감한 검색 문서' }],
      metadata: { task: 'rag-rerank', promptVersion: 'rrf-rerank-v1' },
    });

    expect(events.map((event) => event.operation)).toEqual([
      'llm_generate',
      'embedding',
      'rerank',
    ]);
    expect(events[0]).toMatchObject({
      task: 'rag-work-query',
      promptVersion: 'work-query-v1',
      pipelineRunId,
      modelAliasId: '00000000-0000-4000-8000-000000000010',
      modelAliasRevision: 3,
      modelRegistryId: '00000000-0000-4000-8000-000000000011',
      trafficPolicyId: '00000000-0000-4000-8000-000000000012',
      trafficMode: 'shadow',
      trafficRole: 'candidate',
      trafficBucket: 412,
      trafficSelected: false,
      provider: 'mock',
      model: 'mock-llm-v0',
      outcome: 'succeeded',
      errorCode: null,
    });
    expect(generated.traceId).toBe(events[0].traceId);
    expect(events[1]).toMatchObject({
      modelAliasId: null,
      modelAliasRevision: null,
      modelRegistryId: null,
      trafficPolicyId: null,
      trafficMode: null,
      trafficRole: null,
      trafficBucket: null,
      trafficSelected: null,
    });
    for (const event of events) {
      expect(event.traceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('절대 저장하면 안 되는 질문 원문');
    expect(serialized).not.toContain('민감한 Slack 원문');
    expect(serialized).not.toContain('민감한 임베딩 입력');
    expect(serialized).not.toContain('민감한 검색 질의');
    expect(serialized).not.toContain('민감한 검색 문서');
    expect(serialized).not.toContain('내보내면 안 되는 임의 메타데이터');
    expect(serialized).not.toContain('근거 없음');
  });

  it('records a sanitized error code and rethrows the original provider error', async () => {
    const events: AiInvocationEvent[] = [];
    const failure = new TypeError('오류 메시지에도 원문이 있을 수 있음');
    const base = createProviders();
    const failing: ProviderSet = {
      ...base,
      llm: {
        provider: 'test',
        model: 'failing-model',
        async generate() {
          throw failure;
        },
      },
    };
    const providers = instrumentProviders(failing, {
      observer: collectingObserver(events),
      defaultTask: 'fallback-task',
    });

    await expect(
      providers.llm.generate({ prompt: '민감한 실패 입력' }),
    ).rejects.toBe(failure);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      task: 'fallback-task',
      outcome: 'failed',
      errorCode: 'TypeError',
      inputTokens: null,
      outputTokens: null,
    });
    expect(JSON.stringify(events[0])).not.toContain('민감한 실패 입력');
    expect(JSON.stringify(events[0])).not.toContain(failure.message);
    expect(events[0]).toMatchObject({
      modelAliasId: null,
      modelAliasRevision: null,
      modelRegistryId: null,
    });
  });

  it('does not fail the provider call when the observer fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const providers = instrumentProviders(createProviders(), {
      observer: {
        async record(): Promise<void> {
          throw new Error('observer storage unavailable');
        },
      },
    });

    const [vector] = await providers.embedding.embed(['정상 입력']);
    const generated = await providers.llm.generate({ prompt: '정상 질문' });
    expect(vector).toHaveLength(256);
    expect(generated.traceId).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[@family/ai-providers] AI invocation observer failed',
    );
    warn.mockRestore();
  });
});
