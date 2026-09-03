/**
 * 금액 계약 수리 — ADR-0027 **7단계**(기존 데이터 수리).
 *
 * ## 이 파일이 푸는 문제
 *
 * 5단계에서 `MONEY_CONTRACT_MODE=v2`로 전환했지만, 그건 **앞으로 쓰이는 행**에만 적용된다.
 * 그 이전에 만들어진 행은 `money_contract_version = 1`로 남아 있고(2026-09-03 실측 186건 /
 * 전체 259건 = 72%), 8단계 VALIDATE는 "v2 행에만 적용되는 제약"을 검증하므로 v1 행이
 * 남아 있는 한 열 수 없다.
 *
 * ## 무엇을 자동으로 고치는가 — 거의 아무것도 고치지 않는다
 *
 * ADR §3은 "**결정적으로 재현 가능한 행만** 가구 단위로 적용한다"고 정한다. 이 파일은 그
 * 문장을 가장 보수적으로 해석한다: **자동 적용은 금액을 한 원도 바꾸지 않는다.**
 *
 * 관찰기가 `match`를 낸 행은 새 계약이 같은 금액·통화·연결을 만든다는 뜻이다. 그런 행에
 * 필요한 것은 재계산이 아니라 **버전 스탬프**뿐이다. `after` 이미지가 `before`와 같고
 * `net_amount_delta`가 0이라, "수리 전후 월 합계 차이 = 수리 로그 delta 합"이라는 ADR의
 * 회귀 기준이 자명하게 성립한다.
 *
 * 금액이나 체인이 바뀌는 판정(`krw_amount_delta` · `fx_amount_delta` · `plan_failed` ·
 * `link_target_differs`)은 **하나도 자동 적용하지 않는다.** manifest에 남겨 사람이 본다.
 *
 * ### `link_manual_only`를 자동에 넣되 계획을 적용하지 않는 이유
 *
 * 이 판정은 "신규 규칙은 후보가 유일하지 않아 자동 연결을 거부했는데 사람이 골랐다"는
 * 뜻이고, ADR §4가 규정한 **설계대로 동작한 것**이다(shadow.ts:38-45). 금액은 이미 맞다.
 *
 * 그런데 이 행의 `planned.parentTransactionId`는 `null`이다 — 자동 규칙이 못 골랐으니까.
 * 계획을 곧이곧대로 적용하면 **사람이 한 연결이 끊긴다.** 그래서 auto 경로는 계획을
 * 적용하지 않고 버전만 올린다. "재현 가능하다"는 것은 "계획을 그대로 써도 된다"와
 * 다르며, 이 한 건이 그 차이를 보여준다.
 *
 * ## 왜 shadow sink를 그대로 쓰지 않는가
 *
 * 기록 모양은 거의 같지만 세 가지가 다르다.
 *  1. `batch_id`가 **배치 전체에 하나**다. shadow는 행마다 새로 만든다(되돌림 단위가 없으니까).
 *     수리는 batch 단위로 역순 복원하므로 고정이어야 한다.
 *  2. `reason` 접두가 `repair:`다. shadow는 `reason NOT LIKE 'shadow:%'`로 걸러지는 쪽에
 *     자기 행을 두지 않으려고 `shadow:`를 쓴다(shadow-sink.ts:22-23).
 *  3. **예외를 삼키지 않는다.** shadow는 기존 쓰기 경로를 절대 실패시키면 안 되므로 삼키지만,
 *     수리는 기록이 곧 되돌림 근거다. 남지 않은 변경은 되돌릴 수 없으므로 터져야 한다.
 */
import { randomUUID } from 'node:crypto';

import {
  MONEY_CONTRACT_VERSION_V2,
  buildTransactionMoneyImage,
  schema,
  transactionMoneyChecksum,
  v2ConstraintViolations,
  type DbExecutor,
  type MoneyV2Constraint,
  type TransactionMoneyRowLike,
  type TransactionMoneyV2CheckRowLike,
} from '@family/database';
import type { TransactionMoneyRepairAction } from '@family/database';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';

