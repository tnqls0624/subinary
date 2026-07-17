/**
 * @family/ai-providers — 모델 비종속 AI provider 경계
 * (Phase 0 Build Spec §6.4 / Phase 7 Build Spec §4).
 *
 * 순수 TypeScript, 외부 런타임 의존성 없음.
 * 인터페이스 + 결정적 Mock 구현 + 팩토리 + (스켈레톤) OpenAI provider를 제공한다.
 */
export * from './types.js';
export * from './mocks.js';
export * from './factory.js';
export * from './openai.js';
export * from './gemini.js';
