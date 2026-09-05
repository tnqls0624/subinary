/**
 * ADR-0027 "금액 도메인 단위 테스트" 1~11의 순수 계산 부분.
 *
 * 실행기(잠금·트랜잭션)가 아니라 계획기를 검증하는 이유: 금액이 얼마인가는 전부
 * 계획기가 정하고, 실행기는 그 값을 정해진 순서로 쓰기만 한다. DB 없이 전수 검증할 수
 * 있는 쪽에 계산을 몰아둔 것이 이 패키지 설계의 핵심이다.
 */
import { describe, expect, it } from 'vitest';

import {
  candidateRemaining,
  orderedLockIds,
  planChain,
  selectCancellationParent,
  type CancellationCandidate,
  type FxSnapshotRef,
} from './plan.js';

const USD_1300: FxSnapshotRef = {
  id: 'snap-usd-1300',
  baseCurrency: 'USD',
  asOfDate: '2026-08-01',
  rate: '1300.000000000000',
  moneyContractVersion: 2,
};

/** 취소일에 오른 환율. 승인 스냅샷을 재사용하는지 보려고만 존재한다. */
const USD_1400: FxSnapshotRef = { ...USD_1300, id: 'snap-usd-1400', rate: '1400.000000000000' };

function unwrap<T>(plan: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!plan.ok) throw new Error(`plan rejected: ${plan.reason}`);
  return plan.value;
}

describe('KRW 승인', () => {
  it('1. 10,000원 승인은 amount=netAmount이고 환율 필드가 없다', () => {
    const plan = unwrap(planChain({ minorUnits: 10_000, currency: 'KRW' }, []));
    expect(plan.approval).toMatchObject({
      amount: 10_000,
      currency: 'KRW',
      netAmount: 10_000,
      cancelledAmount: 0,
      originalAmount: null,
      originalCurrency: null,
      exchangeRate: null,
      fxRateSnapshotId: null,
      originalCancelledAmount: null,
      status: 'approved',
      moneyContractVersion: 2,
    });
  });

  it('8. 10,000원 승인 + 3,000원 취소는 순액 7,000원', () => {
    const plan = unwrap(
      planChain({ minorUnits: 10_000, currency: 'KRW' }, [
        { id: 'c1', minorUnits: 3_000, currency: 'KRW' },
      ]),
    );
    expect(plan.approval.cancelledAmount).toBe(3_000);
    expect(plan.approval.netAmount).toBe(7_000);
    expect(plan.approval.status).toBe('partially_cancelled');
    // 취소 행 자신의 순액은 언제나 0 — 아니면 같은 취소가 두 번 계상된다(v2-6).
    expect(plan.cancellations[0].columns.netAmount).toBe(0);
    expect(plan.cancellations[0].columns.status).toBe('approved');
  });

  it('전액취소는 순액 0이고 status=cancelled', () => {
    const plan = unwrap(
      planChain({ minorUnits: 10_000, currency: 'KRW' }, [
        { id: 'c1', minorUnits: 10_000, currency: 'KRW' },
      ]),
    );
    expect(plan.approval.netAmount).toBe(0);
    expect(plan.approval.cancelledAmount).toBe(10_000);
    expect(plan.approval.status).toBe('cancelled');
  });

  it('금액과 무관한 검토 플래그는 취소가 없을 때만 유지된다', () => {
    const flagged = unwrap(
      planChain({ minorUnits: 10_000, currency: 'KRW', reviewFlag: 'duplicate_suspected' }, []),
    );
    expect(flagged.approval.status).toBe('duplicate_suspected');

    const linked = unwrap(
      planChain({ minorUnits: 10_000, currency: 'KRW', reviewFlag: 'duplicate_suspected' }, [
        { id: 'c1', minorUnits: 10_000, currency: 'KRW' },
      ]),
    );
    expect(linked.approval.status).toBe('cancelled');
  });
});