import type { MoneyShadowRecord, MoneyShadowVerdict } from './shadow.js';

/** 수리 행의 `reason` 접두어. shadow(`shadow:`)와 섞이지 않게 한다. */
export const MONEY_REPAIR_REASON_PREFIX = 'repair:';

/**
 * 자동 적용 가능 판정.
 *
 * 이 집합에 무언가를 더하려면 "그 판정의 행을 스탬프만 찍어도 금액이 맞다"를 먼저
 * 증명해야 한다. 지금 둘은 각각 "새 계약이 같은 값을 만든다"(match)와 "설계대로 사람이
 * 연결했고 금액은 맞다"(link_manual_only)라서 그 조건을 만족한다.
 */
export const MONEY_REPAIR_AUTO_VERDICTS: readonly MoneyShadowVerdict[] = [
  'match',
  'link_manual_only',
];

export type MoneyRepairEligibility = 'auto' | 'review';

/**
 * 계획을 적용해도 **사용자가 보는 금액이 그대로**여야 하는 축.
 *
 * 이 여섯 개가 하나라도 달라지면 지출 합계·취소 체인·귀속이 움직인다. auto는 이것들이
 * 전부 같을 때만 성립한다.
 */
const MONEY_IDENTITY_COLUMNS = [
  'amount',
  'currency',
  'cancelledAmount',
  'netAmount',
  'parentTransactionId',
  'status',
] as const;

/**
 * 금액을 바꾸지 않고 **증빙만 채우는** 컬럼.
 *
 * `null → 값`은 허용한다(없던 근거가 생기는 것). `값 → 다른 값`은 금지한다 — 그건
 * 이미 적용된 환율을 다시 쓰는 것이고, 사용자가 본 KRW가 흔들린다.
 */
const MONEY_EVIDENCE_COLUMNS = [
  'originalAmount',
  'originalCurrency',
  'exchangeRate',
  'fxRateSnapshotId',
  'originalCancelledAmount',
] as const;

/** 계획을 적용해도 금액이 움직이지 않는가. 순수 함수다. */
export function planKeepsMoneyIdentity(
  actualRow: TransactionMoneyRowLike,
  planned: Record<string, unknown> | null,
): boolean {
  if (!planned) return false;

  for (const column of MONEY_IDENTITY_COLUMNS) {
    const before = (actualRow as unknown as Record<string, unknown>)[column] ?? null;
    const after = planned[column] ?? null;
    if (before !== after) return false;
  }

  for (const column of MONEY_EVIDENCE_COLUMNS) {
    const before = (actualRow as unknown as Record<string, unknown>)[column] ?? null;
    const after = planned[column] ?? null;
    // 없던 근거가 생기는 것만 허용한다.
    if (before !== null && before !== after) return false;
  }

  return true;
}


/**
 * 판정 → 처리 등급. 순수 함수다(테스트가 DB 없이 전 판정을 훑는다).
 *
 * `auto`는 "버전 스탬프만 찍는다"는 뜻이지 "계획을 적용한다"가 아니다. 이 구분이
 * 무너지면 `link_manual_only`가 사람 연결을 끊는다(위 머리주석 참고).
 *
 * ## 관문이 둘인 이유 (2026-09-03 실행에서 배웠다)
 *
 * 처음에는 verdict만 봤다. 그랬더니 186건을 전부 auto로 분류했고, 적용 58번째 행에서
 * `card_transactions_v2_fx_snapshot_check`에 걸려 멈췄다 — 외화인데 환율 스냅샷이 없는
 * 행이었다(ADR §2 분류표의 "자동 외화 v1"). 앞선 57건은 이미 커밋된 뒤였다.
 *
 * **금액이 같다는 사실과 v2 계약을 만족한다는 사실은 다르다.** 관찰기는 앞을 보고,
 * `v2ConstraintViolations`가 뒤를 본다. 스탬프는 행을 v2로 **선언**하는 행위라 둘 다
 * 통과해야 한다.
 */
