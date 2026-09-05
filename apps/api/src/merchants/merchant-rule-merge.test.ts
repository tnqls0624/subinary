/**
 * P1-17 회귀 고정 — 별칭 병합이 **사람의 확정을 잃지 않는다**.
 *
 * 종전 코드는 대표에 규칙이 있으면 승격을 건너뛰고 별칭 규칙을 통째로 지웠다. 그래서
 * 대표에 `model_prediction`이 있고 별칭에 사람 확정이 있으면 사람 판단이 사라지고
 * 모델 추측이 남았다. 그 사실은 몇 달 뒤 학습 데이터셋이 깨질 때에야 드러난다 —
 * 그래서 DB 없이 전 분기를 여기서 고정한다.
 */
import { describe, expect, it } from 'vitest';

import {
  CATEGORY_NOT_IN_CONFLICT,
  planMerchantRuleMerge,
  type MerchantRuleRow,
} from './merchant-rule-merge';

const AT = (iso: string): Date => new Date(iso);

function rule(over: Partial<MerchantRuleRow> & Pick<MerchantRuleRow, 'id' | 'merchantPattern'>): MerchantRuleRow {
  return {
    categoryId: 'cat-etc',
    source: 'model_prediction',
    predictionTraceId: null,
    confirmedAt: null,
    createdBy: null,
    updatedAt: AT('2026-08-01T00:00:00Z'),
    ...over,
  };
}

describe('사람 확정이 모델 예측을 이긴다', () => {
  it('대표에 모델 예측이 있어도 별칭의 사람 확정으로 덮는다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '지에스25',
      rules: [
        // 대표 쪽 모델 예측이 **더 최신**이다 — 시각만 보면 사람 확정이 밀린다.
        rule({ id: 'r1', merchantPattern: '지에스25', categoryId: 'cat-etc', updatedAt: AT('2026-08-10T00:00:00Z') }),
        rule({
          id: 'r2',
          merchantPattern: 'gs25',
          categoryId: 'cat-grocery',
          source: 'human_confirmed',
          confirmedAt: AT('2026-07-01T00:00:00Z'),
          createdBy: 'user-1',
          updatedAt: AT('2026-07-01T00:00:00Z'),
        }),
      ],
    });
    expect(plan.conflict).toBeNull();
    expect(plan.canonicalUpsert?.categoryId).toBe('cat-grocery');
    expect(plan.canonicalUpsert?.source).toBe('human_confirmed');
    // 사람 확정을 승계하면 계보를 짝으로 남겨야 한다.
    expect(plan.canonicalUpsert?.writeFeedbackEvent).toBe(true);
  });

  it('모델 예측만 있으면 승계하되 feedback은 쓰지 않는다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '지에스25',
      rules: [rule({ id: 'r1', merchantPattern: 'gs25', categoryId: 'cat-etc' })],
    });
    // 확인하지 않은 추측을 사람 확정으로 둔갑시키면 학습 gold가 오염된다.
    expect(plan.canonicalUpsert?.writeFeedbackEvent).toBe(false);
  });
});

describe('사람 확정이 서로 다르면 시스템이 고르지 않는다', () => {
  it('카테고리가 다른 human_confirmed 2개면 병합을 거부한다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '스타벅스',
      rules: [
        rule({ id: 'r1', merchantPattern: '스타벅스', categoryId: 'cat-cafe', source: 'human_confirmed', createdBy: 'u1' }),
        rule({ id: 'r2', merchantPattern: 'starbucks', categoryId: 'cat-food', source: 'human_confirmed', createdBy: 'u1' }),
      ],
    });
    expect(plan.conflict).not.toBeNull();
    expect(plan.conflict?.categoryIds.sort()).toEqual(['cat-cafe', 'cat-food']);
    // 거부된 계획은 아무것도 쓰지 않는다.
    expect(plan.canonicalUpsert).toBeNull();
    expect(plan.deleteRuleIds).toEqual([]);
  });

  it('같은 카테고리로 확정된 것이 여럿이면 충돌이 아니다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '스타벅스',
      rules: [
        rule({ id: 'r1', merchantPattern: '스타벅스', categoryId: 'cat-cafe', source: 'human_confirmed' }),
        rule({ id: 'r2', merchantPattern: 'starbucks', categoryId: 'cat-cafe', source: 'human_confirmed' }),
      ],
    });
    expect(plan.conflict).toBeNull();
    // 대표가 이미 그 확정을 들고 있으므로 **쓸 것이 없다**(upsert는 null). 불필요한
    // 쓰기를 만들면 `updatedAt`만 흔들려 "무엇이 언제 바뀌었나"가 흐려진다.
    expect(plan.canonicalUpsert).toBeNull();
    // 대표 규칙은 삭제 대상이 아니고, 별칭의 사람 확정은 계보 때문에 남는다.
    expect(plan.deleteRuleIds).not.toContain('r1');
    expect(plan.deleteRuleIds).not.toContain('r2');
  });
});