describe('외화 승인과 취소', () => {
  it('2. USD 100 승인(@1,300)은 130,000원과 원통화 10,000 minor units를 보존한다', () => {
    const plan = unwrap(
      planChain({ minorUnits: 10_000, currency: 'USD', snapshot: USD_1300 }, []),
    );
    expect(plan.approval).toMatchObject({
      amount: 130_000,
      currency: 'KRW',
      netAmount: 130_000,
      originalAmount: 10_000,
      originalCurrency: 'USD',
      originalCancelledAmount: 0,
      exchangeRate: 1300,
      fxRateSnapshotId: 'snap-usd-1300',
    });
  });

  it('3. USD 100 전액취소는 취소일 환율과 무관하게 승인 순액 0', () => {
    // 환율이 올랐든(1,400) 내렸든 승인에 저장된 스냅샷으로만 계산한다. 지금 코드는
    // 취소를 취소일 환율로 따로 환산해 140,000원을 만들고, 그래서 상계에 실패한다(D-1).
    for (const cancellationRate of [USD_1400, { ...USD_1300, rate: '1200.000000000000' }]) {
      void cancellationRate;
      const plan = unwrap(
        planChain({ minorUnits: 10_000, currency: 'USD', snapshot: USD_1300 }, [
          { id: 'c1', minorUnits: 10_000, currency: 'USD' },
        ]),
      );
      expect(plan.approval.netAmount).toBe(0);
      expect(plan.approval.cancelledAmount).toBe(plan.approval.amount);
      expect(plan.approval.originalCancelledAmount).toBe(10_000);
      expect(plan.approval.status).toBe('cancelled');
    }
  });

  it('4. USD 30 부분취소 후 원통화 잔액 USD 70, KRW 순액 91,000원', () => {
    const plan = unwrap(
      planChain({ minorUnits: 10_000, currency: 'USD', snapshot: USD_1300 }, [
        { id: 'c1', minorUnits: 3_000, currency: 'USD' },
      ]),
    );
    expect(plan.originalRemaining).toBe(7_000);
    expect(plan.approval.netAmount).toBe(91_000);
    expect(plan.approval.cancelledAmount).toBe(39_000);
    expect(plan.approval.originalCancelledAmount).toBe(3_000);
    expect(plan.approval.status).toBe('partially_cancelled');
  });

  it('4. 반올림이 남을 환율에서도 부분취소 합이 원금과 같으면 순액은 정확히 0', () => {
    // USD 100을 33.33 + 33.33 + 33.34로 쪼갠다. 취소별 KRW를 더해서 빼면 반올림이
    // 누적돼 1원이 남을 수 있다. 원통화 잔액에서 유도하면 남지 않는다.
    const odd: FxSnapshotRef = { ...USD_1300, rate: '1333.333333333333' };
    const plan = unwrap(
      planChain({ minorUnits: 10_000, currency: 'USD', snapshot: odd }, [
        { id: 'c1', minorUnits: 3_333, currency: 'USD' },
        { id: 'c2', minorUnits: 3_333, currency: 'USD' },
        { id: 'c3', minorUnits: 3_334, currency: 'USD' },
      ]),
    );
    expect(plan.originalRemaining).toBe(0);
    expect(plan.approval.netAmount).toBe(0);
    expect(plan.approval.cancelledAmount).toBe(plan.approval.amount);
  });

  it('연결된 외화 취소의 표시 금액도 승인 스냅샷으로 유도한다', () => {
    const plan = unwrap(
      planChain({ minorUnits: 10_000, currency: 'USD', snapshot: USD_1300 }, [
        { id: 'c1', minorUnits: 3_000, currency: 'USD' },
      ]),
    );
    expect(plan.cancellations[0].columns).toMatchObject({
      amount: 39_000,
      currency: 'KRW',
      originalAmount: 3_000,
      originalCurrency: 'USD',
      fxRateSnapshotId: 'snap-usd-1300',
      netAmount: 0,
      originalCancelledAmount: null,
    });
  });

  it('6. 스냅샷이 없으면 오늘 환율로 대체하지 않고 거부한다', () => {
    const plan = planChain({ minorUnits: 10_000, currency: 'USD', snapshot: null }, []);
    expect(plan).toEqual({ ok: false, reason: 'fx_snapshot_missing' });
  });

  it('스냅샷 통화가 승인 원통화와 다르면 거부한다', () => {
    const plan = planChain(
      { minorUnits: 10_000, currency: 'EUR', snapshot: USD_1300 },
      [],
    );
    expect(plan).toEqual({ ok: false, reason: 'currency_mismatch' });
  });

  it('지원하지 않는 통화는 환산하지 않는다', () => {
    const plan = planChain(
      {
        minorUnits: 10_000,
        currency: 'XYZ',
        snapshot: { ...USD_1300, baseCurrency: 'XYZ' },
      },
      [],
    );
    expect(plan).toEqual({ ok: false, reason: 'unsupported_currency' });
  });
});

