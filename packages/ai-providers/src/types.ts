/**
 * @family/ai-providers — 모델 비종속 AI 경계 타입 (PRD 3.4 / Phase 0 Build Spec §6.4).
 *
 * Phase 0에서는 인터페이스와 Mock 구현만 배치한다(경계 확보 목적).
 * 실제 LLM/Embedding/Reranker API 호출은 Phase 2+에서 구현체를 추가한다.
 */

/**
 * LLM에 전달하는 컨텍스트 passage (RAG 근거 청크).
 *
 * `id`는 역추적용 청크 식별자, `text`는 발췌 원문이다.
 * 주의: 이 값은 로그로 출력하지 않는다 (원문/PII 로그 금지 정책).
 */
export interface GenerateContextPassage {
  /** 근거 청크 식별자. */
  id: string;
  /** 근거 청크 본문. */
  text: string;
}

/** LLM 텍스트 생성 요청. */
export interface GenerateRequest {
  /**
   * 사용자 프롬프트 (선택).
   * Phase 7 RAG 흐름은 `question` + `context`를 사용하지만,
   * 하위 호환을 위해 `prompt` 단독 호출도 허용한다.
   */
  prompt?: string;
  /** 시스템 프롬프트 (선택). */
  system?: string;
  /** 사용자 질문 (선택, RAG 흐름). */
  question?: string;
  /**
   * 근거 컨텍스트 passage 목록 (선택, RAG 흐름).
   * 값이 있으면 근거 기반 답변, 없으면 "근거 없음"을 생성한다(앱 로직 판정과 일치).
   */
  context?: GenerateContextPassage[];
  /** 생성 최대 토큰 수 (선택, 양의 정수). */
  maxTokens?: number;
  /** 샘플링 온도 (선택). */
  temperature?: number;
  /**
   * 호출부 식별/추적용 메타데이터 (선택).
   * 주의: 개인정보/Secret을 담지 않는다 (로그 금지 정책).
   */
  metadata?: Record<string, string>;
}

/** LLM 토큰 사용량 (Mock에서는 근사치). */
export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
}

/** LLM 텍스트 생성 응답. */
export interface GenerateResponse {
  /** 생성된 텍스트. */
  text: string;
  /** 응답을 생성한 모델 식별자. */
  model: string;
  /** 생성 종료 사유. */
  finishReason: 'stop' | 'length' | 'error';
  /** 토큰 사용량. */
  usage: GenerateUsage;
}

/**
 * 임베딩 요청.
 * `EmbeddingProvider.embed(texts: string[])` 호출 형태의 명시적 요청 표현이다.
 */
export interface EmbedRequest {
  /** 임베딩할 텍스트 목록. */
  texts: string[];
}

/** 재순위화(rerank) 대상 문서. */
export interface RerankDocument {
  /** 문서 식별자. */
  id: string;
  /** 문서 본문. */
  text: string;
}

/** 재순위화 요청. */
export interface RerankRequest {
  /** 검색 질의. */
  query: string;
  /** 재순위화 대상 문서 목록. */
  documents: RerankDocument[];
  /** 상위 N개만 반환 (선택, 양의 정수. 기본: 전체). */
  topK?: number;
}

/** 재순위화 결과 항목. */
export interface RerankResultItem {
  /** 원본 `documents` 배열에서의 인덱스. */
  index: number;
  /** 해당 문서. */
  document: RerankDocument;
  /** 관련도 점수 (0~1, 높을수록 관련). */
  score: number;
}

/** 재순위화 응답. */
export interface RerankResponse {
  /** 관련도 내림차순 결과 목록. */
  results: RerankResultItem[];
  /** 재순위화에 사용된 모델 식별자. */
  model: string;
}

/** LLM 텍스트 생성 provider 인터페이스 (PRD 3.4). */
export interface LlmProvider {
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

/** 임베딩 provider 인터페이스 (PRD 3.4). */
export interface EmbeddingProvider {
  /** 임베딩 벡터의 차원 수 (예: Mock=256). */
  readonly dimensions: number;
  /** 임베딩을 생성한 모델 식별자 (예: 'mock'). */
  readonly model: string;
  /** 텍스트 목록을 입력 순서대로 임베딩한다. */
  embed(texts: string[]): Promise<number[][]>;
}

/** 재순위화 provider 인터페이스 (PRD 3.4). */
export interface RerankerProvider {
  rerank(req: RerankRequest): Promise<RerankResponse>;
}
