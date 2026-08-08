/**
 * 금액 계획기 — **순수 함수**로 표현한 ADR-0027 금액 계약.
 *
 * `TransactionMoneyService`의 모든 명령(승인 생성 · 취소 생성/연결 · 재연결 ·
 * 금액 수정 · 연결 해제 · 체인 재계산)은 결국 **하나의 계산**으로 수렴한다:
 * "이 승인과 여기 연결된 취소들로 12개 보호 컬럼이 어떤 값이어야 하는가."
 * ADR §2가 "일부 행만 고치지 않고 체인 전체를 재계산한다"고 정한 그 계산이다.
 *
 * 이 파일에 DB가 없는 것이 핵심이다. 잠금·트랜잭션·멱등은 실행기의 일이고, **금액이
 * 얼마인가**는 여기서만 결정된다. 그래야 부분취소 누적·전액취소·외화 반올림 같은
 * 성질을 DB 없이 전수 검증할 수 있고, 나중에 수리 배치가 같은 함수를 재사용해도
 * "배치는 다르게 계산했다"는 상태가 생기지 않는다.
 *
 * shadow 단계(롤아웃 3)에서는 실행기를 부르지 않고 이 계획기만 돌려 기존 결과와
 * 대조한다. 즉 이 파일이 shadow가 측정하는 "새 계약"의 전부다.
 */
import {
  MONEY_CONTRACT_VERSION_V2,
  type MoneyProtectedColumn,
} from '@family/database';

import {
  convertToKrw,
  fxRateDisplayValue,
  MONEY_SETTLEMENT_CURRENCY,
  type MoneyConversionFailure,
} from './money-math.js';

/** `card_transactions.transaction_type` 중 금액 서비스가 다루는 두 종류. */
export type MoneyTransactionType = 'approval' | 'cancellation';

/** `card_transactions.status` (txnStatus enum). */
export type MoneyStatus =
  | 'approved'
  | 'partially_cancelled'
  | 'cancelled'
  | 'pending_review'
  | 'duplicate_suspected';

/**
 * 금액과 무관한 검토 플래그. 카드 뒤 4자리 모호(→`pending_review`)나 중복 의심
 * (→`duplicate_suspected`)은 금액에서 파생되지 않는데 같은 `status` 컬럼을 쓴다.
 *
 * ADR §1은 "금액에서 파생되는 status"만 서비스 소유로 정했으므로, 이 값은 호출자가
 * 넘기고 계획기는 **취소가 하나도 없을 때만** 존중한다. 취소가 붙는 순간 금액에서
 * 파생된 상태가 이긴다(기존 `linkCancellation`·승격 경로와 같은 동작이다).
 */
export type MoneyReviewFlag = 'pending_review' | 'duplicate_suspected';

/**
 * 이 서비스가 쓰는 12개 보호 컬럼의 확정값
 * (`MONEY_PROTECTED_COLUMNS`와 1:1).
 */
export interface MoneyColumns {
  readonly amount: number;
  readonly currency: string;
  readonly originalAmount: number | null;
  readonly originalCurrency: string | null;
  readonly exchangeRate: number | null;
  readonly fxRateSnapshotId: string | null;
  readonly cancelledAmount: number;
  readonly originalCancelledAmount: number | null;
  readonly netAmount: number;
  readonly parentTransactionId: string | null;
  readonly status: MoneyStatus;
  readonly moneyContractVersion: number;
}

/** 계획이 거부된 사유. ADR §2 "조건 위반이면 수정 전체 거부"의 사유 코드다. */
export type MoneyRejectionReason =
  /** 외화인데 기준일 환율 스냅샷이 없다 — 오늘 환율로 대체하지 않고 거부한다. */
  | 'fx_snapshot_missing'
  /** 승인과 취소의 원통화가 다르다. minor units 뺄셈이 무의미해진다. */
  | 'currency_mismatch'
  /** 원통화 취소 누계가 승인액을 넘는다. */
  | 'cancellation_exceeds_approval'
  /** 금액이 음수이거나 정수가 아니다. */
  | 'invalid_amount'
  /** 환산 실패(지원하지 않는 통화 · 환율 형식 · 범위 초과). */
  | MoneyConversionFailure;

export type MoneyPlan<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: MoneyRejectionReason };

/** 환산에 쓰는 스냅샷의 최소 모양. */
export interface FxSnapshotRef {
  readonly id: string;
  readonly baseCurrency: string;
  readonly asOfDate: string;
  /** `numeric(24,12)` 고정 소수. 드라이버가 문자열로 준다 — 그대로 넘긴다. */
  readonly rate: string;
  readonly moneyContractVersion: number;
}

