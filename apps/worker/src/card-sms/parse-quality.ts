/**
 * 카드 문자 파싱 품질 관측(ADR-0023 §관측).
 *
 * ADR이 `llm_span_reject_rate` · `human_correction_rate` · `template_cache_hit_rate`를
 * 정의했지만 어디에도 저장되지 않아 계산할 원자료가 없었다. 이 파일은 **한 건의 파싱이
 * 남겨야 할 원자료**를 만든다 — 비율은 여기서 계산하지 않는다(한 건의 비율은 0 또는
 * 1뿐이라 의미가 없다). 집계는 `@family/database`의 `readCardSmsParserQuality`가 한다.
 *
 * ## 왜 이 지표인가
 *
 * 카드사가 문구를 개편하면 규칙 파서(L0)가 조용히 실패하기 시작하고, 그 결과는
 * **지출 누락**이다. 실패는 예외를 던지지 않으므로 로그·알림으로는 드러나지 않는다.
 * L1 미스율과 L2 거절율이 오르는 것이 유일한 조기 신호다.
 *
 * ## PII 금지
 *
 * 저장 대상은 **정수 카운터와 닫힌 열거값뿐**이다. 문자 원문·가맹점명·금액은 넣지
 * 않는다. `pipeline_step_runs.metrics`는 원문 없는 집계만 담는 자리다(ADR-0017).
 * 나중에 누가 필드를 추가하다 원문을 흘리지 않도록 테스트가 값의 형태를 검사한다.
 */

/** 파싱 결과를 확정한 레이어. `pipeline_step_runs.metrics`에 그대로 들어간다. */
export type ParseSource = 'rule' | 'recipe' | 'llm-span';

/**
 * 한 건의 파싱이 어느 레이어를 거쳤는지 누적하는 가변 probe.
 *
 * 프로세서 본문은 이 객체를 채우고, `trackPipelineExecution`의 `summarize`가 읽는다
 * (잡 결과 타입을 관측용으로 오염시키지 않기 위한 분리다).
 */
export interface ParseQualityProbe {
  /** L1 레시피 조회를 실제로 시도했는가(= L0가 못 읽었는가). */
  recipeAttempted: boolean;
  /** L1이 지문에 등록된 레시피로 파싱 가능한 결과를 만들었는가. */
  recipeHit: boolean;
  /** L2 LLM span 추출을 실제로 호출했는가(shadow 모드 호출도 포함). */
  llmAttempted: boolean;
  /**
   * L2가 유효 span을 못 냈는가(응답 없음 · JSON 아님 · span이 금액/유형을 못 채움).
   * shadow 모드는 결과를 적용하지 않지만 **거절 여부는 그대로 센다** — 관측이
   * 목적이므로 적용 여부와 무관하다.
   */
  llmSpanRejected: boolean;
  /** LLM이 낸 인용구 중 원문에서 확정에 실패한 개수. */
  llmRejectedSpans: number;
  /** 최종 결과를 확정한 레이어. */
  parseSource: ParseSource;
}

/** L0만 거친 상태의 초기 probe. */
export function createParseQualityProbe(): ParseQualityProbe {
  return {
    recipeAttempted: false,
    recipeHit: false,
    llmAttempted: false,
    llmSpanRejected: false,
    llmRejectedSpans: 0,
    parseSource: 'rule',
  };
}

/**
 * `pipeline_step_runs.metrics`에 저장할 payload.
 *
 * boolean이 아니라 **0/1 정수**로 저장한다: 집계가 `sum((metrics->>'k')::int)` 한 줄이
 * 되어 jsonb boolean 캐스팅 없이 비율이 나온다. 키 이름을 바꾸면 집계 쿼리도 함께
 * 바꿔야 하므로 상수로 묶어 둔다.
 */
/*
 * interface가 아니라 type인 이유: `pipeline_step_runs.metrics`가
 * `Record<string, unknown>`이고, TS는 **type alias에만** 암시적 인덱스 시그니처를
 * 준다. interface로 두면 대입이 막히고, 인덱스 시그니처를 직접 달면 아무 필드나
 * 넣을 수 있게 되어 PII 차단이 헐거워진다.
 */
export type ParseQualityMetrics = {
  parseStatus: string;
  parseSource: ParseSource;
  recipeAttempted: number;
  recipeHit: number;
  llmAttempted: number;
  llmSpanRejected: number;
  llmRejectedSpans: number;
};

export function parseQualityMetrics(
  probe: ParseQualityProbe,
  parseStatus: string,
): ParseQualityMetrics {
  return {
    parseStatus,
    parseSource: probe.parseSource,
    recipeAttempted: probe.recipeAttempted ? 1 : 0,
    recipeHit: probe.recipeHit ? 1 : 0,
    llmAttempted: probe.llmAttempted ? 1 : 0,
    llmSpanRejected: probe.llmSpanRejected ? 1 : 0,
    llmRejectedSpans: probe.llmRejectedSpans,
  };
}
