/**
 * 소급 재분류의 **경계 조건**을 소스에서 직접 읽어 고정하는 아키텍처 테스트.
 *
 * 단위 테스트로는 "함수가 옳게 계산한다"까지만 증명되고, 이 기능에서 틀리면 가장 비싼
 * 것은 계산이 아니라 **어떤 행을 건드렸는가**다:
 *
 *  - ⛔ 공개범위를 빼면 남의 private 거래를 세거나 바꾼다(P0-6이 실제로 그 경로였다).
 *  - ⛔ 금액 컬럼을 함께 쓰면 ADR-0027이 세운 초크포인트를 우회하는 새 쓰기 경로가 된다.
 *  - ⛔ 미리보기와 적용이 다른 조건을 쓰면 사용자가 동의한 숫자와 결과가 갈린다.
 *
 * 그래서 "무엇이 WHERE에 들어가는가"를 파일에서 기계적으로 확인한다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// `import.meta.url`을 쓰지 않는다 — 이 패키지 tsconfig는 CJS로 타입체크한다(TS1470).
const SRC = resolve(process.cwd(), 'src');
const source = readFileSync(resolve(SRC, 'transactions/recategorize.service.ts'), 'utf8');

describe('대상 선정은 한 곳에서만 정의된다', () => {
  it('collectTargets가 유일한 대상 선정 지점이다', () => {
    // 미리보기·적용·규칙목록이 각자 쿼리를 짜면 숫자가 갈린다.
    const selects = source.match(/\.from\(schema\.cardTransactions\)/g) ?? [];
    expect(selects).toHaveLength(1);
  });

  it('미리보기와 적용이 모두 collectTargets를 부른다', () => {
    for (const method of ['async preview(', 'async apply(']) {
      const body = source.slice(source.indexOf(method));
      const nextMethod = body.slice(1).search(/\n  (async |\/\*\*)/);
      expect(body.slice(0, nextMethod)).toContain('this.collectTargets(');
    }
  });
});

describe('공개범위와 쓰기 범위를 둘 다 통과시킨다', () => {
  it('visibilityScope가 대상 선정에 있다', () => {
    // 하드 플로어 — 볼 수 없는 것은 세지도 바꾸지도 않는다.
    expect(source).toContain('visibilityScope(actor.memberId)');
  });

  it('mutableByActor가 대상 선정에 있다', () => {
    // 쓰기 상한 — 읽기보다 좁다(타인 summary_only 제외).
    expect(source).toContain('mutableByActor(actor.memberId, actor.privileged)');
  });

  it('가구 경계를 직접 붙인다 — visibilityScope는 member 축만 담당한다', () => {
    expect(source).toContain('eq(schema.cardTransactions.householdId, householdId)');
  });

  it('공개범위 조건을 손으로 다시 적지 않는다', () => {
    // 사본을 만드는 순간 규칙이 갈라지고, 갈라진 지점이 곧 유출이다.
    expect(source).not.toMatch(/visibility.*['"]summary_only['"]/);
  });
});

describe('금액 컬럼을 쓰지 않는다', () => {
  it('거래 UPDATE의 set은 카테고리와 updatedAt뿐이다', () => {
    const sets = source.match(/\.set\(\{[^}]*\}\)/g) ?? [];
    const txnSets = sets.filter((s) => s.includes('categoryId'));
    expect(txnSets.length).toBeGreaterThan(0);
    for (const set of txnSets) {
      for (const forbidden of [
        'amount',
        'netAmount',
        'cancelledAmount',
        'currency',
        'originalAmount',
        'exchangeRate',
        'approvedAt',
        'fxRateSnapshotId',
      ]) {
        expect(set).not.toContain(forbidden);
      }
    }
  });

  it('set에 변수를 넘기지 않는다 — 스캐너가 컬럼을 판정할 수 있어야 한다', () => {
    // `.set(updates)`처럼 변수를 주면 아키텍처 스캐너가 `<dynamic>` 위반으로 세고,
    // 그 리포트는 이미 상한(12)에 닿아 있다.
    expect(source).not.toMatch(/\.set\([a-zA-Z_$][\w$]*\)/);
  });
});

describe('되돌리기는 최신 수정을 덮어쓰지 않는다', () => {
  it('현재 값이 batch 적용값과 같은 행만 복원한다', () => {
    const revert = source.slice(source.indexOf('async revert('));
    expect(revert).toContain('eq(schema.cardTransactions.categoryId, batch.toCategoryId)');
  });

  it('건너뛴 건수를 숨기지 않는다', () => {
    expect(source).toContain('skippedCount');
  });
});

describe('사용자가 동의한 숫자로만 적용한다', () => {
  it('expectedCount가 다르면 거부한다', () => {
    const apply = source.slice(source.indexOf('async apply('));
    expect(apply).toContain('input.expectedCount');
    expect(apply).toContain('ConflictException');
  });

  it('상한을 넘으면 거부한다', () => {
    expect(source).toContain('MAX_TARGETS');
  });
});

describe('학습 계보를 짝으로 남긴다', () => {
  it('규칙 upsert와 feedback_events insert가 함께 있다', () => {
    // 규칙만 쓰면 데이터셋 빌드가 'lineage is incomplete or stale'로 죽는다.
    expect(source).toContain('schema.merchantCategoryRules');
    expect(source).toContain('schema.feedbackEvents');
    expect(source).toContain('createMerchantCategoryTargetId');
  });

  it('revoke 연쇄를 복사하지 않고 공용 함수를 부른다', () => {
    expect(source).toContain('revokeMerchantRuleLineage');
    // 세 번째 사본이 생기면 다섯 테이블 중 하나를 빠뜨린 사본이 조용히 남는다.
    expect(source).not.toContain('schema.datasetSnapshots');
    expect(source).not.toContain('schema.modelAliases');
  });
});