describe('지우면 안 되는 규칙은 남긴다', () => {
  it('스냅샷이 참조하는 규칙은 삭제 목록에 넣지 않는다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '쿠팡',
      rules: [
        rule({ id: 'r1', merchantPattern: '쿠팡', categoryId: 'cat-shopping', source: 'human_confirmed' }),
        rule({ id: 'r2', merchantPattern: 'coupang', categoryId: 'cat-shopping' }),
      ],
      // FK가 ON DELETE no action이라 지우면 23503으로 트랜잭션 전체가 롤백된다.
      snapshotReferencedRuleIds: new Set(['r2']),
    });
    expect(plan.deleteRuleIds).not.toContain('r2');
    expect(plan.keptRules.find((k) => k.id === 'r2')?.reason).toBe('dataset_snapshot');
  });

  it('별칭 쪽 human_confirmed 규칙은 계보 때문에 남긴다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '쿠팡',
      rules: [
        rule({
          id: 'r2',
          merchantPattern: 'coupang',
          categoryId: 'cat-shopping',
          source: 'human_confirmed',
          createdBy: 'u1',
        }),
      ],
    });
    // feedback_events는 append-only다 — 규칙만 지우면 계보가 짝을 잃고 데이터셋
    // 빌드가 'lineage is incomplete or stale'로 영영 실패한다.
    expect(plan.deleteRuleIds).not.toContain('r2');
    expect(plan.keptRules.find((k) => k.id === 'r2')?.reason).toBe('human_lineage');
  });
});

describe('패턴 rename을 하지 않는다', () => {
  it('승계는 대표 패턴 upsert로 표현된다 (rename 지시가 없다)', () => {
    const plan = planMerchantRuleMerge({
      canonical: '지에스25',
      rules: [rule({ id: 'r1', merchantPattern: 'gs25', categoryId: 'cat-grocery', source: 'human_confirmed' })],
    });
    // targetId = sha256(householdId, merchantPattern)이라 rename은 계보를 끊는다.
    // 계획에는 "어느 패턴에서 왔는가"만 남고, 실제 쓰기는 대표 패턴 upsert다.
    expect(plan.canonicalUpsert?.fromPattern).toBe('gs25');
    expect(Object.keys(plan)).not.toContain('renamePattern');
  });
});

/* -------------------------------------------------------------------------- */

describe('카테고리 충돌을 사용자가 푸는 경로 (resolveCategoryId)', () => {
  /**
   * 2026-09-05 실측: 병합 제안 3건이 **전부** 이 충돌에 걸려 있었다.
   *
   *   지에스25 영등포도림 → 장보기   GS25영등포도림 → 식비
   *   다이소아성산업      → 기타     아성다이소     → 장보기
   *   씨유영등포          → 식비     씨유영등포도림 → 장보기
   *
   * 화면은 "묶으세요"라고 제안하는데 누르면 409로 거부됐다. 거부 자체는 옳지만
   * (시스템이 임의로 고르면 사용자 확정이 사라진다) 빠져나갈 길이 없었다.
   */
  const rules = [
    rule({
      id: 'r-canonical',
      merchantPattern: '지에스25 영등포도림',
      categoryId: 'cat-grocery',
      source: 'human_confirmed',
    }),
    rule({
      id: 'r-alias',
      merchantPattern: 'GS25영등포도림',
      categoryId: 'cat-food',
      source: 'human_confirmed',
    }),
  ];

  it('답이 없으면 종전대로 거부한다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '지에스25 영등포도림',
      rules,
    });
    expect(plan.conflict).not.toBeNull();
    expect(plan.canonicalUpsert).toBeNull();
    expect(plan.deleteRuleIds).toEqual([]);
  });

  it('사용자가 고른 카테고리로 통일한다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '지에스25 영등포도림',
      rules,
      resolveCategoryId: 'cat-food',
    });
    expect(plan.conflict).toBeNull();
    expect(plan.canonicalUpsert).toMatchObject({
      categoryId: 'cat-food',
      source: 'human_confirmed',
      // 사람이 확정한 것이므로 특정 예측의 산물이 아니다.
      predictionTraceId: null,
      writeFeedbackEvent: true,
    });
  });

  it('대표가 이미 그 카테고리면 덮어쓰지 않는다', () => {
    const plan = planMerchantRuleMerge({
      canonical: '지에스25 영등포도림',
      rules,
      resolveCategoryId: 'cat-grocery',
    });
    expect(plan.conflict).toBeNull();
    expect(plan.canonicalUpsert).toBeNull();
  });

  it('충돌 후보 밖의 카테고리는 거부한다', () => {
    // 사용자가 보지 못한 제3의 카테고리로 과거 거래가 옮겨가면 확정이 아니라 사고다.
    const plan = planMerchantRuleMerge({
      canonical: '지에스25 영등포도림',
      rules,
      resolveCategoryId: 'cat-transport',
    });
    expect(plan.conflict?.reason).toBe(CATEGORY_NOT_IN_CONFLICT);
    expect(plan.canonicalUpsert).toBeNull();
  });

  it('진 쪽의 사람 확정 규칙을 지우지 않는다', () => {
    // 그때 그렇게 판단했다는 사실은 학습 계보다. 지금 답이 갈렸다고 과거 판단을
    // 없던 일로 만들지 않는다.
    const plan = planMerchantRuleMerge({
      canonical: '지에스25 영등포도림',
      rules,
      resolveCategoryId: 'cat-food',
    });
    expect(plan.deleteRuleIds).not.toContain('r-alias');
    expect(plan.keptRules).toContainEqual({
      id: 'r-alias',
      merchantPattern: 'GS25영등포도림',
      reason: 'human_lineage',
    });
  });

  it('충돌이 없으면 resolveCategoryId를 무시한다', () => {
    // 갈리지 않은 확정을 사용자 선택으로 덮으면 조용히 카테고리가 바뀐다.
    const plan = planMerchantRuleMerge({
      canonical: '지에스25 영등포도림',
      rules: [rules[0] as MerchantRuleRow],
      resolveCategoryId: 'cat-food',
    });
    expect(plan.conflict).toBeNull();
    expect(plan.canonicalUpsert).toBeNull();
  });
});