export function classifyRepairEligibility(
  verdict: MoneyShadowVerdict,
  violations: readonly MoneyV2Constraint[] = [],
): MoneyRepairEligibility {
  if (violations.length > 0) return 'review';
  return MONEY_REPAIR_AUTO_VERDICTS.includes(verdict) ? 'auto' : 'review';
}

/**
 * 수리 로그의 `action`.
 *
 * 스탬프도 `recalculate_chain`으로 적는다 — "체인을 재계산했더니 같았다"가 실제로 일어난
 * 일이고, enum에 'stamp'를 새로 파면 되돌림·집계 쿼리가 전부 한 값씩 늘어난다.
 */
export function repairAction(
  record: MoneyShadowRecord,
  violations: readonly MoneyV2Constraint[] = [],
): TransactionMoneyRepairAction {
  if (classifyRepairEligibility(record.verdict, violations) === 'auto') {
    return 'recalculate_chain';
  }
  if (record.verdict === 'link_target_differs') return 'link_cancellation';
  // 통화·스냅샷 계열 위반은 전부 통화 정규화 작업으로 묶인다 — 원통화를 확정하고
  // 거래일 스냅샷을 붙이는 한 작업이지, 서로 다른 수리가 아니다.
  if (
    violations.includes('v2_currency_krw') ||
    violations.includes('v2_fx_snapshot') ||
    violations.includes('v2_original_pair') ||
    violations.includes('v2_original_cancelled') ||
    record.actual.currency.toUpperCase() !== 'KRW'
  ) {
    return 'normalize_currency';
  }
  return 'recalculate_chain';
}

/** 진단용 최소 정보. 가맹점명·원문은 넣지 않는다(ADR: 로그에는 집계 수치만). */
function repairNote(
  record: MoneyShadowRecord,
  eligibility: MoneyRepairEligibility,
  violations: readonly MoneyV2Constraint[],
): string {
  return JSON.stringify({
    eligibility,
    verdict: record.verdict,
    // 사람이 "무엇을 고쳐야 v2가 되는가"를 이 한 줄에서 알 수 있어야 한다.
    v2Violations: violations,
    path: record.path,
    transactionType: record.transactionType,
    foreign: record.foreign,
    failureReason: record.failureReason,
    actualParent: record.actual.parentTransactionId,
    plannedParent: record.plannedParentTransactionId,
    netAmountDelta: record.netAmountDelta,
  });
}

export interface MoneyRepairLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MoneyRepairPlanStats {
  readonly batchId: string;
  readonly planned: number;
  readonly auto: number;
  readonly review: number;
  readonly byVerdict: Readonly<Record<string, number>>;
}

/**
 * 관찰기 출력을 **미적용 manifest**로 적재하는 sink.
 *
 * 관찰기(`TransactionMoneyShadowObserver`)의 sink 인터페이스를 그대로 만족하므로,
 * 재생 경로에 이것을 끼우면 같은 판정이 메모리 대신 DB로 간다. 판정 로직을 베끼지
 * 않는 것이 핵심이다 — 베끼는 순간 수리와 게이트가 다른 답을 내기 시작한다.
 */
export class TransactionMoneyRepairManifestSink {
  private planned = 0;
  private auto = 0;
  private review = 0;
  private readonly byVerdict = new Map<string, number>();

  constructor(
    private readonly db: DbExecutor,
    readonly batchId: string,
    private readonly logger?: MoneyRepairLogger,
  ) {}

  stats(): MoneyRepairPlanStats {
    return {
      batchId: this.batchId,
      planned: this.planned,
      auto: this.auto,
      review: this.review,
      byVerdict: Object.fromEntries(this.byVerdict),
    };
  }

