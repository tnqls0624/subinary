/**
 * shadow 관찰기 — 기존 쓰기 경로가 만든 거래 하나를 **커밋 후에** 읽어 새 계약과
 * 대조한다 (ADR-0027 롤아웃 3단계).
 *
 * ## 왜 쓰기 트랜잭션 안이 아니라 커밋 뒤인가
 *
 * 1. shadow가 기존 경로를 실패시키면 안 된다. 같은 트랜잭션에 얹으면 shadow의 조회
 *    하나가 롤백을 일으켜 **사용자 쓰기가 사라진다.** 이번 라운드의 전제("동작이
 *    하나도 바뀌면 안 된다")를 정면으로 어긴다.
 * 2. 커밋된 행을 다시 읽으면 경로마다 다른 중간 상태를 흉내 낼 필요가 없다. 승격·
 *    수동 입력·사람 검토·거래 수정이 **한 함수**를 부르면 되고, 새 쓰기 경로가
 *    생겨도 한 줄만 추가하면 된다. D-2·D-3이 "새 진입점이 규약을 복사하지 않아"
 *    생긴 결함이므로, 관측만큼은 진입점 수에 비례하지 않게 만든다.
 *
 * 대가는 관측이 유실될 수 있다는 것(프로세스가 커밋 직후 죽는 경우)이고, 그건
 * 기록 실패 카운트와 함께 리포트에 남긴다.
 */
import {
  schema,
  type DbExecutor,
  type TransactionMoneyRowLike,
} from '@family/database';
import { and, eq, lte } from 'drizzle-orm';

import type { FxSnapshotResolver } from './fx-snapshot-store.js';
import { fxBaseDate } from './money-math.js';
import {
  planChain,
  selectCancellationParent,
  type CancellationCandidate,
  type ChainCancellationInput,
  type FxSnapshotRef,
  type MoneyColumns,
  type MoneyRejectionReason,
} from './plan.js';
import { classifyMoneyShadow, type MoneyShadowActual, type MoneyShadowPath } from './shadow.js';
import type { TransactionMoneyShadowSink } from './shadow-sink.js';
import { MONEY_ROW_COLUMNS, toCandidate, type MoneyRow } from './transaction-money.service.js';

export class TransactionMoneyShadowObserver {
  constructor(
    private readonly db: DbExecutor,
    private readonly fxSnapshots: FxSnapshotResolver,
    private readonly sink: TransactionMoneyShadowSink,
  ) {}

  /**
   * 거래 하나를 관측한다. **절대 던지지 않는다** — 호출부는 `void observe(...)`로
   * 부르고 결과를 기다리지 않아도 된다.
   */
  async observe(transactionId: string, path: MoneyShadowPath): Promise<void> {
    try {
      await this.observeOrThrow(transactionId, path);
    } catch {
      // 여기까지 온 예외는 sink가 아니라 조회·계획 단계의 것이다. sink가 자체적으로
      // 삼키므로 카운트는 그쪽에 남고, 여기서는 기존 경로를 지키는 것만 한다.
    }
  }

  private async observeOrThrow(transactionId: string, path: MoneyShadowPath): Promise<void> {
    const row = await this.loadRow(transactionId);
    if (!row) return;
    if (row.transactionType !== 'approval' && row.transactionType !== 'cancellation') return;

    const { planned, failureReason, plannedParent } =
      row.transactionType === 'approval'
        ? await this.planApprovalRow(row)
        : await this.planCancellationRow(row);

    const record = classifyMoneyShadow({
      path,
      householdId: row.householdId,
      transactionId: row.id,
      sourceEventId: row.sourceEventId,
      transactionType: row.transactionType,
      actual: toActual(row),
      planned,
      failureReason,
      ...(plannedParent === undefined ? {} : { plannedParentTransactionId: plannedParent }),
    });

    await this.sink.record(record, toRowLike(row));
  }

  /* ---------------------------------------------------------------------- */

