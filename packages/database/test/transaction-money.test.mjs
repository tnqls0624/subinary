/**
 * 금액 계약 공용 상수·체크섬(ADR-0027) 회귀 테스트.
 *
 * 왜 체크섬을 테스트하는가: 이 값은 "수리를 적용해도 되는가 / 되돌려도 되는가"의 유일한
 * 판정 근거다. 키 순서나 Date 표현이 호출자마다 달라지면 같은 행이 다른 체크섬을 내고,
 * 그러면 판정이 조용히 무의미해진다 — 아무것도 실패하지 않은 채 만들어진 행을 덮어쓰게
 * 된다. DB는 필요 없다.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MONEY_CHECKSUM_COLUMNS,
  MONEY_CONTRACT_VERSION_V1,
  MONEY_CONTRACT_VERSION_V2,
  MONEY_PROTECTED_COLUMNS,
  MONEY_PROTECTED_DB_COLUMNS,
  buildTransactionMoneyImage,
  transactionMoneyChecksum,
} from '../dist/index.mjs';

/** USD 100 승인(@1,300)이 KRW로 환산돼 저장된 v2 행. */
function approvalRow(overrides = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    amount: 130000,
    currency: 'KRW',
    originalAmount: 10000,
    originalCurrency: 'USD',
    exchangeRate: 1300,
    fxRateSnapshotId: '22222222-2222-2222-2222-222222222222',
    cancelledAmount: 0,
    originalCancelledAmount: 0,
    netAmount: 130000,
    parentTransactionId: null,
    status: 'approved',
    moneyContractVersion: MONEY_CONTRACT_VERSION_V2,
    approvedAt: new Date('2026-08-01T03:00:00.000Z'),
    ...overrides,
  };
}

describe('금액 계약 상수', () => {
  it('v1과 v2는 서로 다르고 v2가 더 크다', () => {
    assert.equal(MONEY_CONTRACT_VERSION_V1, 1);
    assert.equal(MONEY_CONTRACT_VERSION_V2, 2);
  });

  it('보호 컬럼의 camelCase/snake_case 목록이 1:1로 대응한다', () => {
    assert.equal(
      MONEY_PROTECTED_COLUMNS.length,
      MONEY_PROTECTED_DB_COLUMNS.length,
    );
    MONEY_PROTECTED_COLUMNS.forEach((camel, i) => {
      const expected = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      assert.equal(
        MONEY_PROTECTED_DB_COLUMNS[i],
        expected,
        `${camel} 의 DB 컬럼명이 어긋난다`,
      );
    });
  });

  it('체크섬 대상은 보호 컬럼 + 환율 기준일 입력(approvedAt)이다', () => {
    // approvedAt은 서비스 전용 컬럼이 아니지만 바뀌면 환산 기준일이 바뀐다.
    assert.deepEqual(
      [...MONEY_CHECKSUM_COLUMNS],
      [...MONEY_PROTECTED_COLUMNS, 'approvedAt'],
    );
  });
});

describe('buildTransactionMoneyImage', () => {
  it('보호 컬럼만 고정된 순서로 담는다', () => {
    const image = buildTransactionMoneyImage(approvalRow());
    assert.deepEqual(Object.keys(image), [...MONEY_PROTECTED_COLUMNS]);
    // id·approvedAt·memo 등 보호 대상이 아닌 값은 들어가지 않는다.
    assert.ok(!('id' in image));
    assert.ok(!('approvedAt' in image));
  });

  it('없는 값은 undefined가 아니라 null이다 (jsonb에 키가 사라지지 않게)', () => {
    const image = buildTransactionMoneyImage(
      approvalRow({ originalAmount: undefined, originalCurrency: undefined }),
    );
    assert.equal(image.originalAmount, null);
    assert.equal(image.originalCurrency, null);
  });

  it('0을 null로 접지 않는다', () => {
    const image = buildTransactionMoneyImage(approvalRow());
    assert.equal(image.cancelledAmount, 0);
    assert.equal(image.originalCancelledAmount, 0);
  });
});

describe('transactionMoneyChecksum', () => {
  it('같은 행은 항상 같은 값이고 형식이 self-describing이다', () => {
    assert.equal(
      transactionMoneyChecksum(approvalRow()),
      transactionMoneyChecksum(approvalRow()),
    );
    assert.match(transactionMoneyChecksum(approvalRow()), /^sha256:[0-9a-f]{64}$/);
  });

  it('Date로 오든 ISO 문자열로 오든 같은 값이다', () => {
    // 원시 SQL 조회와 Drizzle 조회가 같은 시각을 다른 타입으로 돌려준다.
    assert.equal(
      transactionMoneyChecksum(approvalRow()),
      transactionMoneyChecksum(
        approvalRow({ approvedAt: '2026-08-01T03:00:00.000Z' }),
      ),
    );
  });

  it('금액·연결·계약 버전이 바뀌면 값이 바뀐다', () => {
    const base = transactionMoneyChecksum(approvalRow());
    for (const change of [
      { netAmount: 91000 },
      { cancelledAmount: 39000 },
      { originalCancelledAmount: 3000 },
      { currency: 'USD' },
      { parentTransactionId: '33333333-3333-3333-3333-333333333333' },
      { status: 'partially_cancelled' },
      { moneyContractVersion: MONEY_CONTRACT_VERSION_V1 },
      { fxRateSnapshotId: null },
      // 승인시각이 바뀌면 환산 기준일이 바뀐다 — 금액이 그대로여도 재계산 대상이다.
      { approvedAt: new Date('2026-08-02T03:00:00.000Z') },
    ]) {
      assert.notEqual(
        transactionMoneyChecksum(approvalRow(change)),
        base,
        `${Object.keys(change)[0]} 변경이 체크섬에 반영되지 않는다`,
      );
    }
  });

  it('금액과 무관한 편집(메모·카테고리·제외)은 값을 바꾸지 않는다', () => {
    // 이것들 때문에 자동 되돌림이 막히면 사람이 확인할 일만 늘고 안전해지는 건 없다.
    const base = transactionMoneyChecksum(approvalRow());
    assert.equal(
      transactionMoneyChecksum({
        ...approvalRow(),
        memo: '가족 여행',
        categoryId: '44444444-4444-4444-4444-444444444444',
        excludedAt: new Date('2026-08-05T00:00:00.000Z'),
        updatedAt: new Date('2026-08-05T00:00:00.000Z'),
      }),
      base,
    );
  });

  it('다른 거래는 값이 다르다 (행에 결박된다)', () => {
    assert.notEqual(
      transactionMoneyChecksum(
        approvalRow({ id: '99999999-9999-9999-9999-999999999999' }),
      ),
      transactionMoneyChecksum(approvalRow()),
    );
  });
});
