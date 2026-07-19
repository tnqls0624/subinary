/**
 * Mock provider 구현 (Phase 0 Build Spec §6.4 / Phase 7 Build Spec §4).
 *
 * - 외부 네트워크 호출 없음, 순수 TypeScript.
 * - 모든 출력은 결정적(deterministic): 동일 입력 → 항상 동일 출력. 랜덤/시간 미사용.
 * - 로그를 남기지 않는다 (원문/PII/임베딩값 로그 금지 정책과 무관하게 부수효과 없음).
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

/**
 * Mock 임베딩 벡터의 고정 차원 수.
 * Phase 7 스키마의 `vector(256)` / `EMBEDDING_DIM=256`과 일치해야 한다.
 */
export const MOCK_EMBEDDING_DIMENSION = 256;

/** Mock 임베딩 모델 식별자 (embeddings.model 컬럼에 그대로 저장된다). */
export const MOCK_EMBEDDING_MODEL = 'mock';

/** Mock LLM 모델 식별자. */
export const MOCK_LLM_MODEL = 'mock-llm-v0';

/** Mock reranker 모델 식별자. */
export const MOCK_RERANKER_MODEL = 'mock-reranker-v0';

/** 대략적 토큰 수 추정 (약 4자 ≈ 1토큰). Mock 전용 근사치. */
function approximateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

/**
 * 32-bit FNV-1a 해시 (결정적, 순수).
 * 문자열의 UTF-16 코드 유닛을 순서대로 섞어 부호 없는 32-bit 정수를 만든다.
 */
function fnv1a32(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    // FNV prime(16777619) 곱셈을 32-bit로 유지.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 텍스트를 토큰으로 분할한다.
 * 공백/문장부호(문자·숫자가 아닌 모든 코드포인트)로 나누고 소문자 정규화한다.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * 텍스트에서 첫 문장(첫 종결부호 또는 개행까지)을 발췌한다.
 * 종결부호가 없으면 전체를 반환. 없으면 빈 문자열.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const match = trimmed.match(/^[\s\S]*?[.!?。！？\n]/u);
  const sentence = match ? match[0] : trimmed;
  return sentence.trim();
}

/**
 * Mock LLM provider — 근거(context) 기반의 결정적 답변 생성.
 *
 * - `context` passage가 있으면 "기록에 따르면 " + 각 passage 첫 문장 발췌를 인용.
 * - 없으면 "근거 없음"을 반환(앱의 근거 충분성 판정과 일치).
 * - `maxTokens`가 지정되면 근사 토큰 기준으로 잘라내고 `finishReason: 'length'`를 반환한다.
 */
export class MockLlmProvider implements LlmProvider {
  readonly provider = 'mock';
  readonly model = MOCK_LLM_MODEL;

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    if (req === null || typeof req !== 'object') {
      throw new TypeError('[@family/ai-providers] GenerateRequest must be an object');
    }
    if (req.maxTokens !== undefined && (!Number.isInteger(req.maxTokens) || req.maxTokens < 1)) {
      throw new RangeError('[@family/ai-providers] GenerateRequest.maxTokens must be a positive integer');
    }
    if (req.context !== undefined && !Array.isArray(req.context)) {
      throw new TypeError('[@family/ai-providers] GenerateRequest.context must be an array');
    }

    const passages = req.context ?? [];
    passages.forEach((passage, i) => {
      if (
        passage === null ||
        typeof passage !== 'object' ||
        typeof passage.id !== 'string' ||
        typeof passage.text !== 'string'
      ) {
        throw new TypeError(
          `[@family/ai-providers] GenerateRequest.context[${i}] must be { id: string, text: string }`,
        );
      }
    });

    // 근거 기반 답변 조립 (결정적).
    let text: string;
    let finishReason: GenerateResponse['finishReason'] = 'stop';

    const excerpts = passages
      .map((passage) => firstSentence(passage.text))
      .filter((sentence) => sentence.length > 0);

    if (excerpts.length > 0) {
      text = `기록에 따르면 ${excerpts.join(' ')}`;
    } else {
      text = '근거 없음';
    }

    if (req.maxTokens !== undefined) {
      const maxChars = req.maxTokens * 4;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        finishReason = 'length';
      }
    }

    const promptText = req.question ?? req.prompt ?? '';
    const inputTokens =
      approximateTokens(promptText) +
      (req.system !== undefined ? approximateTokens(req.system) : 0) +
      passages.reduce((sum, passage) => sum + approximateTokens(passage.text), 0);

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
 * Mock 임베딩 provider — 결정적 256차원 벡터.
 *
 * 알고리즘: 텍스트를 토큰(공백/문장부호 분할)으로 나눠 각 토큰의 FNV-1a 해시를
 * 256개 버킷에 feature-hashing(부호 포함)으로 누적한 뒤 L2 정규화한다.
 * 같은 텍스트 → 항상 같은 벡터. `dimensions=256`, `model='mock'`.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'mock';
  readonly dimensions = MOCK_EMBEDDING_DIMENSION;
  readonly model = MOCK_EMBEDDING_MODEL;

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

  /**
   * 단일 텍스트 → 결정적 256차원 L2 정규화 벡터.
   * 토큰이 하나도 없으면(빈 문자열/문장부호만) 영벡터를 반환한다.
   */
  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      const hash = fnv1a32(token);
      const bucket = hash % this.dimensions;
      // 버킷은 하위 비트에서 결정되므로, 부호는 상위 비트에서 뽑아 상관을 낮춘다.
      const sign = ((hash >>> 8) & 1) === 1 ? -1 : 1;
      vector[bucket] += sign;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) {
      return vector;
    }
    return vector.map((value) => value / norm);
  }
}

/**
 * Mock 재순위화 provider — 입력 순서를 그대로 유지한다.
 * 앞선 문서일수록 높은 점수(`score = 1 / (1 + idx)`)를 부여하며(결정적),
 * `topK`가 지정되면 상위 N개만 반환한다.
 */
export class MockRerankerProvider implements RerankerProvider {
  readonly provider = 'mock';
  readonly model = MOCK_RERANKER_MODEL;

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
      score: 1 / (1 + index),
    }));

    return { results, model: this.model };
  }
}
