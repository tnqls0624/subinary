/**
 * `TransactionMoneyService` — 금액 쓰기의 유일한 초크포인트 (ADR-0027 결정 §1·§2).
 *
 * ⚠️ **롤아웃 3단계(shadow)인 지금, 이 실행기를 호출하는 운영 경로는 없다.**
 * 기존 승격·수동 입력·사람 검토·거래 수정은 그대로 자기 쓰기를 하고, 새 계약은
 * {@link TransactionMoneyShadowObserver}가 계획만 세워 대조한다. 이 파일은 enforce
 * 전환(5단계)에서 그 경로들이 옮겨 탈 자리이고, 지금은 계약을 코드로 확정해 두는
 * 것이 목적이다 — 계약이 문서에만 있으면 전환 때 또 각자 해석한다.
 *
 * ## 왜 앱이 아니라 공유 패키지인가
 *
 * ADR §1: "API와 worker는 같은 구현을 가져다 쓰며 한 앱의 Nest 서비스에 다른 앱이
 * 의존하지 않는다." 그래서 이 클래스에는 Nest 데코레이터가 없다. 각 앱이 얇은
 * provider로 감싼다.
 *
 * ## 잠금 순서 — 이미 배포된 규약을 그대로 따른다
 *
 * `apps/api/.../transaction.service.ts`의 `linkCancellation`·`remove`와
 * `apps/worker/.../transaction-promotion.service.ts`의 `promoteCancellation`은
 * **승인 → 취소** 순으로 `FOR UPDATE`를 잡는다. 여기서도 같다. 승인이 여럿이면
 * (부모를 바꾸는 재연결) id 오름차순이다(ADR §2). 한 경로라도 반대로 잠그면 교차 시
 * 데드락이므로, 순서는 {@link orderedLockIds} 한 곳에서만 정한다.
 */
import {
  MONEY_CONTRACT_VERSION_V2,
  schema,
  type Db,
  type DbExecutor,
} from '@family/database';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { fxBaseDate } from './money-math.js';
import {
  orderedLockIds,
  planChain,
  selectCancellationParent,
  type CancellationCandidate,
  type CancellationEvidence,
  type CancellationMatch,
  type ChainCancellationInput,
  type FxSnapshotRef,
  type MoneyColumns,
  type MoneyRejectionReason,
  type MoneyReviewFlag,
} from './plan.js';
import type { FxSnapshotResolver } from './fx-snapshot-store.js';

export type MoneyCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: MoneyRejectionReason | MoneyCommandRejection };

/** 계획 이전 단계에서 명령을 거부하는 사유. */
export type MoneyCommandRejection =
  /** 대상 거래가 없다. */
  | 'transaction_not_found'
  /** 대상이 기대한 종류가 아니다(승인에 취소 명령 등). */
  | 'transaction_type_mismatch'
  /** 이미 다른 승인에 연결된 취소다. */
  | 'cancellation_already_linked'
  /** 승인과 취소가 다른 가구다. */
  | 'household_mismatch';

export interface MoneyCommandOptions {
  /**
   * 호출자가 이미 연 트랜잭션. ADR §1이 요구하는 대로 검토 라벨·원문 이벤트 갱신과
   * 금액 반영을 한 트랜잭션으로 묶을 때 넘긴다. 없으면 서비스가 직접 연다.
   */
  readonly tx?: DbExecutor;
}

/** 금액 명령에 함께 넘기는 비금액 메타데이터. 이 값들은 서비스가 계산하지 않는다. */
export interface TransactionMetadata {
  readonly householdId: string;
  readonly memberId: string;
  readonly cardId: string | null;
  readonly sourceEventId: string;
  readonly merchantRaw: string | null;
  readonly merchantNormalized: string | null;
  readonly categoryId: string | null;
  readonly authorizationCode: string | null;
  readonly installmentMonths: number | null;
  readonly visibility: 'private' | 'household' | 'summary_only';
  readonly memo: string | null;
}

export interface CreateApprovalCommand {
  readonly metadata: TransactionMetadata;
  /** 원통화 minor units. */
  readonly minorUnits: number;
  readonly currency: string;
  /** 거래시각. 없으면 `receivedAt`이 환율 기준일이 된다(ADR §3). */
  readonly occurredAt: Date | null;
  /** 원문 수신 시각 — `occurredAt`이 없을 때의 기준일 근거. */
  readonly receivedAt: Date;
  readonly reviewFlag?: MoneyReviewFlag | null;
}

