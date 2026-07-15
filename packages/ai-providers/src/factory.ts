/**
 * Provider 팩토리 (Phase 0 Build Spec §6.4).
 */
import { MockEmbeddingProvider, MockLlmProvider, MockRerankerProvider } from './mocks.js';
import type { EmbeddingProvider, LlmProvider, RerankerProvider } from './types.js';

/** `createProviders`가 반환하는 provider 묶음. */
export interface ProviderSet {
  llm: LlmProvider;
  embedding: EmbeddingProvider;
  reranker: RerankerProvider;
}

/**
 * 설정값으로부터 LLM/Embedding/Reranker provider 묶음을 생성한다.
 *
 * Phase 0에서는 `cfg.provider` 값과 무관하게 항상 Mock 구현을 반환한다.
 *
 * [확장 지점] Phase 2+에서 실제 provider를 연결할 때 아래 switch에 케이스를 추가한다:
 *   case 'openai':    // OpenAI 기반 LlmProvider/EmbeddingProvider/RerankerProvider
 *   case 'anthropic': // Anthropic 기반 구현
 *   case 'google':    // Google 기반 구현
 * 각 구현체는 이 패키지의 인터페이스만 구현하면 되므로 호출부(api/worker)는 변경되지 않는다.
 */
export function createProviders(cfg: { provider: string }): ProviderSet {
  const provider = cfg?.provider ?? 'mock';

  switch (provider) {
    case 'mock':
    default:
      return {
        llm: new MockLlmProvider(),
        embedding: new MockEmbeddingProvider(),
        reranker: new MockRerankerProvider(),
      };
  }
}
