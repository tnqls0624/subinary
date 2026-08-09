/**
 * 재계산 안정성 — **사용자가 확정한 series의 신원이 유지되는가**.
 *
 * 지시서의 핵심 검증 항목이다. 별칭 merge/unmerge와 ADR-0027 과거 수리 뒤 전량
 * 재계산하는 것이 이 기능의 전제인데(PO 판정 Q1-4), 그때 사용자의 "정기 결제 맞음"이
 * 조용히 사라지면 재계산 자체를 할 수 없게 된다.
 */
import { describe, expect, it } from 'vitest';

import { reconcileSeries } from './reconcile';

describe('reconcileSeries — 확정 series 신원 유지', () => {
  it('근거가 겹치면 이름·금액이 바뀌어도 같은 series로 이어 붙인다', () => {
    // 별칭 등록으로 `지에스25` 거래가 `GS25`로 묶여 후보의 이름과 금액이 바뀌었지만,
    // 근거 거래 ID는 그대로다 — 그것이 유일한 연결선이다.
    const plan = reconcileSeries(
      [{ id: 'series-1', transactionIds: ['t1', 't2', 't3'] }],
      [{ transactionIds: ['t1', 't2', 't3', 't4'] }],
    );

    expect(plan.updates).toEqual([{ seriesId: 'series-1', candidateIndex: 0 }]);
    expect(plan.needsReview).toEqual([]);
    expect(plan.inserts).toEqual([]);
  });

  it('근거가 하나만 겹쳐도 이어 붙인다 (부분 수리를 견딘다)', () => {
    const plan = reconcileSeries(
      [{ id: 'series-1', transactionIds: ['t1', 't2', 't3'] }],
      [{ transactionIds: ['t3', 't4', 't5'] }],
    );
    expect(plan.updates).toEqual([{ seriesId: 'series-1', candidateIndex: 0 }]);
  });

  it('겹치는 후보가 여럿이면 가장 많이 겹치는 쪽을 고른다', () => {
    const plan = reconcileSeries(
      [{ id: 'series-1', transactionIds: ['t1', 't2', 't3', 't4'] }],
      [{ transactionIds: ['t1'] }, { transactionIds: ['t2', 't3', 't4'] }],
    );
    // 갈라진 것이므로 재검토 대상이지만, 근거는 가장 큰 조각으로 이어 붙인다.
    expect(plan.needsReview).toEqual([
      { seriesId: 'series-1', reason: 'split', candidateIndex: 1 },
    ]);
    // 나머지 조각은 사용자가 따로 판단할 수 있게 새 후보가 된다.
    expect(plan.inserts).toEqual([0]);
  });

  it('근거가 전부 사라지면 지우지 않고 evidence_lost로 남긴다', () => {
    const plan = reconcileSeries(
      [{ id: 'series-1', transactionIds: ['t1', 't2'] }],
      [{ transactionIds: ['t9'] }],
    );
    expect(plan.needsReview).toEqual([
      { seriesId: 'series-1', reason: 'evidence_lost', candidateIndex: null },
    ]);
    // 근거를 갱신하지 않는다(candidateIndex: null) — 되돌릴 근거를 잃으면 안 된다.
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([0]);
  });

  it('두 확정 series가 한 후보로 합쳐지면 둘 다 merged로 남긴다', () => {
    // 별칭 등록으로 `GS25`와 `지에스25` series가 하나가 된 상황. 어느 쪽 결정을
    // 살릴지 시스템이 정할 수 없으므로 사용자에게 되돌린다.
    const plan = reconcileSeries(
      [
        { id: 'series-1', transactionIds: ['t1', 't2'] },
        { id: 'series-2', transactionIds: ['t3', 't4'] },
      ],
      [{ transactionIds: ['t1', 't2', 't3', 't4'] }],
    );
    expect(plan.needsReview).toEqual([
      { seriesId: 'series-1', reason: 'merged', candidateIndex: null },
      { seriesId: 'series-2', reason: 'merged', candidateIndex: null },
    ]);
    // 합쳐진 후보를 새 candidate로도 만들지 않는다 — 한 사건이 화면에 세 줄이 된다.
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it('어느 기존 series와도 안 겹치는 후보는 새 candidate가 된다', () => {
    const plan = reconcileSeries([], [{ transactionIds: ['t1', 't2', 't3'] }]);
    expect(plan.inserts).toEqual([0]);
  });

  it('후보가 하나도 없어도 확정 series를 지우지 않는다', () => {
    // 재계산 실패나 데이터 공백이 사용자의 결정을 삭제하면 안 된다(PO 판정 Q5-4).
    const plan = reconcileSeries(
      [{ id: 'series-1', transactionIds: ['t1'] }],
      [],
    );
    expect(plan.needsReview).toEqual([
      { seriesId: 'series-1', reason: 'evidence_lost', candidateIndex: null },
    ]);
  });

  it('동률이면 낮은 index를 고른다 (결정적이어야 한다)', () => {
    const plan = reconcileSeries(
      [{ id: 'series-1', transactionIds: ['t1', 't2'] }],
      [{ transactionIds: ['t1'] }, { transactionIds: ['t2'] }],
    );
    expect(plan.needsReview[0]).toMatchObject({ candidateIndex: 0 });
  });
});
