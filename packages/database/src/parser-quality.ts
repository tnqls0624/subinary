/**
 * 카드 문자 파서 품질 지표 집계(ADR-0023 §관측).
 *
 * ADR이 이름까지 정해 둔 네 지표(`llm_span_reject_rate`, `human_correction_rate`,
 * `template_cache_hit_rate`, 검토 대기 적체)를 **기존 관측 자산만으로** 계산한다.
 * 새 테이블·새 관측 체계를 만들지 않는다:
 *
 * - 캐스케이드 레이어 카운터 → `pipeline_step_runs.metrics`(워커가 파싱 1건마다 기록)
 * - 사람 교정 → `feedback_events`(`source='human_confirmed'`, ADR-0017)
 * - 검토 적체 → `card_sms_events.parse_status`
 *
 * ## 왜 비율을 저장하지 않는가
 *
 * 비율은 **창(window)에 종속**이다. 저장해 두면 창을 바꿀 수 없고, 한 건 단위로는
 * 0/1뿐이라 의미가 없다. 원자료(정수 카운터)만 남기고 비율은 읽을 때 만든다.
 *
 * ## 왜 표본 0이면 `null`인가
 *
 * 0/0을 0으로 보고하면 "거절률 0% — 완벽"으로 읽힌다. 실제로는 "LLM을 한 번도 안
 * 불렀다"는 뜻이고(현재 `CARD_SMS_LLM_MODE=off`), 그 둘을 같은 값으로 내보내면 이
 * 지표의 목적(문구 개편 조기 감지)이 무너진다.
 */