/** 체인 계산에 들어가는 승인의 원본 사실(= 사람·파서가 확정한 입력). */
export interface ChainApprovalInput {
  /** 원통화 minor units. KRW 거래면 그대로 원. */
  readonly minorUnits: number;
  /** 원통화 ISO 코드. `'KRW'`면 환산하지 않는다. */
  readonly currency: string;
  /** 외화면 필수. KRW면 무시된다. */
  readonly snapshot?: FxSnapshotRef | null;
  /** 금액과 무관한 검토 플래그(§{@link MoneyReviewFlag}). */
  readonly reviewFlag?: MoneyReviewFlag | null;
}

/** 이 승인에 연결된(또는 연결하려는) 취소 하나. */
export interface ChainCancellationInput {
  readonly id: string;
  /** 원통화 minor units. 승인과 **같은 통화**여야 한다. */
  readonly minorUnits: number;
  readonly currency: string;
}

export interface ChainPlan {
  readonly approval: MoneyColumns;
  readonly cancellations: readonly { readonly id: string; readonly columns: MoneyColumns }[];
  /** 원통화 잔액(외화) 또는 KRW 잔액. 후보 판정과 진단에 쓴다. */
  readonly originalRemaining: number;
}

/**
 * 승인 + 연결된 취소 전체로 12개 보호 컬럼을 다시 계산한다.
 *
 * ## 외화 산술이 KRW 뺄셈이 아닌 이유 (ADR-0027 §4)
 *
 * 부분취소를 KRW로 빼면 취소마다 반올림 오차가 쌓여 원통화 전액취소가 0원이 되지
 * 않는다(USD 33.33 × 3 = USD 99.99가 아니라 100.00인 경우 등). 그래서 순액은
 * **원통화 잔액을 승인 환율로 다시 환산**해 유도하고, KRW 취소 누계는
 * `승인액 - 순액`으로 역산한다. 이러면 부분취소의 순서·횟수와 무관하게 결과가 같고,
 * 원통화 잔액이 0이면 순액이 정확히 0이 된다 — 환율이 오르든 내리든.
 *
 * ## 취소 행의 환율이 취소일이 아니라 승인 스냅샷인 이유
 *
 * 취소일 환율을 쓰면 같은 원통화 전액취소가 KRW에서 상계되지 않는다(D-1). 연결된
 * 취소의 표시 금액도 승인 스냅샷으로 다시 유도해 한 체인 안에 두 날짜의 환율이
 * 섞이지 않게 한다.
 */
