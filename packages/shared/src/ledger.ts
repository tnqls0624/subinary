/**
 * 가족 원장 MVP 1차 — 순수 도메인 계산.
 *
 * DB·Nest 없이 잔액 전이와 '지금 써도 되나' 판단만 소유한다.
 * 금액은 KRW 정수(BigInt). ADR-0027 카드 금액 계약과 저장소는 다르지만
 * "소수·음수 금지" 규약은 같다.
 */

export type LedgerAccountKind =
  | 'checking'
  | 'savings'
  | 'cash'
  | 'loan'
  | 'investment';

export type LedgerRecordKind = 'expense' | 'income';

/** 가용 현금으로 세는 계좌 종류(대출·투자 제외). */
export const SPENDABLE_ACCOUNT_KINDS: readonly LedgerAccountKind[] = [
  'checking',
  'savings',
  'cash',
] as const;

export function isSpendableAccountKind(kind: string): boolean {
  return (SPENDABLE_ACCOUNT_KINDS as readonly string[]).includes(kind);
}

export type BalanceApplyFailure =
  | 'insufficient_balance'
  | 'loan_overpay'
  | 'closed_account'
  | 'invalid_amount';

export type BalanceApplyResult =
  | { readonly ok: true; readonly nextBalance: bigint }
  | { readonly ok: false; readonly reason: BalanceApplyFailure };

function parsePositiveAmount(amount: string): bigint | null {
  if (!/^[1-9]\d{0,19}$/.test(amount)) return null;
  return BigInt(amount);
}

/**
 * RecordTransaction 잔액 전이.
 * - 자산 계좌: income +, expense −
 * - 대출(loan): expense(상환)는 원금 −, income(추가 인출)은 원금 +
 */
export function applyRecordTransactionBalance(input: {
  readonly kind: LedgerRecordKind;
  readonly accountKind: LedgerAccountKind;
  readonly currentBalance: string;
  readonly amount: string;
  readonly status: 'open' | 'closed';
}): BalanceApplyResult {
  if (input.status !== 'open') return { ok: false, reason: 'closed_account' };
  const amount = parsePositiveAmount(input.amount);
  if (amount === null) return { ok: false, reason: 'invalid_amount' };
  if (!/^(0|[1-9]\d{0,19})$/.test(input.currentBalance)) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const current = BigInt(input.currentBalance);

  if (input.accountKind === 'loan') {
    if (input.kind === 'expense') {
      if (amount > current) return { ok: false, reason: 'loan_overpay' };
      return { ok: true, nextBalance: current - amount };
    }
    return { ok: true, nextBalance: current + amount };
  }

  if (input.kind === 'expense') {
    if (amount > current) return { ok: false, reason: 'insufficient_balance' };
    return { ok: true, nextBalance: current - amount };
  }
  return { ok: true, nextBalance: current + amount };
}

/**
 * TransferBetweenAccounts 잔액 전이.
 * from/to 모두 자산 계좌여야 한다(대출 간 이체는 MVP1 거부).
 */
export function applyTransferBalances(input: {
  readonly fromKind: LedgerAccountKind;
  readonly toKind: LedgerAccountKind;
  readonly fromBalance: string;
  readonly toBalance: string;
  readonly amount: string;
  readonly fromStatus: 'open' | 'closed';
  readonly toStatus: 'open' | 'closed';
}):
  | {
      readonly ok: true;
      readonly nextFrom: bigint;
      readonly nextTo: bigint;
    }
  | { readonly ok: false; readonly reason: BalanceApplyFailure | 'loan_transfer_unsupported' } {
  if (input.fromStatus !== 'open' || input.toStatus !== 'open') {
    return { ok: false, reason: 'closed_account' };
  }
  if (input.fromKind === 'loan' || input.toKind === 'loan') {
    return { ok: false, reason: 'loan_transfer_unsupported' };
  }
  const amount = parsePositiveAmount(input.amount);
  if (amount === null) return { ok: false, reason: 'invalid_amount' };
  if (
    !/^(0|[1-9]\d{0,19})$/.test(input.fromBalance) ||
    !/^(0|[1-9]\d{0,19})$/.test(input.toBalance)
  ) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const from = BigInt(input.fromBalance);
  const to = BigInt(input.toBalance);
  if (amount > from) return { ok: false, reason: 'insufficient_balance' };
  return { ok: true, nextFrom: from - amount, nextTo: to + amount };
}

