# ADR-0004: 모델 비종속 AI Provider 인터페이스 채택

## 제목

LLM/Embedding/Reranker를 모델 비종속 인터페이스(`@family/ai-providers`) 뒤에 배치

## 상태

승인됨 (Accepted) — 2026-07-15

## 배경

AI 모델 시장은 가격·성능·컨텍스트 길이가 빠르게 변해 특정 벤더 고착(lock-in)의 비용이
크다. Family Memory AI는 가족의 개인 기록을 다루므로, 향후 로컬 모델(self-hosted)로의
전환 가능성도 열어 두어야 한다. 한편 Phase 0의 원칙은 "계산은 SQL/앱 로직, LLM 호출 없음"
이므로, 지금 필요한 것은 실구현이 아니라 **경계(인터페이스)의 확보**다. 경계 없이 나중에
벤더 SDK 호출이 도메인 코드에 스며들면 교체 비용이 기하급수적으로 커진다.

## 결정

- 순수 TypeScript 패키지 **`@family/ai-providers`**(외부 의존성 없음)에 PRD 3.4의
  인터페이스를 정의한다:
  ```ts
  interface LlmProvider { generate(req: GenerateRequest): Promise<GenerateResponse>; }
  interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]>; }
  interface RerankerProvider { rerank(req: RerankRequest): Promise<RerankResponse>; }
  ```
- Phase 0에는 **Mock 구현만** 배치한다: `MockLlmProvider`(고정 문자열 + echo),
  `MockEmbeddingProvider`(결정적 의사 벡터, 고정 차원 8), `MockRerankerProvider`(입력 순서 유지).
- `createProviders(cfg)` 팩토리가 유일한 생성 지점이다. Phase 0에서는 provider 값과 무관하게
  Mock을 반환하되, `openai`/`anthropic`/`google` 확장 지점을 주석으로 명시한다.
- 선택은 환경변수 `AI_PROVIDER`(기본 `mock`)로 하고, `@family/config`의 zod 스키마
  (`ai.provider: 'mock'|'openai'|'anthropic'|'google'`)로 검증한다.
- api는 `AiModule`의 `AI_PROVIDERS` 주입 토큰으로만 접근한다(엔드포인트 없음, 경계만).
- 프롬프트/응답 원문은 개인 기록을 포함할 수 있으므로 로그에 남기지 않는다
  (shared logger의 redact 규칙과 동일 원칙).

## 검토한 대안

1. **벤더 SDK 직접 사용(OpenAI/Anthropic SDK를 도메인 코드에서 호출)**: 초기 개발은 빠르나
   벤더 교체·멀티 모델 라우팅·테스트 격리가 어려워진다.
2. **LangChain 등 프레임워크 추상화**: 기능은 풍부하나 추상화가 무겁고 버전 변동이 잦아
   Phase 0의 "경계만 확보" 목적에 과하다.
3. **LiteLLM 류 프록시 서버**: 언어 중립적이지만 인프라 컴포넌트가 하나 늘고,
   타입 안전한 계약(TS 인터페이스)을 제공하지 못한다.
4. **추상화 없이 Phase 이후로 연기**: 도입 시점에 도메인 코드 전반의 리팩터링 비용 발생.

## 장점

- 벤더/모델 교체가 팩토리 한 지점의 변경으로 수렴. 로컬 모델 전환 경로 확보.
- Mock 덕분에 Phase 0~1 테스트가 네트워크·비용·비결정성 없이 결정적으로 수행됨.
- 의존성 0의 순수 TS 패키지라 어느 앱(api/worker/mcp)에서도 부담 없이 재사용 가능.
- 요청/응답 타입(`GenerateRequest` 등)이 계약으로 고정되어 도메인 코드가 벤더 스키마에
  오염되지 않음.

## 단점

- 벤더 고유 기능(툴 호출 세부, 스트리밍 모드, 캐싱 옵션)이 공통 인터페이스에 눌려
  최소공배수로 제한될 수 있다.
- 인터페이스·타입을 유지보수하는 간접 계층 비용이 존재한다.
- Mock과 실모델의 동작 차이(토큰 한계, 지연, 실패 모드)는 통합 테스트로 별도 검증 필요.

## 변경조건

- 실제 Provider 도입 Phase에서 스트리밍/툴 호출/토큰 사용량 리포팅이 필요해지면
  인터페이스 확장(하위 호환 유지)을 검토한다.
- 특정 벤더 고유 기능이 제품 핵심이 되면 공통 인터페이스 + 벤더 확장 옵션의
  이중 구조를 검토한다.
- 임베딩 차원·거리 함수가 확정되는 RAG Phase에서 `EmbeddingProvider` 계약에
  차원 메타데이터 노출을 추가할지 재평가한다.
