import { z } from 'zod';

/**
 * 정기 지출 Radar 계약 (C-5 최소 제품).
 *
 * 이번 범위는 **후보 표시와 사용자 확정까지**다(로드맵 5-1절). 다음 결제 예상일 ·
 * 월 정기 지출 총액 · 알림 · 해지/카드교체 CTA는 계약에도 넣지 않는다 — 필드를 먼저
 * 만들어 두면 "곧 채워질 것"으로 읽혀 ADR-0027 enforce 전에 켜질 압력이 생긴다.
 *
 * ⚠️ 모든 금액은 `provisional`이다. 금액 계약(ADR-0027)이 enforce 전이라
 * `card_transactions.net_amount`가 아직 확정이 아니고, 이 후보는 그 위에 서 있다.
 */

export const recurringSeriesStatusSchema = z.enum([
  'candidate',
  'confirmed',
  'rejected',
  'needs_review',
]);
export type RecurringSeriesStatus = z.infer<typeof recurringSeriesStatusSchema>;

export const recurringCadenceSchema = z.enum(['weekly', 'monthly']);
export type RecurringCadenceValue = z.infer<typeof recurringCadenceSchema>;

/** `needs_review`가 된 이유. 사용자에게 "무엇을 다시 보라는 것인지" 말하기 위해 있다. */
export const recurringNeedsReviewReasonSchema = z.enum([
  /** 근거 거래가 전부 사라졌다(제외·삭제·재분류). */
  'evidence_lost',
  /** 둘 이상의 확정 series가 한 후보로 합쳐졌다(보통 별칭 등록 뒤). */
  'merged',
  /** 하나의 series가 여러 후보로 갈라졌다(보통 별칭 해제 뒤). */
  'split',
]);
export type RecurringNeedsReviewReason = z.infer<
  typeof recurringNeedsReviewReasonSchema
>;

export const recurringSeriesItemSchema = z.object({
  /** 안정적인 신원. 별칭·금액이 바뀌어도 유지된다. */
  id: z.string(),
  /**
   * 표시용 가맹점명. 타인의 `summary_only` 근거가 섞이면 `(비공개)`로 가려진다 —
   * 금액은 보이되 이름은 새지 않는다(PRD §8/§16).
   */
  merchant: z.string(),
  /** 대표 금액(중앙값, minor units). */
  amount: z.number().int(),
  /** 관측된 금액 범위. 변동형 구독이면 min ≠ max다. */
  amountMin: z.number().int(),
  amountMax: z.number().int(),
  currency: z.string(),
  cadence: recurringCadenceSchema,
  /** 관측된 간격 중앙값(일). */
  intervalDays: z.number().int(),
  occurrenceCount: z.number().int(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  status: recurringSeriesStatusSchema,
  needsReviewReason: recurringNeedsReviewReasonSchema.nullable(),
  /** 내 거래로 만들어진 series인지. 화면이 "내 것"과 "가족 것"을 가른다. */
  mine: z.boolean(),
  /**
   * 이 series가 기대는 금액 계약 버전(근거들의 최솟값). `1`이면 ADR-0027 enforce
   * 전 데이터 위에 서 있다는 뜻이므로 화면이 그 사실을 숨기지 않아야 한다.
   */
  moneyContractVersion: z.number().int(),
  /**
   * 다음 결제 예상 시점(ISO). **`confirmed`인 series에만** 붙는다 — 아직 정기인지
   * 확정되지 않은 후보에 예상일을 말하면 그 자체가 확정처럼 읽힌다.
   *
   * ⛔ 금액 예고는 여기 없다. ADR-0027 enforce 전까지 `net_amount`가 확정이 아니므로
   * 날짜만 말한다(`docs/concept-upcoming-spend-2026-08.md` D2).
   */
  nextExpectedAt: z.string().nullable(),
  /** 예상일의 불확실 폭(일). "8월 24일쯤(±2일)"의 그 폭. */
  nextExpectedWindowDays: z.number().int().nullable(),
  /** 지금 어느 국면인가 — 창 이전/창 안/창을 넘김. */
  nextExpectedPhase: z.enum(['upcoming', 'due', 'overdue']).nullable(),
  /** `overdue`일 때 창을 넘긴 일수. */
  overdueDays: z.number().int(),
  /** 유예까지 넘겨 "해지하셨나요?"를 물어야 하는 상태. */
  stoppedCandidate: z.boolean(),
  /** 최근 반복 거절이 붙어 있으면 그 사유 코드. 없으면 null. */
  recentDeclineReason: z.string().nullable(),
  /** 최근 반복 거절 시도 횟수(0이면 없음). */
  recentDeclineAttempts: z.number().int(),
});
export type RecurringSeriesItem = z.infer<typeof recurringSeriesItemSchema>;

/** `GET /v1/recurring/series?householdId=...` */
export const recurringSeriesListResponseSchema = z.object({
  /**
   * 사용자 노출 flag(`RECURRING_RADAR_ENABLED`) 상태. false면 `items`는 항상 비어
   * 있고 화면은 "아직 켜지 않았다"를 정직하게 말해야 한다 — 빈 목록을
   * "정기 결제가 없다"로 읽히게 두면 없는 사실을 만든다.
   */
  enabled: z.boolean(),
  /**
   * 이 결과가 미확정 금액 계약 위에 서 있음을 뜻한다. ADR-0027 enforce + 과거 수리
   * 뒤 전량 재계산해야 false가 된다. **true인 동안 홈 집계·알림에 쓰지 마라.**
   */
  provisional: z.boolean(),
  items: z.array(recurringSeriesItemSchema),
  /** 마지막 재계산 시각. 한 번도 계산하지 않았으면 null. */
  computedAt: z.string().nullable(),
});
export type RecurringSeriesListResponse = z.infer<
  typeof recurringSeriesListResponseSchema
>;

/**
 * `POST /v1/recurring/series/:id/decision` — "정기 결제 맞음 / 아님".
 *
 * `needs_review`·`candidate`는 사용자가 직접 고를 수 없다. 전자는 시스템이 남긴
 * 재검토 표시이고 후자는 엔진의 초기값이라, 사용자가 그 값으로 되돌리는 동작은
 * 의미가 없다(되돌리려면 반대쪽을 다시 고르면 된다).
 */
export const recurringDecisionRequestSchema = z.object({
  decision: z.enum(['confirmed', 'rejected']),
});
export type RecurringDecisionRequest = z.infer<
  typeof recurringDecisionRequestSchema
>;

export const recurringDecisionResponseSchema = z.object({
  id: z.string(),
  status: recurringSeriesStatusSchema,
});
export type RecurringDecisionResponse = z.infer<
  typeof recurringDecisionResponseSchema
>;

/** `POST /v1/recurring/recompute` — 후보 전량 재계산(사용자 확정은 보존). */
export const recurringRecomputeRequestSchema = z.object({
  householdId: z.string().uuid(),
});
export type RecurringRecomputeRequest = z.infer<
  typeof recurringRecomputeRequestSchema
>;

export const recurringRecomputeResponseSchema = z.object({
  /** 새로 만들어진 미확정 후보 수. */
  created: z.number().int(),
  /** 기존 결정에 근거를 이어 붙인 수. */
  updated: z.number().int(),
  /** 재검토가 필요해진 수(근거 소실·병합·분할). */
  needsReview: z.number().int(),
  computedAt: z.string(),
});
export type RecurringRecomputeResponse = z.infer<
  typeof recurringRecomputeResponseSchema
>;