export interface CreateCancellationCommand extends CreateApprovalCommand {
  /**
   * 자동 후보 탐색을 건너뛰고 이 승인에 바로 연결한다(사람이 고른 경우).
   * 없으면 ADR §4 필터로 유일 후보를 찾는다.
   */
  readonly parentTransactionId?: string | null;
}

export interface CancellationOutcome {
  readonly transactionId: string;
  /** 이미 같은 `sourceEventId`로 만들어진 거래가 있어 아무것도 하지 않았다. */
  readonly alreadyPromoted: boolean;
  readonly match: CancellationMatch['kind'];
  readonly parentTransactionId: string | null;
}

/** 체인 재계산 결과 — 무엇이 어떻게 바뀌었는지 호출자가 로그로 남길 수 있게 돌려준다. */
export interface ChainOutcome {
  readonly approvalId: string;
  readonly approval: MoneyColumns;
  readonly cancellations: readonly { readonly id: string; readonly columns: MoneyColumns }[];
}

/** 서비스가 읽고 쓰는 금액 관련 컬럼 묶음. */
export interface MoneyRow {
  id: string;
  householdId: string;
  cardId: string | null;
  transactionType: string;
  status: string;
  amount: number;
  currency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  exchangeRate: number | null;
  fxRateSnapshotId: string | null;
  cancelledAmount: number;
  originalCancelledAmount: number | null;
  netAmount: number;
  parentTransactionId: string | null;
  approvedAt: Date | null;
  cancelledAt: Date | null;
  authorizationCode: string | null;
  merchantNormalized: string | null;
  moneyContractVersion: number;
  sourceEventId: string;
}

export const MONEY_ROW_COLUMNS = {
  id: schema.cardTransactions.id,
  householdId: schema.cardTransactions.householdId,
  cardId: schema.cardTransactions.cardId,
  transactionType: schema.cardTransactions.transactionType,
  status: schema.cardTransactions.status,
  amount: schema.cardTransactions.amount,
  currency: schema.cardTransactions.currency,
  originalAmount: schema.cardTransactions.originalAmount,
  originalCurrency: schema.cardTransactions.originalCurrency,
  exchangeRate: schema.cardTransactions.exchangeRate,
  fxRateSnapshotId: schema.cardTransactions.fxRateSnapshotId,
  cancelledAmount: schema.cardTransactions.cancelledAmount,
  originalCancelledAmount: schema.cardTransactions.originalCancelledAmount,
  netAmount: schema.cardTransactions.netAmount,
  parentTransactionId: schema.cardTransactions.parentTransactionId,
  approvedAt: schema.cardTransactions.approvedAt,
  cancelledAt: schema.cardTransactions.cancelledAt,
  authorizationCode: schema.cardTransactions.authorizationCode,
  merchantNormalized: schema.cardTransactions.merchantNormalized,
  moneyContractVersion: schema.cardTransactions.moneyContractVersion,
  sourceEventId: schema.cardTransactions.sourceEventId,
} as const;