import { and, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';

import type { Db } from './client.js';
import { cardSmsEvents, feedbackEvents, pipelineRuns, pipelineStepRuns } from './schema.js';

/** 워커가 `pipeline_runs`에 쓰는 파싱 파이프라인 이름/스텝(프로세서와 반드시 일치). */
export const CARD_SMS_PARSE_PIPELINE = 'card-sms-parse';
export const CARD_SMS_PARSE_STEP = 'parse-and-promote';

/** `feedback_events`에서 카드 문자 사람 교정을 식별하는 값(리뷰 서비스와 일치). */
export const CARD_SMS_FEEDBACK_TARGET_TYPE = 'card-sms-parse';

/**
 * 사람이 처리해야 남아 있는 상태. `pending_review`는 제외한다 — 이미 거래로 승격돼
 * 집계에 잡히므로 "적체"가 아니다. 여기 두 상태만이 거래를 만들지 못한 채 멈춘 것이다.
 */
export const CARD_SMS_REVIEW_BACKLOG_STATUSES = ['quarantined', 'parse_failed'] as const;

/** 비율 계산에 쓰는 원자료. 전부 정수 카운트다. */
export interface CardSmsParserQualityCounts {
  /** L2(LLM span 추출)를 호출한 파싱 건수. shadow 호출도 포함. */
  llmAttempted: number;
  /** 그중 유효 span을 못 낸 건수. */
  llmSpanRejected: number;
  /** L1(템플릿 레시피) 조회를 시도한 건수(= L0가 못 읽은 건수). */
  recipeAttempted: number;
  /** 그중 레시피로 파싱에 성공한 건수. */
  recipeHit: number;
  /** 창 안에서 파싱이 확정된 이벤트 수(사람 교정 비율의 분모). */
  parsedEvents: number;
  /** 창 안에서 사람이 확정/교정한 건수. */
  humanCorrections: number;
}

/** ADR-0023이 정의한 지표. 이름을 바꾸면 ADR이 거짓말이 된다. */
export interface CardSmsParserQuality {
  /** 집계 창의 시작(ISO 8601). */
  windowStart: string;
  /** `llm_span_reject_rate` — 표본 0이면 null. */
  llmSpanRejectRate: number | null;
  /** `human_correction_rate` — 표본 0이면 null. */
  humanCorrectionRate: number | null;
  /** `template_cache_hit_rate` — 표본 0이면 null. */
  templateCacheHitRate: number | null;
  /** 검토 대기 적체 건수(창과 무관한 현재 수위). */
  reviewBacklogCount: number;
  counts: CardSmsParserQualityCounts;
}

/** 소수 4자리로 끊는다(0.0001 = 만 건에 1건 — 이 규모에서 그 이상은 잡음이다). */
function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * 원자료 → 지표. DB 없이 검증할 수 있게 순수 함수로 분리한다(0 분모 처리가 이
 * 지표의 유일한 함정이다).
 */
export function computeCardSmsParserQuality(
  counts: CardSmsParserQualityCounts,
  reviewBacklogCount: number,
  windowStart: Date,
): CardSmsParserQuality {
  return {
    windowStart: windowStart.toISOString(),
    llmSpanRejectRate: rate(counts.llmSpanRejected, counts.llmAttempted),
    humanCorrectionRate: rate(counts.humanCorrections, counts.parsedEvents),
    templateCacheHitRate: rate(counts.recipeHit, counts.recipeAttempted),
    reviewBacklogCount,
    counts,
  };
}

/**
 * `metrics->>'key'`를 정수로 합산한다.
 *
 * 지표 도입 전 실행 행에는 이 키가 없다 — `->>`가 NULL을 주고 `sum`이 건너뛰므로
 * 소급 백필 없이도 집계가 성립한다(추세 감지가 목적이라 과거 구간은 빠져도 된다).
 * 워커가 이 값을 **0/1 정수로** 저장하는 것이 전제다 — boolean이면 `::int` 캐스팅이
 * 실패한다(`apps/worker/src/card-sms/parse-quality.ts`).
 */
function metricSum(key: keyof CardSmsParserQualityCounts): SQL<number> {
  return sql<number>`coalesce(sum((${pipelineStepRuns.metrics} ->> ${key})::int), 0)::int`;
}

/**
 * 최근 `windowDays`일 파서 품질 지표를 읽는다(읽기 전용, 원문 없음).
 *
 * 기본 창을 14일로 두는 이유: 카드사 문구 개편은 한 번에 전 카드사가 바뀌지 않고
 * 유입량도 하루 수 건 규모라, 7일보다 짧으면 표본이 모자라 비율이 튄다.
 */
export async function readCardSmsParserQuality(
  db: Db,
  options: { windowDays?: number } = {},
): Promise<CardSmsParserQuality> {
  const windowDays = options.windowDays ?? 14;
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [cascade] = await db
    .select({
      llmAttempted: metricSum('llmAttempted'),
      llmSpanRejected: metricSum('llmSpanRejected'),
      recipeAttempted: metricSum('recipeAttempted'),
      recipeHit: metricSum('recipeHit'),
    })
    .from(pipelineStepRuns)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, pipelineStepRuns.pipelineRunId))
    .where(
      and(
        eq(pipelineRuns.pipelineName, CARD_SMS_PARSE_PIPELINE),
        eq(pipelineStepRuns.stepName, CARD_SMS_PARSE_STEP),
        gte(pipelineStepRuns.startedAt, windowStart),
      ),
    );

  const [parsed] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(cardSmsEvents)
    .where(gte(cardSmsEvents.parsedAt, windowStart));

  const [corrections] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(feedbackEvents)
    .where(
      and(
        eq(feedbackEvents.targetType, CARD_SMS_FEEDBACK_TARGET_TYPE),
        eq(feedbackEvents.source, 'human_confirmed'),
        gte(feedbackEvents.occurredAt, windowStart),
      ),
    );

  const [backlog] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(cardSmsEvents)
    .where(inArray(cardSmsEvents.parseStatus, [...CARD_SMS_REVIEW_BACKLOG_STATUSES]));

  return computeCardSmsParserQuality(
    {
      llmAttempted: cascade?.llmAttempted ?? 0,
      llmSpanRejected: cascade?.llmSpanRejected ?? 0,
      recipeAttempted: cascade?.recipeAttempted ?? 0,
      recipeHit: cascade?.recipeHit ?? 0,
      parsedEvents: parsed?.total ?? 0,
      humanCorrections: corrections?.total ?? 0,
    },
    backlog?.total ?? 0,
    windowStart,
  );
}
