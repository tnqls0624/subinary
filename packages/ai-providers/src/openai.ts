/**
 * OpenAI 기반 provider 스켈레톤 (Phase 7 Build Spec §4).
 *
 * ⚠️ 스켈레톤: Phase 7 검증은 전적으로 Mock provider로 수행한다. 이 파일은
 * 실제 provider 교체 지점을 확보하기 위한 골격이며 통합 검증에 사용되지 않는다.
 * (실제 OpenAI 임베딩 차원이 256과 다르면 재임베딩이 필요하다 — §0 경계 참고.)
 *
 * 순수 fetch 기반, 신규 npm 의존성 없음. API 키가 필요하다.
 */
import type { EmbeddingProvider } from './types.js';

/** {@link OpenAiEmbeddingProvider} 생성 옵션. */
export interface OpenAiEmbeddingOptions {
  /** OpenAI API 키 (필수). 로그로 출력하지 않는다. */
  apiKey: string;
  /** 임베딩 모델명 (기본: 'text-embedding-3-small'). */
  model?: string;
  /**
   * 요청 차원 수 (기본: 256). Phase 7 스키마 `vector(256)`와 일치시킨다.
   * `text-embedding-3-*`는 `dimensions` 파라미터로 축소 임베딩을 지원한다.
   */
  dimensions?: number;
  /** API base URL (기본: 'https://api.openai.com/v1'). */
  baseUrl?: string;
}

interface OpenAiEmbeddingApiResponse {
  data: { embedding: number[] }[];
}

/**
 * OpenAI Embeddings API 기반 {@link EmbeddingProvider} 스켈레톤.
 *
 * 입력 순서를 보존해 벡터 배열을 반환한다. 검증 미사용(스켈레톤).
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OpenAiEmbeddingOptions) {
    if (!options || typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new Error('[@family/ai-providers] OpenAiEmbeddingProvider requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'text-embedding-3-small';
    this.dimensions = options.dimensions ?? 256;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!Array.isArray(texts)) {
      throw new TypeError('[@family/ai-providers] embed(texts) requires an array of strings');
    }
    if (texts.length === 0) {
      return [];
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      // 응답 본문(키/원문 포함 가능)은 로그/에러 메시지에 담지 않는다.
      throw new Error(`[@family/ai-providers] OpenAI embeddings request failed: ${response.status}`);
    }

    const payload = (await response.json()) as OpenAiEmbeddingApiResponse;
    if (!payload || !Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new Error('[@family/ai-providers] OpenAI embeddings response shape unexpected');
    }
    return payload.data.map((item) => item.embedding);
  }
}