export class TransactionMoneyService {
  constructor(
    private readonly db: Db,
    private readonly fxSnapshots: FxSnapshotResolver,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* 생성                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * 승인을 만든다. 외화는 **거래일 스냅샷**으로 환산하고, 스냅샷이 없으면 만들지
   * 않는다 — 오늘 환율로 대체하지 않는 것이 ADR §3의 핵심이다.
   *
   * 멱등: `sourceEventId` UNIQUE + `onConflictDoNothing`. 재시도가 승인을 두 번
   * 만들지 않는다.
   */
  async createApproval(
    command: CreateApprovalCommand,
    options?: MoneyCommandOptions,
  ): Promise<MoneyCommandResult<{ transactionId: string; alreadyPromoted: boolean }>> {
    const snapshot = await this.resolveSnapshot(command);
    if (snapshot.kind === 'rejected') return { ok: false, reason: snapshot.reason };

    const plan = planChain(
      {
        minorUnits: command.minorUnits,
        currency: command.currency,
        snapshot: snapshot.ref,
        reviewFlag: command.reviewFlag ?? null,
      },
      [],
    );
    if (!plan.ok) return { ok: false, reason: plan.reason };

    return this.run(options, async (tx) => {
      const [inserted] = await tx
        .insert(schema.cardTransactions)
        .values({
          ...metadataValues(command.metadata),
          transactionType: 'approval',
          ...plan.value.approval,
          status: plan.value.approval.status,
          approvedAt: command.occurredAt,
          cancelledAt: null,
        })
        .onConflictDoNothing({ target: schema.cardTransactions.sourceEventId })
        .returning({ id: schema.cardTransactions.id });

      if (inserted) {
        return { ok: true as const, value: { transactionId: inserted.id, alreadyPromoted: false } };
      }
      const existing = await this.findBySourceEvent(tx, command.metadata.sourceEventId);
      return existing
        ? { ok: true as const, value: { transactionId: existing.id, alreadyPromoted: true } }
        : { ok: false as const, reason: 'transaction_not_found' as const };
    });
  }

  /**
   * 취소를 만들고 대응 승인에 연결한다.
   *
   * 취소 행 삽입 → 승인 잠금 → 체인 재계산 → 취소 행 claim → 승인 갱신 순서를
   * 지킨다. claim(`parent_transaction_id IS NULL` 조건부 UPDATE)을 승인 갱신보다
   * 먼저 두는 이유는 기존 승격 경로와 같다 — "연결되지 않았는데 잔액만 깎이는"
   * 상태가 어떤 경로로도 생기지 않게 한다.
   */
  async createCancellation(
    command: CreateCancellationCommand,
    options?: MoneyCommandOptions,
  ): Promise<MoneyCommandResult<CancellationOutcome>> {
    const snapshot = await this.resolveSnapshot(command);
    if (snapshot.kind === 'rejected') return { ok: false, reason: snapshot.reason };

    // 아직 연결되지 않은 취소는 취소 기준일 스냅샷으로 **표시용** KRW를 잠정 기록하되
    // netAmount=0이라 집계에 들어가지 않는다(ADR §4). 연결되는 순간 승인 스냅샷으로
    // 원자적으로 교체된다.
    const provisional = planChain(
      {
        minorUnits: command.minorUnits,
        currency: command.currency,
        snapshot: snapshot.ref,
        reviewFlag: 'pending_review',
      },
      [],
    );
    if (!provisional.ok) return { ok: false, reason: provisional.reason };

    return this.run(options, async (tx) => {
      const [inserted] = await tx
        .insert(schema.cardTransactions)
        .values({
          ...metadataValues(command.metadata),
          transactionType: 'cancellation',
          ...provisional.value.approval,
          // 취소 행의 순액은 언제나 0이다(v2-6). 잠정 표시 금액만 amount에 남는다.
          cancelledAmount: 0,
          originalCancelledAmount: null,
          netAmount: 0,
          status: 'pending_review',
          approvedAt: null,
          cancelledAt: command.occurredAt,
        })
        .onConflictDoNothing({ target: schema.cardTransactions.sourceEventId })
        .returning({ id: schema.cardTransactions.id });

      if (!inserted) {
        const existing = await this.findBySourceEvent(tx, command.metadata.sourceEventId);
        return existing
          ? {
              ok: true as const,
              value: {
                transactionId: existing.id,
                alreadyPromoted: true,
                match: 'none' as const,
                parentTransactionId: existing.parentTransactionId,
              },
            }
          : { ok: false as const, reason: 'transaction_not_found' as const };
      }

      const evidence: CancellationEvidence = {
        cardId: command.metadata.cardId,
        currency: command.currency.toUpperCase(),
        minorUnits: command.minorUnits,
        cancelledAt: command.occurredAt,
        authorizationCode: command.metadata.authorizationCode,
        merchantNormalized: command.metadata.merchantNormalized,
      };

      let match: CancellationMatch;
      if (command.parentTransactionId) {
        const candidate = await this.loadRow(tx, command.parentTransactionId);
        match = candidate
          ? { kind: 'unique', approval: toCandidate(candidate) }
          : { kind: 'none' };
      } else {
        match = selectCancellationParent(
          evidence,
          await this.loadCandidates(tx, command.metadata.householdId),
        );
      }

      if (match.kind !== 'unique') {
        // 자동 연결하지 않는다. 취소 행은 `pending_review`로 남고 승인 잔액은
        // 그대로다 — 조용한 상태 전환이나 느슨한 매칭은 하지 않는다(ADR §2·§4).
        return {
          ok: true as const,
          value: {
            transactionId: inserted.id,
            alreadyPromoted: false,
            match: match.kind,
            parentTransactionId: null,
          },
        };
      }

      const linked = await this.applyLink(tx, match.approval.id, inserted.id);
      if (!linked.ok) return linked;

      return {
        ok: true as const,
        value: {
          transactionId: inserted.id,
          alreadyPromoted: false,
          match: 'unique' as const,
          parentTransactionId: match.approval.id,
        },
      };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 연결 / 해제 / 재연결                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * 사람이 고른 승인에 취소를 연결한다. 이미 다른 승인에 연결돼 있으면 **재연결**로
   * 보고 이전·새 부모를 id 오름차순으로 잠근 뒤 두 체인을 모두 재계산한다(ADR §2).
   */
  async linkCancellation(
    input: { cancellationId: string; approvalId: string },
    options?: MoneyCommandOptions,
  ): Promise<MoneyCommandResult<{ previous: ChainOutcome | null; current: ChainOutcome }>> {
    return this.run(options, async (tx) => {
      const cancellation = await this.loadRow(tx, input.cancellationId);
      if (!cancellation) return { ok: false as const, reason: 'transaction_not_found' as const };
      if (cancellation.transactionType !== 'cancellation') {
        return { ok: false as const, reason: 'transaction_type_mismatch' as const };
      }

      // 이전 부모와 새 부모를 **오름차순으로** 잠근다. 두 재연결이 서로 반대 순서로
      // 잠그면 교착이고, 잠그지 않으면 같은 승인 잔액을 두 번 깎는다.
      const previousParentId = cancellation.parentTransactionId;
      await this.lockInOrder(tx, orderedLockIds([previousParentId, input.approvalId]));

      const approval = await this.loadRow(tx, input.approvalId);
      if (!approval) return { ok: false as const, reason: 'transaction_not_found' as const };
      if (approval.transactionType !== 'approval') {
        return { ok: false as const, reason: 'transaction_type_mismatch' as const };
      }
      if (approval.householdId !== cancellation.householdId) {
        return { ok: false as const, reason: 'household_mismatch' as const };
      }

      const claimed = await tx
        .update(schema.cardTransactions)
        .set({ parentTransactionId: approval.id, updatedAt: new Date() })
        .where(
          and(
            eq(schema.cardTransactions.id, cancellation.id),
            previousParentId
              ? eq(schema.cardTransactions.parentTransactionId, previousParentId)
              : isNull(schema.cardTransactions.parentTransactionId),
          ),
        )
        .returning({ id: schema.cardTransactions.id });
      if (claimed.length === 0) {
        return { ok: false as const, reason: 'cancellation_already_linked' as const };
      }

      // 이전 부모를 먼저 복원한다. 새 부모 재계산이 거부되면 트랜잭션 전체가
      // 롤백되므로 순서가 결과를 바꾸지 않는다.
      let previous: ChainOutcome | null = null;
      if (previousParentId && previousParentId !== approval.id) {
        const restored = await this.recalculateLocked(tx, previousParentId);
        if (!restored.ok) return restored;
        previous = restored.value;
      }
      const current = await this.recalculateLocked(tx, approval.id);
      if (!current.ok) return current;

      return { ok: true as const, value: { previous, current: current.value } };
    });
  }

  /**
   * 연결을 해제하고 승인 잔액을 복원한다. 취소 행은 남되 `pending_review`로 돌아가
   * 사람이 다시 부모를 고르게 한다(자동 재연결은 하지 않는다).
   */
  async unlinkCancellation(
    input: { cancellationId: string },
    options?: MoneyCommandOptions,
  ): Promise<MoneyCommandResult<ChainOutcome | null>> {
    return this.run(options, async (tx) => {
      const cancellation = await this.loadRow(tx, input.cancellationId);
      if (!cancellation) return { ok: false as const, reason: 'transaction_not_found' as const };
      if (cancellation.transactionType !== 'cancellation') {
        return { ok: false as const, reason: 'transaction_type_mismatch' as const };
      }
      const parentId = cancellation.parentTransactionId;
      if (!parentId) return { ok: true as const, value: null };

      await this.lockInOrder(tx, orderedLockIds([parentId]));
      const detached = await tx
        .update(schema.cardTransactions)
        .set({
          parentTransactionId: null,
          status: 'pending_review',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.cardTransactions.id, cancellation.id),
            eq(schema.cardTransactions.parentTransactionId, parentId),
          ),
        )
        .returning({ id: schema.cardTransactions.id });
      // 그 사이 다른 요청이 부모를 바꿨다 — 남의 결과 위에 역산하지 않는다.
      if (detached.length === 0) return { ok: true as const, value: null };

      return this.recalculateLocked(tx, parentId);
    });
  }

  /**
   * 연결된 취소 행을 지우고 승인 잔액을 복원한다.
   * 잠금 순서는 {@link linkCancellation}과 같은 **승인 → 취소**다.
   */
  async removeCancellation(
    input: { cancellationId: string },
    options?: MoneyCommandOptions,
  ): Promise<MoneyCommandResult<ChainOutcome | null>> {
    return this.run(options, async (tx) => {
      const cancellation = await this.loadRow(tx, input.cancellationId);
      if (!cancellation) return { ok: false as const, reason: 'transaction_not_found' as const };
      if (cancellation.transactionType !== 'cancellation') {
        return { ok: false as const, reason: 'transaction_type_mismatch' as const };
      }
      const parentId = cancellation.parentTransactionId;
      if (parentId) await this.lockInOrder(tx, orderedLockIds([parentId]));

      await tx
        .delete(schema.cardTransactions)
        .where(eq(schema.cardTransactions.id, cancellation.id));

      return parentId ? this.recalculateLocked(tx, parentId) : { ok: true as const, value: null };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 수정 / 재계산                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * 승인의 금액·원통화·거래시각을 바꾸고 체인 전체를 재계산한다(ADR §2).
   *
   * 거래시각을 바꾸면 환율 기준일이 바뀌므로 **스냅샷도 다시 고른다**. 새 값이
   * 원통화 취소 누계를 넘기거나 승인-취소 통화를 어긋나게 하면 수정 전체를 거부한다 —
   * 일부만 반영해 체인을 깨진 상태로 두지 않는다.
   */
  async amendApproval(
    input: {
      approvalId: string;
      minorUnits?: number;
      currency?: string;
      occurredAt?: Date | null;
      receivedAt?: Date;
      reviewFlag?: MoneyReviewFlag | null;
    },
    options?: MoneyCommandOptions,
  ): Promise<MoneyCommandResult<ChainOutcome>> {
    return this.run(options, async (tx) => {
      await this.lockInOrder(tx, orderedLockIds([input.approvalId]));
      const approval = await this.loadRow(tx, input.approvalId);
      if (!approval) return { ok: false as const, reason: 'transaction_not_found' as const };
      if (approval.transactionType !== 'approval') {
        return { ok: false as const, reason: 'transaction_type_mismatch' as const };
      }

      const currency = (input.currency ?? approval.originalCurrency ?? approval.currency).toUpperCase();
      const minorUnits = input.minorUnits ?? approval.originalAmount ?? approval.amount;
      const occurredAt = input.occurredAt !== undefined ? input.occurredAt : approval.approvedAt;
      const snapshot = await this.resolveSnapshot({
        currency,
        occurredAt,
        receivedAt: input.receivedAt ?? occurredAt ?? new Date(),
      });
      if (snapshot.kind === 'rejected') return { ok: false as const, reason: snapshot.reason };

      if (input.occurredAt !== undefined) {
        await tx
          .update(schema.cardTransactions)
          .set({ approvedAt: input.occurredAt, updatedAt: new Date() })
          .where(eq(schema.cardTransactions.id, approval.id));
      }

      return this.writeChain(tx, approval.id, {
        minorUnits,
        currency,
        snapshot: snapshot.ref,
        reviewFlag: input.reviewFlag ?? null,
      });
    });
  }

  /**
   * 승인-취소 체인을 현재 저장값에서 다시 계산한다(마이그레이션·수리용).
   * 금액 사실은 바꾸지 않고 파생값(순액·누계·상태)만 계약에 맞춘다.
   */
  async recalculateChain(
    approvalId: string,
    options?: MoneyCommandOptions,
  ): Promise<MoneyCommandResult<ChainOutcome>> {
    return this.run(options, async (tx) => {
      await this.lockInOrder(tx, orderedLockIds([approvalId]));
      return this.recalculateLocked(tx, approvalId);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 내부                                                                    */
  /* ---------------------------------------------------------------------- */

  /** 이미 잠긴 승인의 체인을 저장값 그대로 재계산한다. */
  private async recalculateLocked(
    tx: DbExecutor,
    approvalId: string,
  ): Promise<MoneyCommandResult<ChainOutcome>> {
    const approval = await this.loadRow(tx, approvalId);
    if (!approval) return { ok: false, reason: 'transaction_not_found' };
    if (approval.transactionType !== 'approval') {
      return { ok: false, reason: 'transaction_type_mismatch' };
    }

    const currency = (approval.originalCurrency ?? approval.currency).toUpperCase();
    const minorUnits = approval.originalAmount ?? approval.amount;
    const snapshot = approval.fxRateSnapshotId
      ? await this.fxSnapshots.findById(approval.fxRateSnapshotId)
      : null;
    if (approval.originalCurrency && !snapshot) {
      return { ok: false, reason: 'fx_snapshot_missing' };
    }

    return this.writeChain(tx, approvalId, {
      minorUnits,
      currency,
      snapshot,
      reviewFlag: reviewFlagOf(approval.status),
    });
  }

  /** 체인을 계획하고 승인·취소 행에 반영한다. 거부되면 아무것도 쓰지 않는다. */
  private async writeChain(
    tx: DbExecutor,
    approvalId: string,
    approvalInput: {
      minorUnits: number;
      currency: string;
      snapshot: FxSnapshotRef | null;
      reviewFlag: MoneyReviewFlag | null;
    },
  ): Promise<MoneyCommandResult<ChainOutcome>> {
    const children = await this.loadLinkedCancellations(tx, approvalId);
    const inputs: ChainCancellationInput[] = children.map((child) => ({
      id: child.id,
      minorUnits: child.originalAmount ?? child.amount,
      currency: (child.originalCurrency ?? child.currency).toUpperCase(),
    }));

    const plan = planChain(approvalInput, inputs);
    if (!plan.ok) return { ok: false, reason: plan.reason };

    const now = new Date();
    await tx
      .update(schema.cardTransactions)
      .set({ ...plan.value.approval, parentTransactionId: null, updatedAt: now })
      .where(eq(schema.cardTransactions.id, approvalId));

    for (const planned of plan.value.cancellations) {
      await tx
        .update(schema.cardTransactions)
        .set({ ...planned.columns, parentTransactionId: approvalId, updatedAt: now })
        .where(eq(schema.cardTransactions.id, planned.id));
    }

    return {
      ok: true,
      value: {
        approvalId,
        approval: plan.value.approval,
        cancellations: plan.value.cancellations,
      },
    };
  }

  /** 취소 행을 claim한 뒤 승인 체인을 재계산한다. */
  private async applyLink(
    tx: DbExecutor,
    approvalId: string,
    cancellationId: string,
  ): Promise<MoneyCommandResult<ChainOutcome>> {
    await this.lockInOrder(tx, orderedLockIds([approvalId]));
    const claimed = await tx
      .update(schema.cardTransactions)
      .set({ parentTransactionId: approvalId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.cardTransactions.id, cancellationId),
          isNull(schema.cardTransactions.parentTransactionId),
        ),
      )
      .returning({ id: schema.cardTransactions.id });
    if (claimed.length === 0) {
      return { ok: false, reason: 'cancellation_already_linked' };
    }
    return this.recalculateLocked(tx, approvalId);
  }

  /**
   * 주어진 id들을 **정렬된 순서대로 하나씩** `FOR UPDATE`로 잡는다.
   *
   * `IN (...)` 한 문장으로 잠그지 않는 이유: Postgres가 행을 잠그는 순서는 실행
   * 계획이 정하며 보장되지 않는다. 순서를 보장하려면 문장을 나눠야 한다.
   */
  private async lockInOrder(tx: DbExecutor, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await tx
        .select({ id: schema.cardTransactions.id })
        .from(schema.cardTransactions)
        .where(eq(schema.cardTransactions.id, id))
        .for('update')
        .limit(1);
    }
  }

  private async resolveSnapshot(input: {
    currency: string;
    occurredAt: Date | null;
    receivedAt: Date;
  }): Promise<
    | { kind: 'krw'; ref: null }
    | { kind: 'resolved'; ref: FxSnapshotRef }
    | { kind: 'rejected'; reason: MoneyRejectionReason }
  > {
    const currency = input.currency.toUpperCase();
    if (currency === 'KRW') return { kind: 'krw', ref: null };

    const asOfDate = fxBaseDate(input.occurredAt, input.receivedAt);
    const found = await this.fxSnapshots.find({
      baseCurrency: currency,
      asOfDate,
      moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
    });
    return found
      ? { kind: 'resolved', ref: found }
      : { kind: 'rejected', reason: 'fx_snapshot_missing' };
  }

  private async loadRow(tx: DbExecutor, id: string): Promise<MoneyRow | null> {
    const [row] = await tx
      .select(MONEY_ROW_COLUMNS)
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.id, id))
      .limit(1);
    return row ?? null;
  }

  private async findBySourceEvent(tx: DbExecutor, sourceEventId: string): Promise<MoneyRow | null> {
    const [row] = await tx
      .select(MONEY_ROW_COLUMNS)
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.sourceEventId, sourceEventId))
      .limit(1);
    return row ?? null;
  }

  private async loadLinkedCancellations(tx: DbExecutor, approvalId: string): Promise<MoneyRow[]> {
    return tx
      .select(MONEY_ROW_COLUMNS)
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.parentTransactionId, approvalId))
      .orderBy(schema.cardTransactions.id);
  }

  /**
   * 후보 승인 집합. 잠금 없이 넓게 읽고 {@link selectCancellationParent}가 좁힌다 —
   * 후보를 전부 잠그면 승격이 서로 막히므로, 확정된 하나만 나중에 잠근다(기존 승격
   * 경로와 같은 판단).
   */
  private async loadCandidates(tx: DbExecutor, householdId: string): Promise<CancellationCandidate[]> {
    const rows = await tx
      .select(MONEY_ROW_COLUMNS)
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.householdId, householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          ne(schema.cardTransactions.status, 'cancelled'),
        ),
      );
    return rows.map(toCandidate);
  }

  private async run<T>(
    options: MoneyCommandOptions | undefined,
    fn: (tx: DbExecutor) => Promise<T>,
  ): Promise<T> {
    return options?.tx ? fn(options.tx) : this.db.transaction((tx) => fn(tx));
  }
}