  /**
   * manifest 한 행을 적재한다. **예외를 삼키지 않는다** — 기록되지 않은 계획은 적용
   * 대상이 되지 않고, 조용히 빠진 계획은 "대상 없음"으로 오독된다.
   */
  async record(record: MoneyShadowRecord, actualRow: TransactionMoneyRowLike): Promise<void> {
    // 스탬프를 찍으면 이 행은 v2로 **선언**된다. 그래서 관찰기 판정만이 아니라 v2 제약도
    // 미리 본다 — 둘은 다른 사실이고, 하나만 보면 적용 중간에 DB가 막는다.
    const violations = v2ConstraintViolations({
      ...actualRow,
      transactionType: record.transactionType,
    } as TransactionMoneyV2CheckRowLike);
    const planned = record.planned;

    // 스탬프로는 못 고치지만 **금액을 바꾸지 않고 증빙만 채우면** v2가 되는 행이 있다.
    // 대표 사례: 외화인데 `fx_rate_snapshot_id`가 비어 있는 행. 스냅샷을 고정해 두면
    // (`fixate-legacy-fx-snapshots.mjs`) 계획이 그 스냅샷을 고르고, 금액은 그대로다.
    // 이때만 계획을 **적용**한다 — 그 밖의 계획 적용은 여전히 사람 몫이다.
    const evidenceOnly =
      violations.length > 0 &&
      MONEY_REPAIR_AUTO_VERDICTS.includes(record.verdict) &&
      planKeepsMoneyIdentity(actualRow, planned as Record<string, unknown> | null) &&
      v2ConstraintViolations({
        ...actualRow,
        ...(planned as object),
        transactionType: record.transactionType,
        moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
      } as TransactionMoneyV2CheckRowLike).length === 0;

    const eligibility: MoneyRepairEligibility = evidenceOnly
      ? 'auto'
      : classifyRepairEligibility(record.verdict, violations);

    // auto는 **스탬프**다: after 이미지는 before에서 계약 버전만 올린 것.
    // review는 관찰기의 계획을 그대로 담아 사람이 before/after를 비교하게 한다.
    const afterMoney =
      eligibility === 'auto'
        ? buildTransactionMoneyImage({
            ...actualRow,
            // evidence 모드는 계획의 증빙 컬럼을 담는다. 금액 축은 위에서 동일함을
            // 확인했으므로 이 병합이 사용자가 보는 숫자를 바꾸지 않는다.
            ...(evidenceOnly ? (planned as object) : {}),
            moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
          })
        : planned
          ? buildTransactionMoneyImage({
              ...actualRow,
              ...planned,
              parentTransactionId:
                record.plannedParentTransactionId ?? planned.parentTransactionId,
            })
          : null;

    // net_amount_before/after는 **비교가 성립할 때만** 채운다. 한쪽만 채우면 생성 컬럼
    // net_amount_delta가 `-before`가 되어 "설명되지 않는 delta"가 부풀려진다.
    const comparable = eligibility === 'auto' || planned !== null;
    const netAfter =
      eligibility === 'auto' ? record.actual.netAmount : (planned?.netAmount ?? null);
    const currencyAfter =
      eligibility === 'auto' ? record.actual.currency : (planned?.currency ?? null);

    await this.db.insert(schema.transactionMoneyRepairLog).values({
      batchId: this.batchId,
      householdId: record.householdId,
      transactionId: record.transactionId,
      sourceEventId: record.sourceEventId,
      action: repairAction(record, violations),
      // 제약 때문에 막힌 행은 **무엇이 막았는지**를 reason에 싣는다. verdict만 적으면
      // 집계에서 `review:match`가 되어 "일치하는데 왜 검토?"라는 답 없는 줄이 남는다.
      reason: evidenceOnly
        ? `${MONEY_REPAIR_REASON_PREFIX}auto:evidence:${violations[0]}`
        : violations.length > 0
          ? `${MONEY_REPAIR_REASON_PREFIX}review:${violations[0]}`
          : `${MONEY_REPAIR_REASON_PREFIX}${eligibility}:${record.verdict}`,
      note: repairNote(record, eligibility, violations),
      beforeMoney: buildTransactionMoneyImage(actualRow),
      afterMoney,
      netAmountBefore: comparable ? record.actual.netAmount : null,
      netAmountAfter: comparable ? netAfter : null,
      currencyBefore: comparable ? record.actual.currency : null,
      currencyAfter: comparable ? currencyAfter : null,
      checksumBefore: transactionMoneyChecksum(actualRow),
      // appliedAt·checksumAfter·restoreImage는 비운다 — lifecycle check의 첫 분기
      // (= 아직 적용되지 않은 dry-run manifest).
    });

    this.planned += 1;
    if (eligibility === 'auto') this.auto += 1;
    else this.review += 1;
    const key = evidenceOnly
      ? `evidence:${violations[0]}`
      : violations.length > 0
        ? `blocked:${violations[0]}`
        : record.verdict;
    this.byVerdict.set(key, (this.byVerdict.get(key) ?? 0) + 1);

    this.logger?.info(
      {
        batchId: this.batchId,
        transactionId: record.transactionId,
        verdict: record.verdict,
        eligibility,
        netAmountDelta: record.netAmountDelta,
      },
      'money repair manifest recorded',
    );
  }
}

