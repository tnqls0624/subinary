/**
 * Provider 팩토리 (Phase 0 Build Spec §6.4 / Phase 7 Build Spec §4).
 */
import { MockEmbeddingProvider, MockLlmProvider, MockRerankerProvider } from './mocks.js';
import { OpenAiEmbeddingProvider } from './openai.js';
import type { EmbeddingProvider, LlmProvider, RerankerProvider } from './types.js';

/** `createProviders`가 반환하는 provider 묶음. */
export interface ProviderSet {
  llm: LlmProvider;
  embedding: EmbeddingProvider;
  reranker: RerankerProvider;
}

/**
 * `createProviders` 설정.
 *
 * `provider`만 있는 `AppConfig['ai']`와 하위 호환된다(그 외 필드는 모두 선택).
 * API 키는 cfg 또는 환경변수에서 읽는다.
 */
export interface CreateProvidersConfig {
  /** 'mock'(기본) | 'openai' | 'anthropic' | 'google'. */
  provider?: string;
  /** OpenAI API 키 (없으면 `process.env.OPENAI_API_KEY`). */
  openaiApiKey?: string;
  /** Anthropic API 키 (없으면 `process.env.ANTHROPIC_API_KEY`). */
  anthropicApiKey?: string;
  /** 임베딩 모델명 override (선택). */
  embeddingModel?: string;
}

/** 경고 로그 (Secret/키/원문 미포함). */
function warn(message: string): void {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[@family/ai-providers] ${message}`);
  }
}

/** 안전하게 환경변수를 읽는다 (브라우저/워커 등 process 부재 환경 보호). */
function readEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key];
  }
  return undefined;
}

/** 결정적 Mock provider 묶음. */
function createMockProviders(): ProviderSet {
  return {
    llm: new MockLlmProvider(),
    embedding: new MockEmbeddingProvider(),
    reranker: new MockRerankerProvider(),
  };
}

/**
 * 설정값으로부터 LLM/Embedding/Reranker provider 묶음을 생성한다.
 *
 * - `mock`(기본): 결정적 Mock 묶음. Phase 7 검증은 이 경로로 수행된다.
 * - `openai`: API 키가 있으면 임베딩만 OpenAI 스켈레톤으로 배선(검증 미사용, llm/reranker는 Mock),
 *   키가 없으면 경고 후 Mock 폴백.
 * - `anthropic` / `google`: 미구현. 경고 후 Mock 폴백.
 *
 * 어떤 경우에도 예외로 파이프라인을 중단시키지 않고 Mock으로 폴백한다.
 */
export function createProviders(cfg?: CreateProvidersConfig): ProviderSet {
  const provider = cfg?.provider ?? 'mock';

  switch (provider) {
    case 'openai': {
      const apiKey = cfg?.openaiApiKey ?? readEnv('OPENAI_API_KEY');
      if (!apiKey) {
        warn("provider 'openai' has no API key; falling back to mock providers");
        return createMockProviders();
      }
      // 스켈레톤: 임베딩만 OpenAI, llm/reranker는 아직 Mock. Phase 7 검증은 mock.
      warn("provider 'openai' embedding skeleton is unverified; llm/reranker use mock");
      return {
        llm: new MockLlmProvider(),
        embedding: new OpenAiEmbeddingProvider({
          apiKey,
          ...(cfg?.embeddingModel !== undefined ? { model: cfg.embeddingModel } : {}),
        }),
        reranker: new MockRerankerProvider(),
      };
    }
    case 'anthropic': {
      const apiKey = cfg?.anthropicApiKey ?? readEnv('ANTHROPIC_API_KEY');
      if (!apiKey) {
        warn("provider 'anthropic' has no API key; falling back to mock providers");
      } else {
        warn("provider 'anthropic' is not implemented; falling back to mock providers");
      }
      return createMockProviders();
    }
    case 'google':
      warn("provider 'google' is not implemented; falling back to mock providers");
      return createMockProviders();
    case 'mock':
    default:
      return createMockProviders();
  }
}