function metadataValues(metadata: TransactionMetadata) {
  return {
    householdId: metadata.householdId,
    memberId: metadata.memberId,
    cardId: metadata.cardId,
    sourceEventId: metadata.sourceEventId,
    merchantRaw: metadata.merchantRaw,
    merchantNormalized: metadata.merchantNormalized,
    categoryId: metadata.categoryId,
    authorizationCode: metadata.authorizationCode,
    installmentMonths: metadata.installmentMonths,
    visibility: metadata.visibility,
    memo: metadata.memo,
  };
}

export function toCandidate(row: MoneyRow): CancellationCandidate {
  return {
    id: row.id,
    cardId: row.cardId,
    currency: row.currency,
    originalCurrency: row.originalCurrency,
    amount: row.amount,
    cancelledAmount: row.cancelledAmount,
    originalAmount: row.originalAmount,
    originalCancelledAmount: row.originalCancelledAmount,
    approvedAt: row.approvedAt,
    authorizationCode: row.authorizationCode,
    merchantNormalized: row.merchantNormalized,
    status: row.status,
  };
}

/**
 * 저장된 status에서 **금액과 무관한** 검토 플래그만 건져낸다. 재계산이 사용자의
 * `duplicate_suspected`·`pending_review` 표시를 조용히 지우지 않게 하기 위함이다.
 */
function reviewFlagOf(status: string): MoneyReviewFlag | null {
  return status === 'pending_review' || status === 'duplicate_suspected' ? status : null;
}