export function applyGoalContribution(input: {
  readonly savedAmount: string;
  readonly amount: string;
  readonly status: 'open' | 'closed';
}):
  | { readonly ok: true; readonly nextSaved: bigint }
  | { readonly ok: false; readonly reason: 'goal_closed' | 'invalid_amount' } {
  if (input.status !== 'open') return { ok: false, reason: 'goal_closed' };
  const amount = parsePositiveAmount(input.amount);
  if (amount === null) return { ok: false, reason: 'invalid_amount' };
  if (!/^(0|[1-9]\d{0,19})$/.test(input.savedAmount)) {
    return { ok: false, reason: 'invalid_amount' };
  }
  return { ok: true, nextSaved: BigInt(input.savedAmount) + amount };
}

export type CanSpendDecision = 'ok' | 'caution' | 'no';

export interface CanSpendJudgmentInput {
  /** 가용 현금성 잔액 합. */
  readonly availableKrw: bigint;
  /** 최근 7일 순지출. */
  readonly recentSpendKrw: bigint;
  /** 이번 달 예산 잔여(규칙별 잔여의 최솟값). 규칙 없으면 null. */
  readonly budgetRemainingKrw: bigint | null;
}

export interface CanSpendJudgment {
  readonly decision: CanSpendDecision;
  readonly reasons: string[];
}

export interface BudgetRuleSpendInput {
  readonly amount: bigint;
  readonly categoryId: string | null;
  readonly personId: string;
  readonly kind: string;
  readonly goalId: string | null;
}

/**
 * 한 예산 규칙의 잔여 = limit − (category·person 조건에 맞는 지출).
 * categoryId/personId가 null이면 그 축은 전체.
 */
export function remainingForBudgetRule(input: {
  readonly amountLimit: bigint;
  readonly categoryId: string | null;
  readonly personId: string | null;
  readonly spends: ReadonlyArray<BudgetRuleSpendInput>;
}): bigint {
  let spent = 0n;
  for (const row of input.spends) {
    if (!countsTowardRecentSpend({ kind: row.kind, goalId: row.goalId })) continue;
    if (input.categoryId !== null && row.categoryId !== input.categoryId) continue;
    if (input.personId !== null && row.personId !== input.personId) continue;
    spent += row.amount;
  }
  return input.amountLimit - spent;
}

/** 규칙별 잔여 중 가장 빡센(작은) 값. 규칙이 없으면 null. */
export function tightestBudgetRemaining(
  remainings: ReadonlyArray<bigint>,
): bigint | null {
  if (remainings.length === 0) return null;
  let min = remainings[0]!;
  for (let i = 1; i < remainings.length; i += 1) {
    const value = remainings[i]!;
    if (value < min) min = value;
  }
  return min;
}

/**
 * 잔액·최근 지출·예산 잔여를 하나의 판단으로 합친다.
 * - no: 가용 0 이하, 또는 예산이 있고 잔여 0 이하
 * - caution: 최근 7일 지출이 가용보다 큼, 또는 예산 잔여가 최근 지출보다 작음
 * - ok: 그 외
 */
export function judgeCanSpend(input: CanSpendJudgmentInput): CanSpendJudgment {
  const reasons: string[] = [];

  if (input.availableKrw <= 0n) {
    reasons.push('가용 현금 잔액이 없어요.');
    return { decision: 'no', reasons };
  }

  if (input.budgetRemainingKrw !== null && input.budgetRemainingKrw <= 0n) {
    reasons.push('이번 달 예산이 모두 소진됐어요.');
    return { decision: 'no', reasons };
  }

  let caution = false;
  if (input.recentSpendKrw > input.availableKrw) {
    reasons.push('최근 7일 지출이 가용 잔액보다 커요.');
    caution = true;
  }
  if (
    input.budgetRemainingKrw !== null &&
    input.budgetRemainingKrw < input.recentSpendKrw
  ) {
    reasons.push('예산 잔여가 최근 7일 지출보다 적어요.');
    caution = true;
  }

  if (caution) return { decision: 'caution', reasons };
  reasons.push('가용 잔액과 최근 지출·예산 기준으로 써도 괜찮아요.');
  return { decision: 'ok', reasons };
}

export function sumSpendableBalances(
  rows: ReadonlyArray<{ kind: string; balance: string; status: string }>,
): bigint {
  let total = 0n;
  for (const row of rows) {
    if (row.status !== 'open') continue;
    if (!isSpendableAccountKind(row.kind)) continue;
    if (!/^(0|[1-9]\d{0,19})$/.test(row.balance)) continue;
    total += BigInt(row.balance);
  }
  return total;
}

/** 지금 써도 되나 집계에 넣는 거래 kind. 목표 적립 이체(outbound+goal)는 제외. */
export function countsTowardRecentSpend(input: {
  readonly kind: string;
  readonly goalId: string | null;
}): boolean {
  if (input.kind === 'expense') return true;
  if (input.kind === 'transfer_out' && input.goalId === null) return true;
  return false;
}

export function bigintToKrwString(value: bigint): string {
  if (value < 0n) throw new TypeError('negative_krw');
  return value.toString(10);
}
