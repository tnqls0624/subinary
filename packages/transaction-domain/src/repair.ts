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
  type DbExecutor,
  type TransactionMoneyRowLike,
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
 * 판정 → 처리 등급. 순수 함수다(테스트가 DB 없이 전 판정을 훑는다).
 *
 * `auto`는 "버전 스탬프만 찍는다"는 뜻이지 "계획을 적용한다"가 아니다. 이 구분이
 * 무너지면 `link_manual_only`가 사람 연결을 끊는다(위 머리주석 참고).
 */
export function classifyRepairEligibility(
  verdict: MoneyShadowVerdict,
): MoneyRepairEligibility {
  return MONEY_REPAIR_AUTO_VERDICTS.includes(verdict) ? 'auto' : 'review';
}

/**
 * 수리 로그의 `action`.
 *
 * 스탬프도 `recalculate_chain`으로 적는다 — "체인을 재계산했더니 같았다"가 실제로 일어난
 * 일이고, enum에 'stamp'를 새로 파면 되돌림·집계 쿼리가 전부 한 값씩 늘어난다.
 */
export function repairAction(record: MoneyShadowRecord): TransactionMoneyRepairAction {
  if (classifyRepairEligibility(record.verdict) === 'auto') return 'recalculate_chain';
  if (record.verdict === 'link_target_differs') return 'link_cancellation';
  if (record.actual.currency.toUpperCase() !== 'KRW') return 'normalize_currency';
  return 'recalculate_chain';
}

/** 진단용 최소 정보. 가맹점명·원문은 넣지 않는다(ADR: 로그에는 집계 수치만). */
function repairNote(record: MoneyShadowRecord, eligibility: MoneyRepairEligibility): string {
  return JSON.stringify({
    eligibility,
    verdict: record.verdict,
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
    const eligibility = classifyRepairEligibility(record.verdict);
    const planned = record.planned;

    // auto는 **스탬프**다: after 이미지는 before에서 계약 버전만 올린 것.
    // review는 관찰기의 계획을 그대로 담아 사람이 before/after를 비교하게 한다.
    const afterMoney =
      eligibility === 'auto'
        ? buildTransactionMoneyImage({
            ...actualRow,
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
      action: repairAction(record),
      reason: `${MONEY_REPAIR_REASON_PREFIX}${eligibility}:${record.verdict}`,
      note: repairNote(record, eligibility),
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
    this.byVerdict.set(record.verdict, (this.byVerdict.get(record.verdict) ?? 0) + 1);

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

        await tx
          .update(schema.cardTransactions)
          .set({ moneyContractVersion: MONEY_CONTRACT_VERSION_V2 })
          .where(eq(schema.cardTransactions.id, entry.transactionId));

        // 적용 후 이미지로 checksumAfter를 만든다 — 되돌릴 때 "그 뒤로 사용자가
        // 손댔는지"를 보는 값이라 반드시 **적용 결과**에서 계산해야 한다.
        const after = transactionMoneyChecksum({
          ...(row as TransactionMoneyRowLike),
          moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
        });
        await tx
          .update(schema.transactionMoneyRepairLog)
          .set({ appliedAt: new Date(), checksumAfter: after })
          .where(eq(schema.transactionMoneyRepairLog.id, entry.id));

        return 'applied' as const;
      });

      if (outcome === 'applied') applied += 1;
      else if (outcome === 'stale') skippedStale += 1;
      else if (outcome === 'already') skippedAlreadyV2 += 1;
      else skippedMissing += 1;
    }

    const stats = { batchId, applied, skippedStale, skippedAlreadyV2, skippedMissing, review };
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
      const before = entry.beforeMoney as { moneyContractVersion?: number } | null;
      const targetVersion = before?.moneyContractVersion;
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

        await tx
          .update(schema.cardTransactions)
          .set({ moneyContractVersion: targetVersion })
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