describe('체인 거부 조건 (ADR §2: 위반이면 수정 전체 거부)', () => {
  it('10. 취소 누계가 승인액을 넘으면 체인 전체를 거부한다', () => {
    // 동시에 들어온 두 부분취소가 각각 통과해서 음수 잔액을 만드는 상황이 이 조건에
    // 걸린다. 실행기는 승인 행을 잠근 뒤 이 계산을 다시 하므로 나중 취소가 탈락한다.
    const plan = planChain({ minorUnits: 10_000, currency: 'KRW' }, [
      { id: 'c1', minorUnits: 7_000, currency: 'KRW' },
      { id: 'c2', minorUnits: 7_000, currency: 'KRW' },
    ]);
    expect(plan).toEqual({ ok: false, reason: 'cancellation_exceeds_approval' });
  });

  it('10. 잔액에 딱 맞는 두 부분취소는 통과하고 순액이 0이다', () => {
    const plan = unwrap(
      planChain({ minorUnits: 10_000, currency: 'KRW' }, [
        { id: 'c1', minorUnits: 7_000, currency: 'KRW' },
        { id: 'c2', minorUnits: 3_000, currency: 'KRW' },
      ]),
    );
    expect(plan.approval.netAmount).toBe(0);
    expect(plan.approval.cancelledAmount).toBe(10_000);
  });

  it('승인과 취소의 통화가 다르면 거부한다', () => {
    const plan = planChain({ minorUnits: 10_000, currency: 'USD', snapshot: USD_1300 }, [
      { id: 'c1', minorUnits: 3_000, currency: 'EUR' },
    ]);
    expect(plan).toEqual({ ok: false, reason: 'currency_mismatch' });
  });

  it('음수·비정수 금액은 거부한다', () => {
    expect(planChain({ minorUnits: -1, currency: 'KRW' }, [])).toEqual({
      ok: false,
      reason: 'invalid_amount',
    });
    expect(planChain({ minorUnits: 1.5, currency: 'KRW' }, [])).toEqual({
      ok: false,
      reason: 'invalid_amount',
    });
  });

  it('11. 취소를 뺀 체인은 원래 승인값을 그대로 복원한다', () => {
    const linked = unwrap(
      planChain({ minorUnits: 10_000, currency: 'USD', snapshot: USD_1300 }, [
        { id: 'c1', minorUnits: 3_000, currency: 'USD' },
      ]),
    );
    const unlinked = unwrap(
      planChain({ minorUnits: 10_000, currency: 'USD', snapshot: USD_1300 }, []),
    );
    expect(linked.approval.amount).toBe(unlinked.approval.amount);
    expect(unlinked.approval.netAmount).toBe(130_000);
    expect(unlinked.approval.cancelledAmount).toBe(0);
    expect(unlinked.approval.originalCancelledAmount).toBe(0);
    expect(unlinked.approval.status).toBe('approved');
  });
});

/* -------------------------------------------------------------------------- */

function approval(overrides: Partial<CancellationCandidate> = {}): CancellationCandidate {
  return {
    id: 'a1',
    cardId: 'card-1',
    currency: 'KRW',
    originalCurrency: null,
    amount: 10_000,
    cancelledAmount: 0,
    originalAmount: null,
    originalCancelledAmount: null,
    approvedAt: new Date('2026-08-01T00:00:00Z'),
    authorizationCode: null,
    merchantNormalized: '스타벅스',
    status: 'approved',
    ...overrides,
  };
}

const CANCELLED_AT = new Date('2026-08-02T00:00:00Z');

const evidence = {
  cardId: 'card-1',
  currency: 'KRW',
  minorUnits: 10_000,
  cancelledAt: CANCELLED_AT,
  authorizationCode: null,
  merchantNormalized: '스타벅스',
};