  /** 승인 행: 자기 체인(자기 + 연결된 취소들)을 새 계약으로 다시 계획한다. */
  private async planApprovalRow(row: MoneyRow): Promise<PlanOutcome> {
    const snapshot = await this.snapshotFor(row);
    if (snapshot.kind === 'rejected') {
      return { planned: null, failureReason: snapshot.reason, plannedParent: undefined };
    }

    const children = await this.db
      .select(MONEY_ROW_COLUMNS)
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.parentTransactionId, row.id))
      .orderBy(schema.cardTransactions.id);

    const inputs: ChainCancellationInput[] = children.map((child) => ({
      id: child.id,
      minorUnits: child.originalAmount ?? child.amount,
      currency: (child.originalCurrency ?? child.currency).toUpperCase(),
    }));

    const plan = planChain(
      {
        minorUnits: row.originalAmount ?? row.amount,
        currency: (row.originalCurrency ?? row.currency).toUpperCase(),
        snapshot: snapshot.ref,
        reviewFlag: reviewFlagOf(row.status),
      },
      inputs,
    );
    return plan.ok
      ? { planned: plan.value.approval, failureReason: null, plannedParent: undefined }
      : { planned: null, failureReason: plan.reason, plannedParent: undefined };
  }

  /**
   * 취소 행: 부모 체인 안에서 이 취소가 가질 컬럼을 계획하고, **연결 대상 자체도**
   * 새 후보 규칙으로 다시 고른다.
   *
   * 이미 연결된 취소도 후보 판정을 돌린다. 새 규칙은 증거(승인번호 또는 가맹점,
   * 취소시각)가 없으면 연결하지 않으므로 **기존이 붙인 것을 새 규칙은 안 붙일 수도**
   * 있고, 그 미탐이야말로 전환 전에 알아야 할 값이다. 그러려면 부모의 잔액을 이
   * 취소가 반영되기 **전 상태로 되돌려** 후보에 넣어야 한다 — 안 그러면 부모가
   * 이미 잔액이 깎여 자기 자신의 후보에서 탈락한다.
   */
  private async planCancellationRow(row: MoneyRow): Promise<PlanOutcome> {
    const parentId = row.parentTransactionId;
    const parent = parentId ? await this.loadRow(parentId) : null;

    const plannedParent = await this.selectParent(row, parent);

    if (!parent) {
      // 미연결 취소는 취소 기준일 스냅샷으로 잠정 표시값만 갖는다(ADR §4).
      const snapshot = await this.snapshotFor(row);
      if (snapshot.kind === 'rejected') {
        return { planned: null, failureReason: snapshot.reason, plannedParent };
      }
      const plan = planChain(
        {
          minorUnits: row.originalAmount ?? row.amount,
          currency: (row.originalCurrency ?? row.currency).toUpperCase(),
          snapshot: snapshot.ref,
          reviewFlag: 'pending_review',
        },
        [],
      );
      if (!plan.ok) return { planned: null, failureReason: plan.reason, plannedParent };
      return {
        planned: {
          ...plan.value.approval,
          cancelledAmount: 0,
          originalCancelledAmount: null,
          netAmount: 0,
          status: 'pending_review',
        },
        failureReason: null,
        plannedParent,
      };
    }

    const snapshot = await this.snapshotFor(parent);
    if (snapshot.kind === 'rejected') {
      return { planned: null, failureReason: snapshot.reason, plannedParent };
    }

    const siblings = await this.db
      .select(MONEY_ROW_COLUMNS)
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.parentTransactionId, parent.id))
      .orderBy(schema.cardTransactions.id);

    const plan = planChain(
      {
        minorUnits: parent.originalAmount ?? parent.amount,
        currency: (parent.originalCurrency ?? parent.currency).toUpperCase(),
        snapshot: snapshot.ref,
        reviewFlag: reviewFlagOf(parent.status),
      },
      siblings.map((sibling) => ({
        id: sibling.id,
        minorUnits: sibling.originalAmount ?? sibling.amount,
        currency: (sibling.originalCurrency ?? sibling.currency).toUpperCase(),
      })),
    );
    if (!plan.ok) return { planned: null, failureReason: plan.reason, plannedParent };

    const mine = plan.value.cancellations.find((planned) => planned.id === row.id);
    if (!mine) return { planned: null, failureReason: 'invalid_amount', plannedParent };
    return {
      planned: { ...mine.columns, parentTransactionId: parent.id },
      failureReason: null,
      plannedParent,
    };
  }

  /**
   * 새 후보 규칙이 고를 부모. 판정 자체가 불가능하면(증거 부족) `null`을 돌려주므로
   * 기존이 연결해 둔 취소는 `link_target_differs`로 잡힌다 — 의도한 결과다.
   */
  private async selectParent(row: MoneyRow, parent: MoneyRow | null): Promise<string | null> {
    const cancelledAt = row.cancelledAt;
    if (!cancelledAt) return null;

    const rows = await this.db
      .select(MONEY_ROW_COLUMNS)
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.householdId, row.householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          // `selectCancellationParent`와 **같은 경계**여야 한다(같은 시각 포함).
          // 여기만 `lt`로 좁히면 shadow가 실제 판정보다 후보를 적게 보고, 그러면
          // 관측이 "차이 없음"이라 답하는데 실제 동작은 다른 상태가 된다.
          lte(schema.cardTransactions.approvedAt, cancelledAt),
        ),
      );

    const candidates: CancellationCandidate[] = rows.map((candidate) =>
      parent && candidate.id === parent.id ? unapply(candidate, row) : toCandidate(candidate),
    );

    const match = selectCancellationParent(
      {
        cardId: row.cardId,
        currency: (row.originalCurrency ?? row.currency).toUpperCase(),
        minorUnits: row.originalAmount ?? row.amount,
        cancelledAt,
        authorizationCode: row.authorizationCode,
        merchantNormalized: row.merchantNormalized,
      },
      candidates,
    );
    return match.kind === 'unique' ? match.approval.id : null;
  }

  private async snapshotFor(
    row: MoneyRow,
  ): Promise<
    | { kind: 'ok'; ref: FxSnapshotRef | null }
    | { kind: 'rejected'; reason: MoneyRejectionReason }
  > {
    const currency = (row.originalCurrency ?? row.currency).toUpperCase();
    if (currency === 'KRW') return { kind: 'ok', ref: null };

    // 이미 스냅샷이 붙어 있으면 그것이 이 거래의 환율이다(v2 행). 없으면 기준일로 찾는다.
    if (row.fxRateSnapshotId) {
      const byId = await this.fxSnapshots.findById(row.fxRateSnapshotId);
      if (byId) return { kind: 'ok', ref: byId };
    }
    const basis = row.approvedAt ?? row.cancelledAt;
    // 기준일을 만들 시각이 아무것도 없으면 `new Date()`로 때우지 않는다 — 그게 D-1이다.
    if (!basis) return { kind: 'rejected', reason: 'fx_snapshot_missing' };

    const found = await this.fxSnapshots.find({
      baseCurrency: currency,
      asOfDate: fxBaseDate(basis, basis),
    });
    return found
      ? { kind: 'ok', ref: found }
      : { kind: 'rejected', reason: 'fx_snapshot_missing' };
  }

  private async loadRow(id: string): Promise<MoneyRow | null> {
    const [row] = await this.db
      .select(MONEY_ROW_COLUMNS)
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.id, id))
      .limit(1);
    return row ?? null;
  }
}