export interface MoneyRepairApplyStats {
  readonly batchId: string;
  readonly applied: number;
  /** 체크섬이 달라져 건너뛴 건수. 그 사이 누군가 이 거래를 손댔다는 뜻이다. */
  readonly skippedStale: number;
  /** 이미 v2였던 건수. 재실행이 안전하다는 근거(멱등). */
  readonly skippedAlreadyV2: number;
  /** manifest에 있지만 대상 행이 사라진 건수. */
  readonly skippedMissing: number;
  /** v2 제약을 아직 만족하지 못해 건너뛴 건수. DB가 막기 전에 우리가 멈춘 수다. */
  readonly skippedBlocked: number;
  /** 사람 검토로 남긴 건수(자동 적용 대상이 아님). */
  readonly review: number;
}

export interface MoneyRepairRevertStats {
  readonly batchId: string;
  readonly reverted: number;
  /** 적용 후 사용자가 손대 되돌리지 않은 건수. 덮어쓰지 않는다. */
  readonly blocked: number;
  readonly skippedNotApplied: number;
}

/**
 * 수리 배치의 적용·되돌림.
 *
 * 계획(manifest) 생성은 sink가 하고, 여기서는 **이미 기록된 계획만** 다룬다. 계획과
 * 적용을 한 트랜잭션에 묶지 않는 것이 ADR §2·§3의 요구다 — 사람이 dry-run 결과를 보고
 * 적용을 결정하는 구간이 사이에 있어야 한다.
 */
export class TransactionMoneyRepairService {
  constructor(
    private readonly db: DbExecutor,
    private readonly logger?: MoneyRepairLogger,
  ) {}

