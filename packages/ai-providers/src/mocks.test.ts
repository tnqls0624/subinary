import { describe, expect, it } from 'vitest';

import {
  MOCK_EMBEDDING_DIMENSION,
  MockEmbeddingProvider,
  MockLlmProvider,
  MockRerankerProvider,
} from './mocks.js';
import type { RerankDocument } from './types.js';

function l2Norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

describe('MockEmbeddingProvider', () => {
  const provider = new MockEmbeddingProvider();

  it('exposes dimensions=256 and model="mock"', () => {
    expect(MOCK_EMBEDDING_DIMENSION).toBe(256);
    expect(provider.dimensions).toBe(256);
    expect(provider.model).toBe('mock');
  });

  it('is deterministic: same text → identical 256-dim vector', async () => {
    const text = 'Route53 인증서 갱신 실패 → ACM 재발급으로 해결';
    const [a] = await provider.embed([text]);
    const [b] = await provider.embed([text]);
    expect(a).toHaveLength(256);
    expect(b).toHaveLength(256);
    expect(a).toEqual(b);
  });

  it('L2-normalizes non-empty text (norm ≈ 1)', async () => {
    const [vec] = await provider.embed(['PostgreSQL 파티셔닝 도입 결정']);
    expect(l2Norm(vec)).toBeCloseTo(1, 6);
  });

  it('returns a 256-dim zero vector for empty / token-less text', async () => {
    const [empty, punctuation] = await provider.embed(['', '!!! ... ???']);
    expect(empty).toHaveLength(256);
    expect(l2Norm(empty)).toBe(0);
    expect(punctuation).toHaveLength(256);
    expect(l2Norm(punctuation)).toBe(0);
  });

  it('produces different vectors for different texts', async () => {
    const [a, b] = await provider.embed(['hello world', '완전히 다른 문장 입니다']);
    expect(a).not.toEqual(b);
  });

  it('embeds each input in order', async () => {
    const vectors = await provider.embed(['첫 번째', '두 번째', '세 번째']);
    expect(vectors).toHaveLength(3);
    // 순서대로 개별 임베딩과 일치.
    const [single] = await provider.embed(['두 번째']);
    expect(vectors[1]).toEqual(single);
  });

  it('throws on non-array input and non-string elements', async () => {
    // @ts-expect-error intentional bad input
    await expect(provider.embed('nope')).rejects.toBeInstanceOf(TypeError);
    // @ts-expect-error intentional bad element
    await expect(provider.embed(['ok', 42])).rejects.toBeInstanceOf(TypeError);
  });
});

describe('MockRerankerProvider', () => {
  const provider = new MockRerankerProvider();
  const documents: RerankDocument[] = [
    { id: 'a', text: 'first' },
    { id: 'b', text: 'second' },
    { id: 'c', text: 'third' },
  ];

  it('preserves input order with score = 1 / (1 + idx)', async () => {
    const res = await provider.rerank({ query: 'q', documents });
    expect(res.results.map((r) => r.document.id)).toEqual(['a', 'b', 'c']);
    expect(res.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(res.results.map((r) => r.score)).toEqual([1, 1 / 2, 1 / 3]);
    // 점수는 순서대로 단조 감소.
    expect(res.results[0].score).toBeGreaterThan(res.results[1].score);
  });

  it('applies topK slicing from the front', async () => {
    const res = await provider.rerank({ query: 'q', documents, topK: 2 });
    expect(res.results.map((r) => r.document.id)).toEqual(['a', 'b']);
  });

  it('validates query, documents and topK', async () => {
    // @ts-expect-error bad query
    await expect(provider.rerank({ documents })).rejects.toBeInstanceOf(TypeError);
    // @ts-expect-error bad documents
    await expect(provider.rerank({ query: 'q', documents: 'x' })).rejects.toBeInstanceOf(TypeError);
    await expect(provider.rerank({ query: 'q', documents, topK: 0 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('MockLlmProvider', () => {
  const provider = new MockLlmProvider();

  it('cites first sentence of each passage when context is present', async () => {
    const res = await provider.generate({
      question: 'Route53 인증서 문제 어떻게 해결했어?',
      context: [
        { id: 'c1', text: 'Route53 인증서 갱신 실패. ACM 재발급으로 해결.' },
        { id: 'c2', text: 'DNS 검증 레코드도 추가함' },
      ],
    });
    expect(res.text.startsWith('기록에 따르면 ')).toBe(true);
    expect(res.text).toContain('Route53 인증서 갱신 실패.');
    expect(res.text).toContain('DNS 검증 레코드도 추가함');
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.finishReason).toBe('stop');
  });

  it('returns "근거 없음" when there is no context', async () => {
    const withoutContext = await provider.generate({ question: '다음 분기 환율 전망은?' });
    expect(withoutContext.text).toBe('근거 없음');
    const emptyContext = await provider.generate({ question: 'q', context: [] });
    expect(emptyContext.text).toBe('근거 없음');
  });

  it('is deterministic for identical requests', async () => {
    const req = { question: 'q', context: [{ id: 'c1', text: '기록 A. 두 번째 문장.' }] };
    const first = await provider.generate(req);
    const second = await provider.generate(req);
    expect(first.text).toBe(second.text);
    expect(first.usage).toEqual(second.usage);
  });

  it('truncates with finishReason="length" when maxTokens is small', async () => {
    const res = await provider.generate({
      question: 'q',
      context: [{ id: 'c1', text: '아주 긴 근거 문장이 여기에 있습니다.' }],
      maxTokens: 1,
    });
    expect(res.finishReason).toBe('length');
    expect(res.text.length).toBe(4);
  });

  it('validates request shape and context items', async () => {
    // @ts-expect-error bad request
    await expect(provider.generate(null)).rejects.toBeInstanceOf(TypeError);
    await expect(
      provider.generate({ question: 'q', maxTokens: 0, context: [{ id: 'c', text: 't' }] }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      // @ts-expect-error bad context item
      provider.generate({ question: 'q', context: [{ id: 'c' }] }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
