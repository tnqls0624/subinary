/**
 * @family/ai-providers — 모델 비종속 AI 경계 타입 (PRD 3.4 / Phase 0 Build Spec §6.4).
 *
 * Phase 0에서는 인터페이스와 Mock 구현만 배치한다(경계 확보 목적).
 * 실제 LLM/Embedding/Reranker API 호출은 Phase 2+에서 구현체를 추가한다.
 */

/** LLM 텍스트 생성 요청. */
export interface GenerateRequest {
  /** 사용자 프롬프트. */
  prompt: string;
  /** 시스템 프롬프트 (선택). */
  system?: string;
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
  embed(texts: string[]): Promise<number[][]>;
}

/** 재순위화 provider 인터페이스 (PRD 3.4). */
export interface RerankerProvider {
  rerank(req: RerankRequest): Promise<RerankResponse>;
}
