/**
 * 지출 집계 공용 조건(query-helpers)의 SQL 모양 회귀 테스트.
 *
 * 왜 SQL 문자열을 검사하는가: 이 헬퍼들의 버그는 "조건이 조용히 빠지는" 형태로 나타나고
 * (실제로 `/v1/merchants`에서 공개범위 조건이 통째로 빠져 타인의 private 거래가
 * 노출됐다), 그런 누락은 타입체크로도 런타임 스모크로도 잡히지 않는다. 생성 SQL을
 * 고정해 두면 헬퍼가 바뀔 때 어떤 집계 API가 영향을 받는지 즉시 드러난다.
 *
 * DB는 필요 없다 — drizzle의 QueryBuilder는 커넥션 없이 SQL만 만든다.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';

import {
  REDACTED_MERCHANT_LABEL,
  redactedMerchantLabel,
  schema,
  visibilityScope,
} from '../dist/index.mjs';

const ACTOR = '11111111-1111-1111-1111-111111111111';
const qb = new QueryBuilder();

describe('visibilityScope', () => {
  it('본인 행 ∪ household/summary_only 만 남긴다 (타인의 private 제외)', () => {
    const { sql: text, params } = qb
      .select({ id: schema.cardTransactions.id })
      .from(schema.cardTransactions)
      .where(visibilityScope(ACTOR))
      .toSQL();

    assert.match(text, /"card_transactions"\."member_id" = \$1/);
    assert.match(text, /"card_transactions"\."visibility" in \(\$2, \$3\)/);
    assert.deepEqual(params, [ACTOR, 'household', 'summary_only']);
    // 'private'이 허용 목록에 섞이면 타인의 비공개 거래가 통째로 새어 나간다.
    assert.ok(!params.includes('private'));
  });
});

describe('redactedMerchantLabel', () => {
  it('타인의 summary_only 가맹점명을 (비공개)로 접는다', () => {
    const { sql: text, params } = qb
      .select({ merchant: redactedMerchantLabel(ACTOR) })
      .from(schema.cardTransactions)
      .toSQL();

    assert.match(text, /"member_id" <> \$1::uuid/);
    assert.match(text, /"visibility" = 'summary_only'/);
    assert.equal(params[0], ACTOR);
    assert.equal(params[1], REDACTED_MERCHANT_LABEL);
    assert.equal(REDACTED_MERCHANT_LABEL, '(비공개)');
  });

  it('unknownLabel을 주면 merchant_normalized IS NULL 분기가 생기고, 없으면 안 생긴다', () => {
    const withUnknown = qb
      .select({ merchant: redactedMerchantLabel(ACTOR, '미확인 가맹점') })
      .from(schema.cardTransactions)
      .toSQL();
    assert.match(withUnknown.sql, /"merchant_normalized" is null then \$3/);
    assert.equal(withUnknown.params[2], '미확인 가맹점');

    const withoutUnknown = qb
      .select({ merchant: redactedMerchantLabel(ACTOR) })
      .from(schema.cardTransactions)
      .toSQL();
    assert.ok(!/is null then/.test(withoutUnknown.sql));
    assert.equal(withoutUnknown.params.length, 2);
  });
});

describe('가맹점 목록 집계 (/v1/merchants 가 만드는 쿼리 모양)', () => {
  // MerchantService.listMerchants 와 같은 조합. 여기서 조건 하나가 빠지면
  // 그대로 가구 경계/공개범위 누출이므로 조합 자체를 고정해 둔다.
  const built = qb
    .select({
      name: redactedMerchantLabel(ACTOR),
      count: sql`count(*)`,
    })
    .from(schema.cardTransactions)
    .where(
      and(
        eq(schema.cardTransactions.householdId, 'household-1'),
        eq(schema.cardTransactions.transactionType, 'approval'),
        isNull(schema.cardTransactions.excludedAt),
        sql`${schema.cardTransactions.merchantNormalized} is not null`,
        visibilityScope(ACTOR),
      ),
    )
    .groupBy(sql`1`)
    .toSQL();

  it('공개범위 조건이 WHERE에 들어간다', () => {
    assert.match(built.sql, /"card_transactions"\."visibility" in \(/);
    assert.ok(built.params.includes('household'));
    assert.ok(built.params.includes('summary_only'));
  });

  it('가구 경계와 승인 행 조건이 함께 걸린다', () => {
    assert.match(built.sql, /"card_transactions"\."household_id" = \$/);
    assert.match(built.sql, /"card_transactions"\."transaction_type" = \$/);
    assert.match(built.sql, /"card_transactions"\."excluded_at" is null/);
  });

  it('GROUP BY는 ordinal이다 — 표현식을 다시 넘기면 placeholder가 어긋난다', () => {
    assert.match(built.sql, /group by 1$/);
  });
});
