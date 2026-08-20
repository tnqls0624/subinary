import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* 카테고리 소급 재분류                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 규칙은 **미래 거래에만** 적용된다(`transaction.service.ts`가 `never retroactive`로
 * 못 박아 둔 의도적 안전장치다 — 규칙 하나가 과거 수백 건을 조용히 재분류하면 지난달
 * 통계가 사용자 모르게 바뀐다). 그 안전장치를 없애는 대신, **사용자가 보고 결정하는**
 * 경로를 연다. 이 계약이 그 경로다.
 */

/** 소급 적용이 건드릴 한 달의 요약. */
export const recategorizeMonthSchema = z.object({
  /** 서울 기준 `YYYY-MM`. */
  month: z.string(),
  count: z.number().int(),
  /** 이 달에서 옮겨질 금액 합계(KRW). */
  amount: z.number().int(),
  /**
   * 이 달에 영향받는 예산이 있는가. `category` 스코프가 기본이고, 자산이동 여부가
   * 바뀌는 경우에는 모든 스코프가 영향을 받는다.
   */
  budgetAffected: z.boolean(),
  /**
   * 이 달에 예산 행 자체가 없으면 `false`가 아니라 `null`이다 — "영향 없음"과
   * "애초에 예산을 안 세운 달"을 같은 값으로 내보내면 사용자가 잘못 안심한다.
   */
  budgetKnown: z.boolean(),
});
export type RecategorizeMonth = z.infer<typeof recategorizeMonthSchema>;

/** `GET /v1/transactions/recategorize/preview` — 무엇이 바뀌는지 미리 본다. */
export const recategorizePreviewSchema = z.object({
  /** 정규화·별칭까지 적용한 대표 가맹점명. */
  merchantCanonical: z.string(),
  /** 바꿀 카테고리. */
  toCategoryId: z.string(),
  toCategoryName: z.string(),
  /** 대상 건수. **이 숫자가 곧 적용 건수다**(같은 조건식을 공유한다). */
  count: z.number().int(),
  /** 대상 금액 합계(KRW). */
  amount: z.number().int(),
  /** 가장 오래된/최근 거래일(ISO). 대상이 없으면 null. */
  oldestAt: z.string().nullable(),
  newestAt: z.string().nullable(),
  /** 영향 받는 달(최신순). */
  months: z.array(recategorizeMonthSchema),
  /** 대상들이 지금 갖고 있는 카테고리 이름들 — 단일 값이 아니라 집합이다. */
  fromCategoryNames: z.array(z.string()),
  /**
   * 자산이동(`is_transfer`) 여부가 바뀌는가.
   *
   * ⚠️ 이게 `true`면 **총지출이 실제로 변한다.** 자산이동은 지출 합계에서 빠지므로,
   * 일반 카테고리 ↔ 자산이동 사이를 옮기면 "카테고리만 바꾸니 총액은 그대로"라는
   * 전제가 깨진다. 화면은 이 경우를 다른 문장으로 경고해야 한다.
   */
  transferBoundaryCrossed: z.boolean(),
  /** 상한을 넘어 적용을 거부해야 하는가. */
  exceedsLimit: z.boolean(),
  limit: z.number().int(),
});
export type RecategorizePreview = z.infer<typeof recategorizePreviewSchema>;

/** `POST /v1/transactions/recategorize` */
export const recategorizeRequestSchema = z.object({
  householdId: z.string().uuid(),
  /** 미리보기에서 본 것과 같은 가맹점 문자열. */
  merchant: z.string().min(1),
  categoryId: z.string().uuid(),
  /**
   * 미리보기에서 사용자가 동의한 건수. 서버가 다시 세어 다르면 **거부한다** —
   * 그 사이 새 거래가 들어왔거나 다른 기기에서 분류가 바뀐 것이고, 사용자가 동의한
   * 숫자와 실제로 바뀌는 숫자가 다른 채로 진행하면 되돌리기 이전에 신뢰가 깨진다.
   */
  expectedCount: z.number().int().nonnegative(),
});
export type RecategorizeRequest = z.infer<typeof recategorizeRequestSchema>;

export const recategorizeResponseSchema = z.object({
  batchId: z.string(),
  appliedCount: z.number().int(),
});
export type RecategorizeResponse = z.infer<typeof recategorizeResponseSchema>;

/** 적용 이력 한 건. */
export const recategorizeBatchSchema = z.object({
  id: z.string(),
  merchantCanonical: z.string(),
  toCategoryName: z.string().nullable(),
  appliedCount: z.number().int(),
  appliedAt: z.string(),
  /** 되돌렸으면 그 시각. */
  revertedAt: z.string().nullable(),
  /** 되돌린 건수. 아직 안 되돌렸으면 `null`(0건과 구분한다). */
  revertedCount: z.number().int().nullable(),
  /** 지금 되돌릴 수 있는가(이미 되돌렸으면 false). */
  revertable: z.boolean(),
});
export type RecategorizeBatch = z.infer<typeof recategorizeBatchSchema>;

export const recategorizeBatchListSchema = z.object({
  items: z.array(recategorizeBatchSchema),
});
export type RecategorizeBatchList = z.infer<typeof recategorizeBatchListSchema>;

export const recategorizeRevertResponseSchema = z.object({
  batchId: z.string(),
  revertedCount: z.number().int(),
  /**
   * 되돌리지 못하고 건너뛴 건수 — 적용 이후 사용자가 그 거래를 다시 분류한 경우다.
   * 최신 수정을 덮어쓰지 않는 것이 되돌리기의 규칙이므로, 건너뛴 사실을 숨기지 않는다.
   */
  skippedCount: z.number().int(),
});
export type RecategorizeRevertResponse = z.infer<typeof recategorizeRevertResponseSchema>;

/* -------------------------------------------------------------------------- */
/* 카테고리 규칙 목록                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 규칙 하나. **이 목록이 없던 동안** 사용자는 무엇이 자동으로 붙는지 볼 수 없었고,
 * 그래서 "왜 자꾸 이 카테고리지?" 하며 같은 거래를 세 번까지 다시 고쳤다(실측 15건).
 */
export const categoryRuleSchema = z.object({
  id: z.string(),
  /** 규칙이 걸린 가맹점 패턴(= canonical). */
  merchantPattern: z.string(),
  categoryId: z.string(),
  categoryName: z.string().nullable(),
  /** `human_confirmed`(내가 확정) / `model_prediction`(자동 학습). */
  source: z.enum(['human_confirmed', 'model_prediction']),
  /** 사람이 확정한 시각. 모델 예측이면 null. */
  confirmedAt: z.string().nullable(),
  updatedAt: z.string(),
  /**
   * 이 규칙과 **다른** 카테고리로 남아 있는 과거 거래 수. 0이면 소급할 것이 없다.
   * 이 숫자가 곧 "과거에도 적용" 버튼을 보여줄 근거다.
   */
  staleTransactionCount: z.number().int(),
});
export type CategoryRule = z.infer<typeof categoryRuleSchema>;

export const categoryRuleListSchema = z.object({
  items: z.array(categoryRuleSchema),
});
export type CategoryRuleList = z.infer<typeof categoryRuleListSchema>;
