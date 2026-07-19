/**
 * Provider 팩토리 (Phase 0 Build Spec §6.4 / Phase 7 Build Spec §4).
 */
import { GeminiLlmProvider } from './gemini.js';
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
  /** 'mock'(기본) | 'gemini'('google' 별칭) | 'openai' | 'anthropic'. */
  provider?: string;
  /** OpenAI API 키 (없으면 `process.env.OPENAI_API_KEY`). */
  openaiApiKey?: string;
  /** Anthropic API 키 (없으면 `process.env.ANTHROPIC_API_KEY`). */
  anthropicApiKey?: string;
  /** Gemini API 키 (없으면 `process.env.GEMINI_API_KEY`). */
  geminiApiKey?: string;
  /** LLM 모델명 override (선택, 예: 'gemini-2.0-flash'). */
  llmModel?: string;
  /** 임베딩 모델명 override (선택). */
  embeddingModel?: string;
  /**
   * 프로덕션 안전 모드. true면 Mock 직접 선택, credential 누락, 미구현/부분 구현
   * provider를 조용히 Mock으로 대체하지 않고 시작 단계에서 실패한다.
   */
  strict?: boolean;
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

/** strict 모드에서는 폴백 대신 안전한 구성 오류로 중단한다. */
function fallbackOrThrow(
  cfg: CreateProvidersConfig | undefined,
  message: string,
): ProviderSet {
  if (cfg?.strict === true) {
    throw new Error(`[@family/ai-providers] strict mode: ${message}`);
  }
  warn(`${message}; falling back to mock providers`);
  return createMockProviders();
}

/**
 * 설정값으로부터 LLM/Embedding/Reranker provider 묶음을 생성한다.
 *
 * - `mock`(기본): 결정적 Mock 묶음. Phase 7 검증은 이 경로로 수행된다.
 * - `gemini`(별칭 `google`): 키가 있으면 LLM만 Gemini(generateContent), 임베딩/리랭커는
 *   Mock 유지(vector(256) 스키마 계약). 키가 없으면 경고 후 Mock 폴백.
 * - `openai`: API 키가 있으면 임베딩만 OpenAI 스켈레톤으로 배선(검증 미사용, llm/reranker는 Mock),
 *   키가 없으면 경고 후 Mock 폴백.
 * - `anthropic`: 미구현. 경고 후 Mock 폴백.
 *
 * 기본(non-strict)에서는 기존처럼 Mock으로 폴백한다. `strict=true`에서는 Mock
 * 직접 선택, credential 누락, 미구현/부분 구현 provider를 구성 오류로 처리해
 * 프로덕션이 조용히 가짜 결과를 제공하지 않게 한다(ADR-0017 P0).
 */
export function createProviders(cfg?: CreateProvidersConfig): ProviderSet {
  const provider = cfg?.provider ?? 'mock';

  switch (provider) {
    case 'openai': {
      const apiKey = cfg?.openaiApiKey ?? readEnv('OPENAI_API_KEY');
      if (!apiKey) {
        return fallbackOrThrow(cfg, "provider 'openai' has no API key");
      }
      if (cfg?.strict === true) {
        throw new Error(
          "[@family/ai-providers] strict mode: provider 'openai' is partial " +
            '(embedding only; llm/reranker are mock)',
        );
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
        return fallbackOrThrow(cfg, "provider 'anthropic' has no API key");
      }
      return fallbackOrThrow(cfg, "provider 'anthropic' is not implemented");
    }
    case 'gemini':
    case 'google': {
      const apiKey = cfg?.geminiApiKey ?? readEnv('GEMINI_API_KEY');
      if (!apiKey) {
        return fallbackOrThrow(cfg, "provider 'gemini' has no API key");
      }
      // LLM만 Gemini로 배선한다. 임베딩은 Phase 7 스키마가 vector(256)로 고정돼
      // 있어(재임베딩 필요) Mock을 유지한다 — 분류/질의/인사이트는 LLM만 사용.
      return {
        llm: new GeminiLlmProvider({
          apiKey,
          ...(cfg?.llmModel !== undefined ? { model: cfg.llmModel } : {}),
        }),
        embedding: new MockEmbeddingProvider(),
        reranker: new MockRerankerProvider(),
      };
    }
    case 'mock': {
      if (cfg?.strict === true) {
        throw new Error(
          "[@family/ai-providers] strict mode: provider 'mock' is not allowed",
        );
      }
      return createMockProviders();
    }
    default:
      return fallbackOrThrow(cfg, `provider '${provider}' is unknown`);
  }
}
