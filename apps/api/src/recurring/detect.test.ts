/**
 * 후보 판별 규칙 — 결정성과 **오탐 방어**를 본다.
 *
 * 이 단계에서 중요한 것은 재현율이 아니라 정밀도다. P0-10(파서 앵커링)이 아직
 * enforce 전이라 잘못된 승인 입력 가능성이 열려 있고, 그 위에서 만든 후보를 사용자에게
 * 확정 사실처럼 보여주면 틀린 예고가 된다(PO 판정 Q1). 그래서 "안 잡히는" 케이스를
 * 명시적으로 고정해 둔다 — 나중에 상수를 풀 때 무엇을 바꾸는지 알고 바꾸도록.
 */
import { describe, expect, it } from 'vitest';

import { detectRecurringCandidates, type RecurringOccurrence } from './detect';

const MEMBER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_MEMBER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let seq = 0;
function occ(
  merchant: string,
  amount: number,
  isoDate: string,
  overrides: Partial<RecurringOccurrence> = {},
): RecurringOccurrence {
  seq += 1;
  return {
    transactionId: `txn-${seq.toString().padStart(4, '0')}`,
    memberId: MEMBER,
    merchantCanonical: merchant,
    netAmount: amount,
    currency: 'KRW',
    occurredAt: new Date(`${isoDate}T00:00:00Z`),
    moneyContractVersion: 1,
    ...overrides,
  };
}

describe('detectRecurringCandidates — 월 주기', () => {
  it('같은 가맹점·금액이 3개월 연속이면 후보가 된다', () => {
    const found = detectRecurringCandidates([
      occ('넷플릭스', 13_500, '2026-05-12'),
      occ('넷플릭스', 13_500, '2026-06-12'),
      occ('넷플릭스', 13_500, '2026-07-12'),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      merchantCanonical: '넷플릭스',
      cadence: 'monthly',
      occurrenceCount: 3,
      amountMedian: 13_500,
      amountMin: 13_500,
      amountMax: 13_500,
    });
    expect(found[0].intervalDays).toBeGreaterThanOrEqual(25);
    expect(found[0].intervalDays).toBeLessThanOrEqual(35);
    expect(found[0].transactionIds).toHaveLength(3);
  });

  it('금액이 조금 변해도 허용 변동폭 안이면 한 series다 (변동형 구독)', () => {
    const found = detectRecurringCandidates([
      occ('클로드', 20_000, '2026-05-03'),
      occ('클로드', 20_400, '2026-06-03'),
      occ('클로드', 20_800, '2026-07-03'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].amountMin).toBe(20_000);
    expect(found[0].amountMax).toBe(20_800);
  });

  it('금액이 밴드를 벗어나면 다른 사건으로 가른다', () => {
    // 요금제가 다르면 같은 가맹점이라도 별개 구독이다. 합치면 사용자가 확정한
    // 신원이 오염되고, 나중에 하나만 해지해도 구분할 수 없다.
    const found = detectRecurringCandidates([
      occ('통신사', 30_000, '2026-05-05'),
      occ('통신사', 30_000, '2026-06-05'),
      occ('통신사', 30_000, '2026-07-05'),
      occ('통신사', 55_000, '2026-05-05'),
      occ('통신사', 55_000, '2026-06-05'),
      occ('통신사', 55_000, '2026-07-05'),
    ]);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.amountMedian).sort((a, b) => a - b)).toEqual([
      30_000, 55_000,
    ]);
  });

  it('한 달 안의 3회는 후보가 아니다 — P0-10 오탐이 그렇게 몰린다', () => {
    const found = detectRecurringCandidates([
      occ('편의점', 4_500, '2026-07-01'),
      occ('편의점', 4_500, '2026-07-02'),
      occ('편의점', 4_500, '2026-07-03'),
    ]);
    expect(found).toEqual([]);
  });

  it('2회만으로는 후보가 아니다', () => {
    const found = detectRecurringCandidates([
      occ('넷플릭스', 13_500, '2026-06-12'),
      occ('넷플릭스', 13_500, '2026-07-12'),
    ]);
    expect(found).toEqual([]);
  });

  it('한 번 건너뛴 구독은 살린다 — 결제 실패로 거르는 일이 실제로 있다', () => {
    const found = detectRecurringCandidates([
      occ('헬스장', 99_000, '2026-04-19'),
      occ('헬스장', 99_000, '2026-05-19'),
      // 6월은 결제 실패(ADR-0024)로 건너뜀
      occ('헬스장', 99_000, '2026-07-19'),
      occ('헬스장', 99_000, '2026-08-19'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].occurrenceCount).toBe(4);
  });

  it('격월 결제는 월 주기로 잡지 않는다', () => {
    // 전 간격이 2주기면 "대부분 제 주기" 조건에서 걸린다.
    const found = detectRecurringCandidates([
      occ('격월서비스', 40_000, '2026-03-10'),
      occ('격월서비스', 40_000, '2026-05-10'),
      occ('격월서비스', 40_000, '2026-07-10'),
    ]);
    expect(found).toEqual([]);
  });

  it('불규칙한 반복 구매는 후보가 아니다', () => {
    const found = detectRecurringCandidates([
      occ('카페', 5_000, '2026-05-02'),
      occ('카페', 5_000, '2026-06-01'),
      occ('카페', 5_000, '2026-06-20'),
      occ('카페', 5_000, '2026-07-15'),
    ]);
    expect(found).toEqual([]);
  });
});

