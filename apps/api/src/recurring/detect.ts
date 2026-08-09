/**
 * 정기 지출 후보 판별 — **순수 · 결정적** (C-5).
 *
 * 같은 입력이면 언제 몇 번 돌려도 같은 후보가 나와야 한다. 그래야 후보를 "폐기·재생성
 * 가능한 projection"으로 다룰 수 있고(PO 판정 Q1-4), P0-10 enforce와 ADR-0027 과거
 * 수리 뒤 **전량 재계산**해도 사용자에게 설명 가능한 변화만 남는다.
 *
 * DB·시계·난수에 손대지 않는다. 시각 비교는 인자로 받은 `Date`만 쓴다.
 */
import {
  RECURRING_ALGORITHM_VERSION,
  RECURRING_AMOUNT_TOLERANCE_BPS,
  RECURRING_AMOUNT_TOLERANCE_FLOOR,
  RECURRING_MAX_SKIPPED_CYCLES,
  RECURRING_MIN_ON_CYCLE_RATIO_BPS,
  RECURRING_MONTHLY_MAX_DAYS,
  RECURRING_MONTHLY_MIN_DAYS,
  RECURRING_MONTHLY_MIN_DISTINCT_MONTHS,
  RECURRING_MONTHLY_MIN_OCCURRENCES,
  RECURRING_WEEKLY_MAX_DAYS,
  RECURRING_WEEKLY_MIN_DAYS,
  RECURRING_WEEKLY_MIN_OCCURRENCES,
  RECURRING_WEEKLY_MIN_SPAN_DAYS,
} from './recurring.constants';

export type RecurringCadence = 'weekly' | 'monthly';

/** 판별 입력 한 건 — 성공한 승인 거래 하나. */
export interface RecurringOccurrence {
  transactionId: string;
  memberId: string;
  /** 정규화 + 사용자 별칭까지 적용한 대표 이름. 없는 행은 애초에 입력에서 뺀다. */
  merchantCanonical: string;
  /** 순액(minor units, `currency` 기준). 양수만 들어온다. */
  netAmount: number;
  currency: string;
  /** `approvedAt ?? createdAt` — 지출 집계 창과 같은 규약. */
  occurredAt: Date;
  /** 이 근거가 기대는 금액 계약 버전(ADR-0027). */
  moneyContractVersion: number;
}

