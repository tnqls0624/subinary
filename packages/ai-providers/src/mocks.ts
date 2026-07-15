/**
 * Phase 0 Mock provider 구현 (Phase 0 Build Spec §6.4).
 *
 * - 외부 네트워크 호출 없음, 순수 TypeScript.
 * - 모든 출력은 결정적(deterministic): 동일 입력 → 항상 동일 출력.
 * - 로그를 남기지 않는다 (개인정보/Secret 로그 금지 정책과 무관하게 부수효과 없음).
 */
import type {
  EmbeddingProvider,
  GenerateRequest,
  GenerateResponse,
  LlmProvider,
  RerankerProvider,
  RerankRequest,
  RerankResponse,
  RerankResultItem,
} from './types.js';

/** Mock 임베딩 벡터의 고정 차원 수. */
export const MOCK_EMBEDDING_DIMENSION = 8;

/** 대략적 토큰 수 추정 (약 4자 ≈ 1토큰). Mock 전용 근사치. */
function approximateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

/**
 * Mock LLM provider — 고정 문자열 + 입력 echo.
 * `maxTokens`가 지정되면 근사 토큰 기준으로 잘라내고 `finishReason: 'length'`를 반환한다.
 */
export class MockLlmProvider implements LlmProvider {
  private readonly model = 'mock-llm-v0';

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    if (req === null || typeof req !== 'object' || typeof req.prompt !== 'string') {
      throw new TypeError('[@family/ai-providers] GenerateRequest.prompt must be a string');
    }
    if (req.maxTokens !== undefined && (!Number.isInteger(req.maxTokens) || req.maxTokens < 1)) {
      throw new RangeError('[@family/ai-providers] GenerateRequest.maxTokens must be a positive integer');
    }

    // 고정 문자열 + echo (결정적).
    let text = `[mock-llm] This is a deterministic mock response. echo: ${req.prompt}`;
    let finishReason: GenerateResponse['finishReason'] = 'stop';

    if (req.maxTokens !== undefined) {
      const maxChars = req.maxTokens * 4;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        finishReason = 'length';
      }
    }

    const inputTokens =
      approximateTokens(req.prompt) + (req.system !== undefined ? approximateTokens(req.system) : 0);

    return {
      text,
      model: this.model,
      finishReason,
      usage: {
        inputTokens,
        outputTokens: approximateTokens(text),
      },
    };
  }
}

/**
 * Mock 임베딩 provider — 텍스트 길이/문자코드 기반의 결정적 의사 벡터.
 * 고정 차원 {@link MOCK_EMBEDDING_DIMENSION}(=8), L2 정규화.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    if (!Array.isArray(texts)) {
      throw new TypeError('[@family/ai-providers] embed(texts) requires an array of strings');
    }
    return texts.map((text, i) => {
      if (typeof text !== 'string') {
        throw new TypeError(`[@family/ai-providers] embed(texts): texts[${i}] must be a string`);
      }
      return this.embedOne(text);
    });
  }

  /** 단일 텍스트 → 결정적 8차원 벡터. 빈 문자열은 영벡터를 반환한다. */
  private embedOne(text: string): number[] {
    const vector = new Array<number>(MOCK_EMBEDDING_DIMENSION).fill(0);
    if (text.length === 0) {
      return vector;
    }
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      const dim = i % MOCK_EMBEDDING_DIMENSION;
      // 위치 가중치를 섞어, 문자 구성이 같고 순서만 다른 입력도 서로 다른 벡터가 되게 한다.
      vector[dim] += code * ((i % 7) + 1);
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) {
      return vector;
    }
    return vector.map((v) => v / norm);
  }
}

/**
 * Mock 재순위화 provider — 입력 순서를 그대로 유지한다.
 * 앞선 문서일수록 높은 점수를 부여하며(결정적), `topK`가 지정되면 상위 N개만 반환한다.
 */
export class MockRerankerProvider implements RerankerProvider {
  private readonly model = 'mock-reranker-v0';

  async rerank(req: RerankRequest): Promise<RerankResponse> {
    if (req === null || typeof req !== 'object' || typeof req.query !== 'string') {
      throw new TypeError('[@family/ai-providers] RerankRequest.query must be a string');
    }
    if (!Array.isArray(req.documents)) {
      throw new TypeError('[@family/ai-providers] RerankRequest.documents must be an array');
    }
    if (req.topK !== undefined && (!Number.isInteger(req.topK) || req.topK < 1)) {
      throw new RangeError('[@family/ai-providers] RerankRequest.topK must be a positive integer');
    }

    const total = req.documents.length;
    const limit = req.topK !== undefined ? Math.min(req.topK, total) : total;

    const results: RerankResultItem[] = req.documents.slice(0, limit).map((document, index) => ({
      index,
      document,
      score: (total - index) / total,
    }));

    return { results, model: this.model };
  }
}