export function planChain(
  approval: ChainApprovalInput,
  cancellations: readonly ChainCancellationInput[],
): MoneyPlan<ChainPlan> {
  if (!Number.isSafeInteger(approval.minorUnits) || approval.minorUnits < 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const approvalCurrency = approval.currency.toUpperCase();

  for (const cancellation of cancellations) {
    if (!Number.isSafeInteger(cancellation.minorUnits) || cancellation.minorUnits < 0) {
      return { ok: false, reason: 'invalid_amount' };
    }
    // 통화가 다르면 minor units 뺄셈 자체가 의미를 잃는다($22.00=2200 vs ₩2,200=2200).
    // 느슨하게 풀지 않고 체인 전체를 거부한다(ADR §2).
    if (cancellation.currency.toUpperCase() !== approvalCurrency) {
      return { ok: false, reason: 'currency_mismatch' };
    }
  }

  let cancelledOriginal = 0;
  for (const cancellation of cancellations) {
    cancelledOriginal += cancellation.minorUnits;
  }
  if (!Number.isSafeInteger(cancelledOriginal)) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (cancelledOriginal > approval.minorUnits) {
    return { ok: false, reason: 'cancellation_exceeds_approval' };
  }
  const originalRemaining = approval.minorUnits - cancelledOriginal;

  return approvalCurrency === MONEY_SETTLEMENT_CURRENCY
    ? planKrwChain(approval, cancellations, cancelledOriginal, originalRemaining)
    : planForeignChain(
        approval,
        approvalCurrency,
        cancellations,
        cancelledOriginal,
        originalRemaining,
      );
}

/**
 * KRW 체인. 저장 통화와 원통화가 같으므로 원통화 컬럼은 비운다
 * (ADR-0027 §3: "새 KRW 승인은 `amount=netAmount`, `currency='KRW'`로 만들고
 * 원통화·환율 필드는 비운다").
 */
function planKrwChain(
  approval: ChainApprovalInput,
  cancellations: readonly ChainCancellationInput[],
  cancelledAmount: number,
  remaining: number,
): MoneyPlan<ChainPlan> {
  const approvalColumns: MoneyColumns = {
    amount: approval.minorUnits,
    currency: MONEY_SETTLEMENT_CURRENCY,
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    fxRateSnapshotId: null,
    cancelledAmount,
    // KRW는 `amount - cancelledAmount`가 이미 원통화 잔액이라 별도 누계가 없다
    // (0049 주석과 v2-4 CHECK가 같은 판단이다).
    originalCancelledAmount: null,
    netAmount: remaining,
    parentTransactionId: null,
    status: deriveStatus(approval.reviewFlag, cancellations.length, cancelledAmount, remaining),
    moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
  };

  return {
    ok: true,
    value: {
      approval: approvalColumns,
      cancellations: cancellations.map((cancellation) => ({
        id: cancellation.id,
        columns: linkedCancellationColumns({
          amount: cancellation.minorUnits,
          originalAmount: null,
          originalCurrency: null,
          exchangeRate: null,
          fxRateSnapshotId: null,
        }),
      })),
      originalRemaining: remaining,
    },
  };
}

/**
 * 외화 체인. 저장은 KRW, 원통화·스냅샷은 병기 보존한다(v2-1·v2-3).
 * 순액은 원통화 잔액을 **승인 스냅샷 환율**로 환산해 유도한다.
 */
function planForeignChain(
  approval: ChainApprovalInput,
  currency: string,
  cancellations: readonly ChainCancellationInput[],
  cancelledOriginal: number,
  originalRemaining: number,
): MoneyPlan<ChainPlan> {
  const snapshot = approval.snapshot ?? null;
  // 오늘 환율이나 상수 폴백으로 대체하지 않는다(ADR §3). 스냅샷이 없으면 거래를
  // 만들지 않고 재시도/검토로 보내는 것이 계약이다.
  if (!snapshot) {
    return { ok: false, reason: 'fx_snapshot_missing' };
  }
  if (snapshot.baseCurrency.toUpperCase() !== currency) {
    return { ok: false, reason: 'currency_mismatch' };
  }

  const gross = convertToKrw(approval.minorUnits, currency, snapshot.rate);
  if (!gross.ok) {
    return { ok: false, reason: gross.failure };
  }
  // 원통화 잔액 0은 환산하지 않고 0으로 못 박는다. 환산 반올림이 1원을 남길 여지를
  // 없애야 "원통화 전액취소는 정확히 0"(ADR §4)이 환율 방향과 무관하게 성립한다.
  let netAmount = 0;
  if (originalRemaining > 0) {
    const remainder = convertToKrw(originalRemaining, currency, snapshot.rate);
    if (!remainder.ok) {
      return { ok: false, reason: remainder.failure };
    }
    netAmount = remainder.krw;
  }

  const displayRate = fxRateDisplayValue(snapshot.rate);
  const approvalColumns: MoneyColumns = {
    amount: gross.krw,
    currency: MONEY_SETTLEMENT_CURRENCY,
    originalAmount: approval.minorUnits,
    originalCurrency: currency,
    exchangeRate: displayRate,
    fxRateSnapshotId: snapshot.id,
    // KRW 취소 누계는 승인액에서 순액을 뺀 값으로 **역산**한다. 취소별 환산액을
    // 더하면 반올림이 누적돼 `amount = cancelledAmount + netAmount`(v2-5)가 깨진다.
    cancelledAmount: gross.krw - netAmount,
    originalCancelledAmount: cancelledOriginal,
    netAmount,
    parentTransactionId: null,
    status: deriveStatus(
      approval.reviewFlag,
      cancellations.length,
      cancelledOriginal,
      originalRemaining,
    ),
    moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
  };

  const plannedCancellations: { id: string; columns: MoneyColumns }[] = [];
  for (const cancellation of cancellations) {
    // 취소 행의 KRW 표시 금액도 **승인 스냅샷**으로 유도한다(ADR §4).
    const converted = convertToKrw(cancellation.minorUnits, currency, snapshot.rate);
    if (!converted.ok) {
      return { ok: false, reason: converted.failure };
    }
    plannedCancellations.push({
      id: cancellation.id,
      columns: linkedCancellationColumns({
        amount: converted.krw,
        originalAmount: cancellation.minorUnits,
        originalCurrency: currency,
        exchangeRate: displayRate,
        fxRateSnapshotId: snapshot.id,
      }),
    });
  }

  return {
    ok: true,
    value: {
      approval: approvalColumns,
      cancellations: plannedCancellations,
      originalRemaining,
    },
  };
}

/**
 * 연결된 취소 행의 컬럼. `netAmount=0`은 ADR-0009부터의 규약이고 v2-6 CHECK가
 * 강제한다 — 0이 아니면 같은 취소가 승인 쪽과 취소 쪽에서 두 번 계상된다.
 *
 * `parentTransactionId`는 실행기가 채운다(승인 id는 삽입 시점에 정해진다).
 * `status='approved'`는 "연결 검토가 끝났다"는 뜻이지 거래가 승인됐다는 뜻이 아니다
 * (ADR §4: 종류와 처리 상태를 한 값으로 합치지 않는다).
 */
function linkedCancellationColumns(money: {
  amount: number;
  originalAmount: number | null;
  originalCurrency: string | null;
  exchangeRate: number | null;
  fxRateSnapshotId: string | null;
}): MoneyColumns {
  return {
    amount: money.amount,
    currency: MONEY_SETTLEMENT_CURRENCY,
    originalAmount: money.originalAmount,
    originalCurrency: money.originalCurrency,
    exchangeRate: money.exchangeRate,
    fxRateSnapshotId: money.fxRateSnapshotId,
    cancelledAmount: 0,
    // v2-4는 승인에만 원통화 누계를 요구한다 — 취소가 취소되는 개념은 없다.
    originalCancelledAmount: null,
    netAmount: 0,
    parentTransactionId: null,
    status: 'approved',
    moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
  };
}

/**
 * 승인 status. 취소가 하나라도 붙으면 금액에서 파생된 값이 검토 플래그를 이긴다
 * (기존 승격·`linkCancellation` 동작과 동일).
 */
function deriveStatus(
  reviewFlag: MoneyReviewFlag | null | undefined,
  linkedCount: number,
  cancelled: number,
  remaining: number,
): MoneyStatus {
  if (linkedCount === 0) {
    return reviewFlag ?? 'approved';
  }
  if (remaining <= 0) return 'cancelled';
  return cancelled > 0 ? 'partially_cancelled' : 'approved';
}

/* -------------------------------------------------------------------------- */
/* 취소 후보 판정 (ADR-0027 §4)                                                */
/* -------------------------------------------------------------------------- */

/** 후보 판정에 필요한 승인 행의 사실. */
export interface CancellationCandidate {
  readonly id: string;
  readonly cardId: string | null;
  readonly currency: string;
  readonly originalCurrency: string | null;
  readonly amount: number;
  readonly cancelledAmount: number;
  readonly originalAmount: number | null;
  readonly originalCancelledAmount: number | null;
  readonly approvedAt: Date | null;
  readonly authorizationCode: string | null;
  readonly merchantNormalized: string | null;
  readonly status: string;
}

/** 후보를 찾을 취소 행의 사실. */
export interface CancellationEvidence {
  readonly cardId: string | null;
  /** 원통화(외화) 또는 `'KRW'`. */
  readonly currency: string;
  /** 원통화 minor units. */
  readonly minorUnits: number;
  readonly cancelledAt: Date | null;
  readonly authorizationCode: string | null;
  readonly merchantNormalized: string | null;
}

export type CancellationMatch =
  /** 필터 결과가 정확히 하나 — 자동 연결한다. */
  | { readonly kind: 'unique'; readonly approval: CancellationCandidate }
  /** 후보 0개 — 취소를 `pending_review`로 남긴다. */
  | { readonly kind: 'none' }
  /** 후보 2개 이상 — 사람이 원승인을 고른다. */
  | { readonly kind: 'ambiguous'; readonly count: number }
  /**
   * 자동 판정에 필요한 증거가 빠졌다. ADR §4: "카드·시각·가맹점 증거가 빠졌다고
   * 조건을 느슨하게 풀지 않으며 그 경우 사람 선택으로 보낸다."
   */
  | { readonly kind: 'insufficient_evidence'; readonly missing: 'occurred_at' | 'identity' };

/**
 * 취소에 연결할 승인을 고른다. **유일할 때만** 연결한다.
 *
 * 기존 승격과 갈리는 지점이 둘 있고, shadow가 재는 것이 정확히 이 둘이다:
 *
 * 1. 잔액 비교 축이 **원통화**다. 지금은 환산된 KRW 잔액으로 비교해서 승인과 취소가
 *    다른 날 환율을 쓰면 같은 건의 전액취소가 탈락한다(D-1).
 * 2. 증거가 없으면 **연결하지 않는다**. 지금은 `merchantNormalized`가 없으면 그
 *    조건을 통째로 빼고 나머지로 매칭해서, 가맹점을 못 읽은 취소가 엉뚱한 승인에
 *    붙을 수 있다.
 */
export function selectCancellationParent(
  cancellation: CancellationEvidence,
  candidates: readonly CancellationCandidate[],
): CancellationMatch {
  // 승인시각·취소시각 비교는 조건이지 옵션이 아니다. 시각을 모르면 "앞선 승인"을
  // 판정할 수 없으므로 사람에게 보낸다.
  const cancelledAt = cancellation.cancelledAt;
  if (!cancelledAt) {
    return { kind: 'insufficient_evidence', missing: 'occurred_at' };
  }
  // 승인번호도 가맹점도 없으면 같은 카드·같은 통화·잔액 조건만 남는다. 그 조건으로
  // 유일 후보가 나와도 그것은 "증거가 하나뿐"이 아니라 "구분할 수단이 없었을 뿐"이다.
  if (!cancellation.authorizationCode && !cancellation.merchantNormalized) {
    return { kind: 'insufficient_evidence', missing: 'identity' };
  }

  const currency = cancellation.currency.toUpperCase();
  const matches = candidates.filter((candidate) => {
    if (candidate.status !== 'approved' && candidate.status !== 'partially_cancelled') {
      return false;
    }
    // 미연결이면 양쪽 모두 null이어야 한다(ADR §4). null을 와일드카드로 보면
    // 카드 미연결 취소가 아무 카드 승인에나 붙는다.
    if ((candidate.cardId ?? null) !== (cancellation.cardId ?? null)) return false;
    if (candidateCurrency(candidate) !== currency) return false;
    if (!candidate.approvedAt || candidate.approvedAt >= cancelledAt) return false;

    if (cancellation.authorizationCode) {
      if (candidate.authorizationCode !== cancellation.authorizationCode) return false;
    } else if (candidate.merchantNormalized && cancellation.merchantNormalized) {
      if (candidate.merchantNormalized !== cancellation.merchantNormalized) return false;
    } else {
      // 후보 쪽 가맹점이 비어 있으면 대조할 증거가 없다 — 통과시키지 않는다.
      return false;
    }

    return candidateRemaining(candidate) >= cancellation.minorUnits;
  });

  if (matches.length === 1) return { kind: 'unique', approval: matches[0] };
  if (matches.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', count: matches.length };
}

/** 후보 승인의 **원통화** — 외화면 `originalCurrency`, 아니면 저장 통화. */
export function candidateCurrency(candidate: CancellationCandidate): string {
  return (candidate.originalCurrency ?? candidate.currency).toUpperCase();
}

/**
 * 후보 승인의 **원통화 잔액**. 외화는 `originalAmount - originalCancelledAmount`,
 * KRW는 `amount - cancelledAmount`다(ADR §4).
 */
export function candidateRemaining(candidate: CancellationCandidate): number {
  if (candidate.originalCurrency && candidate.originalAmount !== null) {
    return candidate.originalAmount - (candidate.originalCancelledAmount ?? 0);
  }
  return candidate.amount - candidate.cancelledAmount;
}

/**
 * 잠글 행 id를 **오름차순**으로 정렬한다.
 *
 * ADR §2: "부모를 바꾸는 재연결은 이전·새 부모 id의 오름차순으로 행을 잠가 교착과
 * 이중 상계를 막는다." 이미 배포된 API·worker 경로도 **승인 → 취소** 순서로 잠그고
 * 있으므로(`transaction.service.ts` `linkCancellation`/`remove`,
 * `transaction-promotion.service.ts` `promoteCancellation`), 새 서비스도 승인들을
 * 먼저 이 순서로 잠근 뒤 취소를 잠근다. 한 경로라도 반대로 잠그면 교차 시 데드락이다.
 */
export function orderedLockIds(ids: readonly (string | null | undefined)[]): string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    if (id) unique.add(id);
  }
  return [...unique].sort();
}

/** {@link MoneyColumns}를 보호 컬럼 이름으로 색인 가능한 레코드로 본다. */
export type MoneyColumnRecord = Record<MoneyProtectedColumn, unknown>;