  /**
   * 배치의 auto 행을 적용한다 — **`money_contract_version`만 v2로 올린다.**
   *
   * 행마다 짧은 트랜잭션을 잡고, 그 안에서 대상 행을 `FOR UPDATE`로 다시 읽어 체크섬을
   * 대조한다. manifest를 만든 뒤 사용자가 그 거래를 수정했다면 체크섬이 달라지고, 그
   * 행은 건너뛴다(ADR §3: "dry-run 결과를 그대로 믿지 않고 적용 직전에 다시 읽는다").
   *
   * 멱등하다: 이미 v2인 행은 `skippedAlreadyV2`로 세고 아무것도 쓰지 않는다. 배치가
   * 중간에 끊겨도 같은 명령을 다시 돌리면 된다.
   */
  async applyBatch(batchId: string): Promise<MoneyRepairApplyStats> {
    const entries = await this.db
      .select({
        id: schema.transactionMoneyRepairLog.id,
        transactionId: schema.transactionMoneyRepairLog.transactionId,
        reason: schema.transactionMoneyRepairLog.reason,
        checksumBefore: schema.transactionMoneyRepairLog.checksumBefore,
        afterMoney: schema.transactionMoneyRepairLog.afterMoney,
      })
      .from(schema.transactionMoneyRepairLog)
      .where(
        and(
          eq(schema.transactionMoneyRepairLog.batchId, batchId),
          isNull(schema.transactionMoneyRepairLog.appliedAt),
        ),
      )
      .orderBy(schema.transactionMoneyRepairLog.transactionId);

    let applied = 0;
    let skippedStale = 0;
    let skippedAlreadyV2 = 0;
    let skippedMissing = 0;
    let skippedBlocked = 0;
    let review = 0;

    for (const entry of entries) {
      if (!entry.reason.startsWith(`${MONEY_REPAIR_REASON_PREFIX}auto:`)) {
        review += 1;
        continue;
      }

      const outcome = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.id, entry.transactionId))
          .for('update')
          .limit(1);
        if (!row) return 'missing' as const;
        if (row.moneyContractVersion >= MONEY_CONTRACT_VERSION_V2) return 'already' as const;

        // 적용 직전 재확인. manifest가 낡았으면 이 체인은 통째로 건너뛴다.
        const current = transactionMoneyChecksum(row as TransactionMoneyRowLike);
        if (current !== entry.checksumBefore) return 'stale' as const;

        // 계획 이후 제약 상황이 달라졌을 수 있고, 무엇보다 **DB가 막기 전에 우리가
        // 멈춰야** 한다. 여기서 던지면 남은 행이 통째로 날아가고 앞선 행만 커밋된
        // 반쪽 배치가 남는다(2026-09-03에 실제로 그렇게 57건이 남았다).
        if (
          v2ConstraintViolations(row as unknown as TransactionMoneyV2CheckRowLike).length > 0
        ) {
          return 'blocked' as const;
        }

        // evidence 모드는 증빙 컬럼을 함께 채운다. 금액 축은 계획 단계에서 동일함을
        // 확인했고, 여기서 한 번 더 본다 — 계획과 적용 사이에 행이 바뀌었을 수 있다.
        const evidence = entry.reason.startsWith(`${MONEY_REPAIR_REASON_PREFIX}auto:evidence:`)
          ? (entry.afterMoney as Record<string, unknown> | null)
          : null;
        if (evidence && !planKeepsMoneyIdentity(row as TransactionMoneyRowLike, evidence)) {
          return 'blocked' as const;
        }

        const patch: Record<string, unknown> = {
          moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
        };
        if (evidence) {
          for (const column of MONEY_EVIDENCE_COLUMNS) {
            const before = (row as unknown as Record<string, unknown>)[column] ?? null;
            const after = evidence[column] ?? null;
            if (before === null && after !== null) patch[column] = after;
          }
        }

        await tx
          .update(schema.cardTransactions)
          .set(patch)
          .where(eq(schema.cardTransactions.id, entry.transactionId));

        // 적용 후 이미지로 checksumAfter를 만든다 — 되돌릴 때 "그 뒤로 사용자가
        // 손댔는지"를 보는 값이라 반드시 **적용 결과**에서 계산해야 한다.
        const after = transactionMoneyChecksum({
          ...(row as TransactionMoneyRowLike),
          ...patch,
        } as TransactionMoneyRowLike);
        await tx
          .update(schema.transactionMoneyRepairLog)
          .set({ appliedAt: new Date(), checksumAfter: after })
          .where(eq(schema.transactionMoneyRepairLog.id, entry.id));

