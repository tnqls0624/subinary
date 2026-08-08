/**
 * shadow 비교 — "새 계약이라면 얼마였을까"를 기존 결과와 대조한다 (ADR-0027 롤아웃 3단계).
 *
 * **아무것도 바꾸지 않는다.** 롤아웃 3단계의 전환 조건이 `기존 정상 KRW 결과의 금액
 * delta 0건 / 설명되지 않은 외화 delta 0건`인데, 그 0을 **증명하려면 먼저 셀 수 있어야**
 * 한다. 이 파일이 세는 도구다.
 *
 * PII를 담지 않는다(ADR 롤아웃 3단계 명시). 가맹점명·원문·발신자는 들어오지 않고,
 * 거래 id·금액·통화·경로·분류만 남는다.
 */
import type { MoneyColumns, MoneyRejectionReason } from './plan.js';

/** 어느 쓰기 경로에서 관측했는지. 전환 진척을 경로별로 재기 위한 축이다. */
export type MoneyShadowPath =
  | 'worker_promotion_approval'
  | 'worker_promotion_cancellation'
  | 'api_manual_fields'
  | 'api_human_review'
  | 'api_transaction_update'
  | 'api_link_cancellation';

export type MoneyShadowVerdict =
  /** 일치 — 새 계약이 같은 금액·통화·연결을 만든다. */
  | 'match'
  /** KRW 금액 delta — 롤아웃 3단계 전환 조건이 **0건**을 요구하는 바로 그 항목. */
  | 'krw_amount_delta'
  /** 외화 delta — 설명(스냅샷 기준일 차이)이 붙어야만 통과한다. */
  | 'fx_amount_delta'
  /** 신규가 계산 실패 — 대부분 기준일 환율 스냅샷이 아직 없다는 뜻이다. */
  | 'plan_failed'
  /** 연결 대상 다름 — 취소가 붙을 승인이 갈렸다. */
  | 'link_target_differs';

/** 비교에 쓰는 실제 저장값(= 기존 경로의 결과). */
export interface MoneyShadowActual {
  readonly amount: number;
  readonly currency: string;
  readonly originalAmount: number | null;
  readonly originalCurrency: string | null;
  readonly cancelledAmount: number;
  readonly originalCancelledAmount: number | null;
  readonly netAmount: number;
  readonly parentTransactionId: string | null;
  readonly status: string;
  readonly moneyContractVersion: number;
}

export interface MoneyShadowRecord {
  readonly path: MoneyShadowPath;
  readonly verdict: MoneyShadowVerdict;
  readonly householdId: string;
  readonly transactionId: string;
  readonly sourceEventId: string | null;
  readonly transactionType: 'approval' | 'cancellation';
  /** 원통화가 KRW가 아니면 true. 외화 delta와 KRW delta를 가르는 축. */
  readonly foreign: boolean;
  readonly actual: MoneyShadowActual;
  /** 계획이 거부되면 null. */
  readonly planned: MoneyColumns | null;
  /** 계획이 거부된 사유. `verdict === 'plan_failed'`일 때만 있다. */
  readonly failureReason: MoneyRejectionReason | null;
  /**
   * `planned.netAmount - actual.netAmount`. 계획이 없으면 null —
   * **0이 아니다.** 0으로 두면 "delta 없음"과 "비교 못 함"이 한 값에 섞인다.
   */
  readonly netAmountDelta: number | null;
  /** 새 후보 규칙이 고른 부모. 자동 연결 대상이 갈렸는지 보는 값. */
  readonly plannedParentTransactionId: string | null;
}

export interface ClassifyMoneyShadowInput {
  readonly path: MoneyShadowPath;
  readonly householdId: string;
  readonly transactionId: string;
  readonly sourceEventId: string | null;
  readonly transactionType: 'approval' | 'cancellation';
  readonly actual: MoneyShadowActual;
  readonly planned: MoneyColumns | null;
  readonly failureReason: MoneyRejectionReason | null;
  /**
   * 새 후보 규칙이 고른 부모(취소 행에만 의미가 있다). `undefined`면 판정하지 않은
   * 것이고 `null`이면 "붙을 승인이 없다"는 판정이다 — 둘을 구분해야
   * `link_target_differs`를 잘못 세지 않는다.
   */
  readonly plannedParentTransactionId?: string | null;
}

/**
 * 판정 순서: 계산 실패 → 연결 대상 → 금액. 앞선 사유가 뒤를 가린다.
 *
 * 왜 이 순서인가: 계획을 못 세웠으면 금액을 비교할 대상 자체가 없고, 연결 대상이
 * 다르면 금액이 다른 것은 **결과**이지 독립된 사실이 아니다. 순서를 섞으면 같은 한
 * 건이 집계에서 두 번 설명된다.
 */
export function classifyMoneyShadow(input: ClassifyMoneyShadowInput): MoneyShadowRecord {
  const foreign =
    (input.actual.originalCurrency ?? input.actual.currency).toUpperCase() !== 'KRW';

  const base = {
    path: input.path,
    householdId: input.householdId,
    transactionId: input.transactionId,
    sourceEventId: input.sourceEventId,
    transactionType: input.transactionType,
    foreign,
    actual: input.actual,
    planned: input.planned,
    failureReason: input.failureReason,
    plannedParentTransactionId: input.plannedParentTransactionId ?? null,
  };

  if (!input.planned) {
    return { ...base, verdict: 'plan_failed', netAmountDelta: null };
  }

  const netAmountDelta = input.planned.netAmount - input.actual.netAmount;

  if (
    input.plannedParentTransactionId !== undefined &&
    input.plannedParentTransactionId !== input.actual.parentTransactionId
  ) {
    return { ...base, verdict: 'link_target_differs', netAmountDelta };
  }

  const same =
    input.planned.amount === input.actual.amount &&
    input.planned.netAmount === input.actual.netAmount &&
    input.planned.cancelledAmount === input.actual.cancelledAmount &&
    input.planned.currency === input.actual.currency.toUpperCase() &&
    (input.planned.originalAmount ?? null) === (input.actual.originalAmount ?? null) &&
    (input.planned.originalCurrency ?? null) ===
      (input.actual.originalCurrency?.toUpperCase() ?? null);

  if (same) return { ...base, verdict: 'match', netAmountDelta };
  return {
    ...base,
    verdict: foreign ? 'fx_amount_delta' : 'krw_amount_delta',
    netAmountDelta,
  };
}

/** shadow 집계 요약 — 전환 게이트가 읽는 숫자. */
export interface MoneyShadowSummary {
  readonly total: number;
  readonly byVerdict: Readonly<Record<MoneyShadowVerdict, number>>;
  /** KRW 행의 순액 delta 절대합. 전환 조건은 **0**이다. */
  readonly krwAbsoluteDelta: number;
}

export function summarizeMoneyShadow(
  records: readonly MoneyShadowRecord[],
): MoneyShadowSummary {
  const byVerdict: Record<MoneyShadowVerdict, number> = {
    match: 0,
    krw_amount_delta: 0,
    fx_amount_delta: 0,
    plan_failed: 0,
    link_target_differs: 0,
  };
  let krwAbsoluteDelta = 0;
  for (const record of records) {
    byVerdict[record.verdict] += 1;
    if (!record.foreign && record.netAmountDelta !== null) {
      krwAbsoluteDelta += Math.abs(record.netAmountDelta);
    }
  }
  return { total: records.length, byVerdict, krwAbsoluteDelta };
}