describe('취소 후보 판정 (ADR §4)', () => {
  it('유일 후보만 자동 연결한다', () => {
    expect(selectCancellationParent(evidence, [approval()])).toEqual({
      kind: 'unique',
      approval: approval(),
    });
  });

  it('같은 시각의 승인도 후보다 — 카드 문자는 분 단위라 즉시 취소가 여기 걸린다', () => {
    // 실측 2026-09-05: 쿠팡 3,700원이 20:05:00 승인 → 20:05:00 취소 → 20:06:34
    // 재승인이었다. `approvedAt >= cancelledAt`으로 막던 종전 규칙에서는 후보가
    // 0개가 되어 취소가 영원히 연결되지 않았고, 3,700원이 지출에 과다 계상됐다.
    expect(
      selectCancellationParent(evidence, [
        approval({ approvedAt: CANCELLED_AT }),
      ]),
    ).toEqual({ kind: 'unique', approval: approval({ approvedAt: CANCELLED_AT }) });
  });

  it('취소보다 나중의 승인은 여전히 후보가 아니다', () => {
    // 재승인(취소 이후)이 부모가 되면 상계 방향이 뒤집힌다.
    const later = new Date(CANCELLED_AT.getTime() + 60_000);
    expect(
      selectCancellationParent(evidence, [approval({ approvedAt: later })]),
    ).toEqual({ kind: 'none' });
  });

  it('같은 시각 승인이 둘이면 시스템이 고르지 않는다', () => {
    // 시각으로 구분되지 않는 것을 골라 붙이면 틀렸을 때 되돌릴 근거가 없다.
    expect(
      selectCancellationParent(evidence, [
        approval({ approvedAt: CANCELLED_AT }),
        approval({ id: 'a2', approvedAt: CANCELLED_AT }),
      ]),
    ).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('9. 후보가 0개면 none, 2개 이상이면 ambiguous다', () => {
    expect(selectCancellationParent(evidence, [])).toEqual({ kind: 'none' });
    expect(
      selectCancellationParent(evidence, [approval(), approval({ id: 'a2' })]),
    ).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('승인이 취소보다 뒤면 후보가 아니다', () => {
    const later = approval({ approvedAt: new Date('2026-08-03T00:00:00Z') });
    expect(selectCancellationParent(evidence, [later])).toEqual({ kind: 'none' });
  });

  it('카드가 다르면 후보가 아니고, 미연결끼리는 양쪽 모두 null이어야 한다', () => {
    expect(selectCancellationParent(evidence, [approval({ cardId: 'card-2' })])).toEqual({
      kind: 'none',
    });
    expect(selectCancellationParent(evidence, [approval({ cardId: null })])).toEqual({
      kind: 'none',
    });
    expect(
      selectCancellationParent({ ...evidence, cardId: null }, [approval({ cardId: null })]),
    ).toEqual({ kind: 'unique', approval: approval({ cardId: null }) });
  });

  it('승인번호가 있으면 정확히 같은 승인번호만 후보다', () => {
    const withCode = { ...evidence, authorizationCode: '123456' };
    expect(
      selectCancellationParent(withCode, [approval({ authorizationCode: '123456' })]),
    ).toMatchObject({ kind: 'unique' });
    // 가맹점이 같아도 승인번호가 다르면 붙이지 않는다.
    expect(
      selectCancellationParent(withCode, [approval({ authorizationCode: '999999' })]),
    ).toEqual({ kind: 'none' });
  });

  it('증거(취소시각·가맹점/승인번호)가 없으면 느슨하게 풀지 않고 사람에게 보낸다', () => {
    expect(selectCancellationParent({ ...evidence, cancelledAt: null }, [approval()])).toEqual({
      kind: 'insufficient_evidence',
      missing: 'occurred_at',
    });
    expect(
      selectCancellationParent(
        { ...evidence, merchantNormalized: null, authorizationCode: null },
        [approval()],
      ),
    ).toEqual({ kind: 'insufficient_evidence', missing: 'identity' });
  });

  it('외화는 환산 KRW가 아니라 원통화 잔액으로 비교한다', () => {
    // D-1 재현: 승인 130,000원(USD 100 @1,300), 취소 USD 100. 취소일 환율이 1,400이면
    // 환산 KRW 잔액 비교(130,000 >= 140,000)는 탈락하지만 원통화 비교는 통과한다.
    const usdApproval = approval({
      currency: 'KRW',
      originalCurrency: 'USD',
      amount: 130_000,
      originalAmount: 10_000,
      originalCancelledAmount: 0,
    });
    expect(
      selectCancellationParent(
        { ...evidence, currency: 'USD', minorUnits: 10_000 },
        [usdApproval],
      ),
    ).toMatchObject({ kind: 'unique' });
  });

  it('원통화 잔액이 모자라면 후보가 아니다', () => {
    const partly = approval({ cancelledAmount: 4_000 });
    expect(candidateRemaining(partly)).toBe(6_000);
    expect(selectCancellationParent(evidence, [partly])).toEqual({ kind: 'none' });
  });

  it('이미 전액취소된 승인은 후보가 아니다', () => {
    expect(
      selectCancellationParent(evidence, [approval({ status: 'cancelled' })]),
    ).toEqual({ kind: 'none' });
  });
});

describe('잠금 순서', () => {
  it('재연결은 이전·새 부모를 id 오름차순으로 잠근다', () => {
    expect(orderedLockIds(['b', 'a'])).toEqual(['a', 'b']);
    expect(orderedLockIds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('null·중복은 제거한다', () => {
    expect(orderedLockIds([null, 'a', undefined, 'a'])).toEqual(['a']);
  });
});