        return 'applied' as const;
      });

      if (outcome === 'applied') applied += 1;
      else if (outcome === 'stale') skippedStale += 1;
      else if (outcome === 'already') skippedAlreadyV2 += 1;
      else if (outcome === 'blocked') skippedBlocked += 1;
      else skippedMissing += 1;
    }

    const stats = {
      batchId,
      applied,
      skippedStale,
      skippedAlreadyV2,
      skippedMissing,
      skippedBlocked,
      review,
    };
    this.logger?.info({ ...stats }, 'money repair batch applied');
    return stats;
  }

  /**
   * 배치를 역순으로 되돌린다.
   *
   * `checksumAfter`가 현재 행과 다르면 **되돌리지 않는다.** 적용 후 사용자가 그 거래를
   * 손댔다는 뜻이고, 자동 되돌림이 그 수정을 덮어쓰는 것보다 멈추는 편이 안전하다
   * (ADR §4). 멈춘 이유는 `revert_blocked_reason`에 남겨 사람이 병합하게 한다.
   */
  async revertBatch(batchId: string): Promise<MoneyRepairRevertStats> {
    const entries = await this.db
      .select({
        id: schema.transactionMoneyRepairLog.id,
        transactionId: schema.transactionMoneyRepairLog.transactionId,
        beforeMoney: schema.transactionMoneyRepairLog.beforeMoney,
        checksumAfter: schema.transactionMoneyRepairLog.checksumAfter,
      })
      .from(schema.transactionMoneyRepairLog)
      .where(
        and(
          eq(schema.transactionMoneyRepairLog.batchId, batchId),
          isNotNull(schema.transactionMoneyRepairLog.appliedAt),
          isNull(schema.transactionMoneyRepairLog.revertedAt),
        ),
      )
      // 적용의 역순. 체인 안에서 순서가 뒤집혀야 중간 상태가 불변식을 깨지 않는다.
      .orderBy(sql`${schema.transactionMoneyRepairLog.transactionId} desc`);

    let reverted = 0;
    let blocked = 0;
    let skippedNotApplied = 0;

    for (const entry of entries) {
      if (!entry.checksumAfter) {
        skippedNotApplied += 1;
        continue;
      }
      const before = entry.beforeMoney as Record<string, unknown> | null;
      const targetVersion = before?.moneyContractVersion as number | undefined;
      if (typeof targetVersion !== 'number') {
        skippedNotApplied += 1;
        continue;
      }

      const outcome = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.id, entry.transactionId))
          .for('update')
          .limit(1);
        if (!row) return 'blocked' as const;

        const current = transactionMoneyChecksum(row as TransactionMoneyRowLike);
        if (current !== entry.checksumAfter) return 'blocked' as const;

        // before 이미지의 보호 컬럼을 통째로 되돌린다 — evidence 모드가 채운 증빙
        // 컬럼도 함께 원복해야 "적용 전 상태"가 된다. 버전만 내리면 스냅샷 id가 남는다.
        const restore: Record<string, unknown> = { moneyContractVersion: targetVersion };
        for (const column of MONEY_EVIDENCE_COLUMNS) {
          restore[column] =
            (before as Record<string, unknown>)[column] ?? null;
        }
        await tx
          .update(schema.cardTransactions)
          .set(restore)
          .where(eq(schema.cardTransactions.id, entry.transactionId));
        await tx
          .update(schema.transactionMoneyRepairLog)
          .set({ revertedAt: new Date() })
          .where(eq(schema.transactionMoneyRepairLog.id, entry.id));
        return 'reverted' as const;
      });

      if (outcome === 'reverted') {
        reverted += 1;
        continue;
      }
      blocked += 1;
      await this.db
        .update(schema.transactionMoneyRepairLog)
        .set({
          revertBlockedReason:
            'checksum mismatch after apply — user edited this transaction; merge by hand',
        })
        .where(eq(schema.transactionMoneyRepairLog.id, entry.id));
    }

    const stats = { batchId, reverted, blocked, skippedNotApplied };
    this.logger?.warn({ ...stats }, 'money repair batch reverted');
    return stats;
  }
}

/** 새 배치 id. 호출부가 `randomUUID`를 직접 부르지 않게 해 배치 경계를 한 곳에 둔다. */
export function newRepairBatchId(): string {
  return randomUUID();
}