describe('detectRecurringCandidates — 주 주기', () => {
  it('4회 이상 · 3주 이상 이어지면 후보가 된다', () => {
    const found = detectRecurringCandidates([
      occ('주간배송', 12_000, '2026-07-01'),
      occ('주간배송', 12_000, '2026-07-08'),
      occ('주간배송', 12_000, '2026-07-15'),
      occ('주간배송', 12_000, '2026-07-22'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].cadence).toBe('weekly');
    expect(found[0].intervalDays).toBe(7);
  });

  it('3회(2주)면 우연한 연속 구매와 갈리지 않아 후보가 아니다', () => {
    const found = detectRecurringCandidates([
      occ('주간배송', 12_000, '2026-07-01'),
      occ('주간배송', 12_000, '2026-07-08'),
      occ('주간배송', 12_000, '2026-07-15'),
    ]);
    expect(found).toEqual([]);
  });
});

describe('detectRecurringCandidates — 경계와 결정성', () => {
  it('구성원이 다르면 다른 series다 (각자의 구독이다)', () => {
    const found = detectRecurringCandidates([
      occ('넷플릭스', 13_500, '2026-05-12'),
      occ('넷플릭스', 13_500, '2026-06-12'),
      occ('넷플릭스', 13_500, '2026-07-12'),
      occ('넷플릭스', 13_500, '2026-05-20', { memberId: OTHER_MEMBER }),
      occ('넷플릭스', 13_500, '2026-06-20', { memberId: OTHER_MEMBER }),
      occ('넷플릭스', 13_500, '2026-07-20', { memberId: OTHER_MEMBER }),
    ]);
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.memberId)).size).toBe(2);
  });

  it('통화가 다르면 합치지 않는다', () => {
    const found = detectRecurringCandidates([
      occ('해외구독', 10_000, '2026-05-01'),
      occ('해외구독', 10_000, '2026-06-01'),
      occ('해외구독', 10_000, '2026-07-01'),
      occ('해외구독', 10_000, '2026-05-15', { currency: 'USD' }),
      occ('해외구독', 10_000, '2026-06-15', { currency: 'USD' }),
      occ('해외구독', 10_000, '2026-07-15', { currency: 'USD' }),
    ]);
    expect(found).toHaveLength(2);
  });

  it('근거의 금액 계약 버전 최솟값을 물려받는다 (v1이 섞이면 v1 신뢰도)', () => {
    const found = detectRecurringCandidates([
      occ('넷플릭스', 13_500, '2026-05-12', { moneyContractVersion: 2 }),
      occ('넷플릭스', 13_500, '2026-06-12', { moneyContractVersion: 1 }),
      occ('넷플릭스', 13_500, '2026-07-12', { moneyContractVersion: 2 }),
    ]);
    expect(found[0].moneyContractVersion).toBe(1);
  });

  it('입력 순서가 달라도 같은 결과다 (재계산이 결정적이어야 한다)', () => {
    const input = [
      occ('넷플릭스', 13_500, '2026-05-12'),
      occ('왓챠', 7_900, '2026-05-03'),
      occ('넷플릭스', 13_500, '2026-06-12'),
      occ('왓챠', 7_900, '2026-06-03'),
      occ('넷플릭스', 13_500, '2026-07-12'),
      occ('왓챠', 7_900, '2026-07-03'),
    ];
    const forward = detectRecurringCandidates(input);
    const reversed = detectRecurringCandidates([...input].reverse());
    expect(reversed.map((c) => c.merchantCanonical)).toEqual(
      forward.map((c) => c.merchantCanonical),
    );
    expect(reversed.map((c) => c.transactionIds)).toEqual(
      forward.map((c) => c.transactionIds),
    );
  });

  it('가맹점명이 없거나 순액이 0 이하면 입력에서 빠진다', () => {
    const found = detectRecurringCandidates([
      occ('', 13_500, '2026-05-12'),
      occ('', 13_500, '2026-06-12'),
      occ('', 13_500, '2026-07-12'),
      occ('환불된것', 0, '2026-05-12'),
      occ('환불된것', 0, '2026-06-12'),
      occ('환불된것', 0, '2026-07-12'),
    ]);
    expect(found).toEqual([]);
  });
});
