/**
 * shadow 관측 기록 — `transaction_money_repair_log`의 **미적용 manifest** 행으로 남긴다.
 *
 * ## 왜 로그가 아니라 테이블인가
 *
 * 롤아웃 3단계의 전환 조건은 "7일 이상 · 50건 이상에서 금액 delta 0건"이다. 0을
 * 증명하려면 기간을 잘라 세는 쿼리가 있어야 하는데, 컨테이너 로그는 (a) 회전되고
 * (b) 유실돼도 그 사실이 남지 않는다. 그리고 유실은 **"delta 없음" 쪽으로 편향된다** —
 * 안전 게이트에서 가장 나쁜 방향의 오류다. 그래서 세는 근거는 테이블에 둔다.
 * 사람이 실시간으로 보는 용도로는 같은 내용을 PII 없이 로그에도 남긴다.
 *
 * ## 왜 새 테이블이 아니라 이 테이블인가
 *
 * 이번 라운드는 `packages/database`를 건드리지 않는다(`0049`는 다른 워커의 산출물이고
 * `0050`은 v2 제약 VALIDATE 자리다). 그리고 이 테이블의 `applied_at IS NULL` 상태는
 * schema.ts가 이미 **"아직 적용되지 않은 dry-run manifest이고 `after*`는 그때의
 * 계획값"** 이라고 정의해 뒀다. shadow 레코드가 정확히 그것이다: 지금 값(before) 대
 * 새 계약이 계산했을 값(after), 적용은 하지 않음.
 *
 * ## 수리 배치와 섞이지 않게 하는 규약
 *
 * - `reason`은 반드시 {@link MONEY_SHADOW_REASON_PREFIX}로 시작한다. 수리 배치는
 *   `reason NOT LIKE 'shadow:%'`로 자기 행만 본다.
 * - `applied_at`은 언제나 null이고 shadow는 이 행을 **절대 적용·되돌리지 않는다.**
 * - `batch_id`는 행마다 새로 만든다. shadow 행은 되돌림 단위가 없어 배치에 속하지
 *   않는다. 고정 batch id를 쓰면 `unique(batch_id, transaction_id)`에 걸려 같은 거래의
 *   두 번째 관측이 조용히 사라진다(생성 후 수정처럼 실제로 일어나는 일이다).
 * - `net_amount_before/after`는 **계획이 성립했을 때만** 채운다. 계획 실패 행까지
 *   채우면 생성 컬럼 `net_amount_delta`가 `-before`가 되어, 합계를 내는 순간
 *   "설명되지 않는 delta"가 실제보다 커 보인다.
 */
import { randomUUID } from 'node:crypto';

import {
  buildTransactionMoneyImage,
  schema,
  transactionMoneyChecksum,
  type DbExecutor,
  type TransactionMoneyRowLike,
} from '@family/database';
import type { TransactionMoneyRepairAction } from '@family/database';

import type { MoneyShadowRecord } from './shadow.js';

/** 수리 배치가 shadow 행을 걸러낼 때 쓰는 접두어. 값을 바꾸면 그 쿼리도 바뀐다. */
export const MONEY_SHADOW_REASON_PREFIX = 'shadow:';

/** shadow 기록이 남기는 로그의 최소 인터페이스(pino 로거가 구조적으로 만족한다). */
export interface MoneyShadowLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MoneyShadowSinkStats {
  readonly recorded: number;
  /** 기록 자체가 실패해 삼킨 횟수. 삼켰다는 사실을 숫자로 남긴다. */
  readonly swallowed: number;
}

/**
 * 관측 결과를 저장한다. **어떤 경우에도 예외를 던지지 않는다** — shadow가 기존 쓰기
 * 경로를 실패시키면 "동작이 하나도 바뀌면 안 된다"는 이번 라운드의 전제가 깨진다.
 */
export class TransactionMoneyShadowSink {
  private recorded = 0;
  private swallowed = 0;

  constructor(
    private readonly db: DbExecutor,
    private readonly logger?: MoneyShadowLogger,
  ) {}

  stats(): MoneyShadowSinkStats {
    return { recorded: this.recorded, swallowed: this.swallowed };
  }

  async record(record: MoneyShadowRecord, actualRow: TransactionMoneyRowLike): Promise<void> {
    // 로그는 PII 없이 식별자·금액·분류만. 가맹점명·원문은 애초에 레코드에 없다.
    this.logger?.info(
      {
        path: record.path,
        verdict: record.verdict,
        transactionId: record.transactionId,
        transactionType: record.transactionType,
        foreign: record.foreign,
        netAmountDelta: record.netAmountDelta,
        failureReason: record.failureReason,
      },
      'money shadow observation',
    );

    try {
      const planned = record.planned;
      await this.db.insert(schema.transactionMoneyRepairLog).values({
        batchId: randomUUID(),
        householdId: record.householdId,
        transactionId: record.transactionId,
        sourceEventId: record.sourceEventId,
        action: shadowAction(record),
        reason: `${MONEY_SHADOW_REASON_PREFIX}${record.verdict}`,
        note: shadowNote(record),
        beforeMoney: buildTransactionMoneyImage(actualRow),
        afterMoney: planned
          ? buildTransactionMoneyImage({
              ...actualRow,
              ...planned,
              // 새 계약이 부모를 다르게 고르면 그 판정도 after 이미지에 담긴다.
              parentTransactionId:
                record.plannedParentTransactionId ?? planned.parentTransactionId,
            })
          : null,
        netAmountBefore: planned ? record.actual.netAmount : null,
        netAmountAfter: planned ? planned.netAmount : null,
        currencyBefore: planned ? record.actual.currency : null,
        currencyAfter: planned ? planned.currency : null,
        checksumBefore: transactionMoneyChecksum(actualRow),
        // 적용하지 않으므로 checksumAfter·appliedAt·restoreImage는 전부 비운다
        // (`transaction_money_repair_log_lifecycle_check`의 첫 번째 분기).
      });
      this.recorded += 1;
    } catch (error) {
      this.swallowed += 1;
      this.logger?.warn(
        {
          path: record.path,
          transactionId: record.transactionId,
          err: error instanceof Error ? error.message : 'unknown',
          swallowed: this.swallowed,
        },
        'money shadow record failed; swallowed so the write path is unaffected',
      );
    }
  }
}

/**
 * `action`은 "이 행을 v2로 맞추려면 수리가 무엇을 해야 하는가"를 뜻한다. shadow는
 * 적용하지 않지만, 나중에 수리 manifest를 만들 때 이 분류가 그대로 쓰인다.
 */
function shadowAction(record: MoneyShadowRecord): TransactionMoneyRepairAction {
  if (record.verdict === 'link_target_differs') return 'link_cancellation';
  // 저장 통화가 KRW가 아니면(D-3) 통화 정규화가 먼저다.
  if (record.actual.currency.toUpperCase() !== 'KRW') return 'normalize_currency';
  return 'recalculate_chain';
}

/** 진단에 필요한 최소 정보만. 문자열 원문·가맹점명은 넣지 않는다. */
function shadowNote(record: MoneyShadowRecord): string {
  return JSON.stringify({
    path: record.path,
    transactionType: record.transactionType,
    foreign: record.foreign,
    failureReason: record.failureReason,
    actualParent: record.actual.parentTransactionId,
    plannedParent: record.plannedParentTransactionId,
    actualStatus: record.actual.status,
    plannedStatus: record.planned?.status ?? null,
  });
}