/** 판별 결과 한 묶음. 아직 DB에 없는 순수 값이다. */
export interface RecurringCandidate {
  memberId: string;
  merchantCanonical: string;
  currency: string;
  amountMin: number;
  amountMax: number;
  amountMedian: number;
  intervalDays: number;
  cadence: RecurringCadence;
  occurrenceCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** 근거들의 계약 버전 **최솟값** — 하나라도 v1이면 series 전체가 v1 신뢰도다. */
  moneyContractVersion: number;
  algorithmVersion: number;
  /** 근거 거래 ID. series 신원을 잇는 유일한 연결선이다. */
  transactionIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** KST 벽시계 기준 `YYYY-MM`. 달 경계는 서울 기준이어야 사용자의 달과 맞는다. */
function seoulMonthKey(at: Date): string {
  const shifted = new Date(at.getTime() + KST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  return `${y}-${m.toString().padStart(2, '0')}`;
}

/** 짝수 개일 때 **아래쪽**을 택한다 — 결정적이어야 하고 정수여야 한다. */
function median(sorted: readonly number[]): number {
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** 밴드 하한 기준 허용 폭(minor units). */
function amountBandWidth(base: number): number {
  return Math.max(
    Math.floor((base * RECURRING_AMOUNT_TOLERANCE_BPS) / 10_000),
    RECURRING_AMOUNT_TOLERANCE_FLOOR,
  );
}

interface CadenceSpec {
  cadence: RecurringCadence;
  minDays: number;
  maxDays: number;
  minOccurrences: number;
}

const CADENCES: readonly CadenceSpec[] = [
  {
    cadence: 'weekly',
    minDays: RECURRING_WEEKLY_MIN_DAYS,
    maxDays: RECURRING_WEEKLY_MAX_DAYS,
    minOccurrences: RECURRING_WEEKLY_MIN_OCCURRENCES,
  },
  {
    cadence: 'monthly',
    minDays: RECURRING_MONTHLY_MIN_DAYS,
    maxDays: RECURRING_MONTHLY_MAX_DAYS,
    minOccurrences: RECURRING_MONTHLY_MIN_OCCURRENCES,
  },
];

/**
 * 정기 지출 후보를 찾는다.
 *
 * 절차: `(구성원, canonical 가맹점, 통화)`로 나누고 → 금액 밴드로 다시 나누고 →
 * 간격의 규칙성으로 주기를 판정한다. 가맹점 신원이 **먼저** 확정돼 있어야 하므로
 * 호출부가 `resolveCanonicalMerchant`를 통과시킨 값을 넣는다(P1-16과 같은 순서 문제).
 *
 * 반환 순서는 결정적이다(마지막 관측 최신순 → 가맹점명 → 금액).
 */
export function detectRecurringCandidates(
  occurrences: readonly RecurringOccurrence[],
): RecurringCandidate[] {
  const byMerchant = new Map<string, RecurringOccurrence[]>();
  for (const occ of occurrences) {
    if (!occ.merchantCanonical || occ.netAmount <= 0) continue;
    const key = `${occ.memberId}\u0000${occ.merchantCanonical}\u0000${occ.currency}`;
    const list = byMerchant.get(key);
    if (list) list.push(occ);
    else byMerchant.set(key, [occ]);
  }

  const candidates: RecurringCandidate[] = [];
  for (const group of byMerchant.values()) {
    for (const band of splitByAmountBand(group)) {
      const candidate = evaluateBand(band);
      if (candidate) candidates.push(candidate);
    }
  }

  candidates.sort(
    (a, b) =>
      b.lastSeenAt.getTime() - a.lastSeenAt.getTime() ||
      a.merchantCanonical.localeCompare(b.merchantCanonical) ||
      a.amountMedian - b.amountMedian,
  );
  return candidates;
}

/**
 * 금액 밴드로 쪼갠다 — 금액 오름차순 greedy.
 *
 * 밴드 폭을 **하한 기준**으로 계산해 밴드가 연쇄적으로 늘어나지 않게 한다. 중앙값
 * 기준으로 하면 값이 하나씩 붙을 때마다 폭이 커져 결국 전부 한 밴드가 된다
 * (9,900 · 10,300 · 10,700 · 11,100 …이 5% 밴드 하나로 합쳐지는 문제).
 */
function splitByAmountBand(
  group: readonly RecurringOccurrence[],
): RecurringOccurrence[][] {
  const sorted = [...group].sort((a, b) => a.netAmount - b.netAmount);
  const bands: RecurringOccurrence[][] = [];
  let current: RecurringOccurrence[] = [];
  let base = 0;

  for (const occ of sorted) {
    if (current.length === 0) {
      current = [occ];
      base = occ.netAmount;
      continue;
    }
    if (occ.netAmount - base <= amountBandWidth(base)) {
      current.push(occ);
      continue;
    }
    bands.push(current);
    current = [occ];
    base = occ.netAmount;
  }
  if (current.length > 0) bands.push(current);
  return bands;
}

/** 한 금액 밴드가 정기 결제인지 판정한다. 아니면 `null`. */
function evaluateBand(
  band: readonly RecurringOccurrence[],
): RecurringCandidate | null {
  const sorted = [...band].sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      a.transactionId.localeCompare(b.transactionId),
  );
  if (sorted.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push(
      (sorted[i].occurredAt.getTime() - sorted[i - 1].occurredAt.getTime()) /
        DAY_MS,
    );
  }
  const medianGap = median([...gaps].sort((a, b) => a - b));

  const spec = CADENCES.find(
    (c) => medianGap >= c.minDays && medianGap <= c.maxDays,
  );
  if (!spec) return null;
  if (sorted.length < spec.minOccurrences) return null;

  // 간격 규칙성: 각 간격은 1주기이거나, 허용 범위 안에서 몇 주기를 건너뛴 것이어야 한다.
  // 하나라도 어느 배수에도 맞지 않으면 정기 결제가 아니다(비정기 반복 구매).
  let onCycle = 0;
  for (const gap of gaps) {
    const cycles = matchedCycles(gap, spec);
    if (cycles === null) return null;
    if (cycles === 1) onCycle += 1;
  }
  // 건너뜀을 허용하되 대부분은 제 주기여야 한다 — 아니면 격월 결제가 월 주기로 잡힌다.
  if ((onCycle * 10_000) / gaps.length < RECURRING_MIN_ON_CYCLE_RATIO_BPS) {
    return null;
  }

  if (spec.cadence === 'monthly') {
    const months = new Set(sorted.map((o) => seoulMonthKey(o.occurredAt)));
    if (months.size < RECURRING_MONTHLY_MIN_DISTINCT_MONTHS) return null;
  } else {
    const spanDays =
      (sorted[sorted.length - 1].occurredAt.getTime() -
        sorted[0].occurredAt.getTime()) /
      DAY_MS;
    if (spanDays < RECURRING_WEEKLY_MIN_SPAN_DAYS) return null;
  }

  const amounts = sorted.map((o) => o.netAmount).sort((a, b) => a - b);
  return {
    memberId: sorted[0].memberId,
    merchantCanonical: sorted[0].merchantCanonical,
    currency: sorted[0].currency,
    amountMin: amounts[0],
    amountMax: amounts[amounts.length - 1],
    amountMedian: median(amounts),
    intervalDays: Math.round(medianGap),
    cadence: spec.cadence,
    occurrenceCount: sorted.length,
    firstSeenAt: sorted[0].occurredAt,
    lastSeenAt: sorted[sorted.length - 1].occurredAt,
    moneyContractVersion: Math.min(
      ...sorted.map((o) => o.moneyContractVersion),
    ),
    algorithmVersion: RECURRING_ALGORITHM_VERSION,
    transactionIds: sorted.map((o) => o.transactionId),
  };
}

/**
 * 이 간격이 몇 주기인가. 어느 배수에도 맞지 않으면 `null`.
 *
 * 배수 허용 범위를 `[k*min, k*max]`로 넓히는 이유: 한 번 거른 월 구독의 간격은
 * 대략 2배지만 정확히 2배는 아니다(결제일이 말일 근처면 56~62일).
 */
function matchedCycles(gapDays: number, spec: CadenceSpec): number | null {
  for (let k = 1; k <= RECURRING_MAX_SKIPPED_CYCLES + 1; k += 1) {
    if (gapDays >= k * spec.minDays && gapDays <= k * spec.maxDays) return k;
  }
  return null;
}