interface PlanOutcome {
  readonly planned: MoneyColumns | null;
  readonly failureReason: MoneyRejectionReason | null;
  /** `undefined` = 연결 판정을 하지 않음(승인 행). `null` = "붙을 승인 없음" 판정. */
  readonly plannedParent: string | null | undefined;
}

/**
 * 부모 승인을 **이 취소가 반영되기 전** 상태로 되돌린 후보. 후보 판정을 다시 돌릴 때만
 * 쓰는 계산값이며 DB에는 쓰지 않는다.
 */
function unapply(parent: MoneyRow, cancellation: MoneyRow): CancellationCandidate {
  const base = toCandidate(parent);
  if (parent.originalCurrency && parent.originalAmount !== null) {
    const restored = Math.max(
      0,
      (parent.originalCancelledAmount ?? 0) - (cancellation.originalAmount ?? 0),
    );
    return {
      ...base,
      originalCancelledAmount: restored,
      status: restored > 0 ? 'partially_cancelled' : 'approved',
    };
  }
  const restored = Math.max(0, parent.cancelledAmount - cancellation.amount);
  return {
    ...base,
    cancelledAmount: restored,
    status: restored > 0 ? 'partially_cancelled' : 'approved',
  };
}

function toActual(row: MoneyRow): MoneyShadowActual {
  return {
    amount: row.amount,
    currency: row.currency,
    originalAmount: row.originalAmount,
    originalCurrency: row.originalCurrency,
    cancelledAmount: row.cancelledAmount,
    originalCancelledAmount: row.originalCancelledAmount,
    netAmount: row.netAmount,
    parentTransactionId: row.parentTransactionId,
    status: row.status,
    moneyContractVersion: row.moneyContractVersion,
  };
}

function toRowLike(row: MoneyRow): TransactionMoneyRowLike {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    originalAmount: row.originalAmount,
    originalCurrency: row.originalCurrency,
    exchangeRate: row.exchangeRate,
    fxRateSnapshotId: row.fxRateSnapshotId,
    cancelledAmount: row.cancelledAmount,
    originalCancelledAmount: row.originalCancelledAmount,
    netAmount: row.netAmount,
    parentTransactionId: row.parentTransactionId,
    status: row.status,
    moneyContractVersion: row.moneyContractVersion,
    approvedAt: row.approvedAt,
  };
}

function reviewFlagOf(status: string): 'pending_review' | 'duplicate_suspected' | null {
  return status === 'pending_review' || status === 'duplicate_suspected' ? status : null;
}
