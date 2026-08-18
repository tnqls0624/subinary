/**
 * 펜스 **범위** 아키텍처 테스트 — 이 작업에서 가장 중요한 안전장치.
 *
 * 가드가 붙은 자리를 소스에서 직접 읽어 고정한다. 단위 테스트로는
 * "가드가 켜지면 503"까지만 증명되고, **"어디에 붙었는가"는 증명되지 않는다.**
 * 그런데 이 작업에서 틀리면 가장 비싼 실수가 정확히 그것이다:
 *
 *  - ⛔ **카드문자 수집을 막으면 그 결제는 영영 유실된다.** 카드 문자는 재전송이 없다.
 *  - ⛔ 읽기를 막으면 펜스 중에 가족이 앱을 볼 수 없다.
 *  - ⛔ 4개 중 하나라도 빠지면 펜스가 헛돈다(그 경로로 금액이 쓰인다).
 *
 * 그래서 "무엇이 막히고 무엇이 안 막히는가"를 파일에서 기계적으로 확인한다.
 * 나중에 누가 `@UseGuards`를 컨트롤러 클래스에 통째로 올리면 이 테스트가 깨진다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 소스 루트(`apps/api/src`). `import.meta.url`을 쓰지 않는 이유는 이 패키지의
 * tsconfig가 CommonJS로 타입체크하기 때문이다(TS1470). vitest는 저장소 루트가 아니라
 * 패키지 루트(`apps/api`)에서 돌므로 cwd 기준이 안정적이다.
 */
const SRC_ROOT = resolve(process.cwd(), 'src');
const src = (relative: string): string =>
  readFileSync(resolve(SRC_ROOT, relative), 'utf8');

const GUARD = 'MoneyWriteFenceGuard';

/**
 * `@UseGuards(MoneyWriteFenceGuard)` 바로 아래(데코레이터 사이 포함)에 오는
 * 핸들러 이름을 모은다. 클래스 레벨 적용은 별도로 검사한다.
 */
function fencedHandlers(source: string): string[] {
  const lines = source.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(`@UseGuards(${GUARD})`)) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      const match = /^\s{2}(?:async\s+)?([a-zA-Z_]\w*)\s*\(/.exec(lines[j]);
      if (match) {
        found.push(match[1]);
        break;
      }
    }
  }
  return found.sort();
}

/** 데코레이터가 클래스 선언에 붙었는지(= 컨트롤러 전체가 막히는지). */
function guardedAtClassLevel(source: string): boolean {
  return new RegExp(`@UseGuards\\(${GUARD}\\)\\s*\\n\\s*(?:export\\s+)?class`).test(
    source,
  );
}

describe('막는 것 — ADR-0027 5단계가 지정한 정확히 4개 경로', () => {
  it('수동 입력: manual-text · manual-fields', () => {
    const source = src('card-sms/manual-entry.controller.ts');
    expect(fencedHandlers(source)).toEqual(['manualFields', 'manualText']);
  });

  it('사람 검토 확정: review', () => {
    const source = src('card-sms/card-sms-events.controller.ts');
    expect(fencedHandlers(source)).toEqual(['review']);
  });

  it('금액 수정 · 취소 연결: update · linkCancellation', () => {
    const source = src('transactions/transaction.controller.ts');
    expect(fencedHandlers(source)).toEqual(['linkCancellation', 'update']);
  });
});

describe('⛔ 절대 막으면 안 되는 것', () => {
  it('카드문자 수집 컨트롤러에는 펜스가 없다 — 문자는 재전송이 없다', () => {
    // 막는 순간 그 결제는 영영 유실된다. 수집은 card_sms_events + data_events를
    // 한 트랜잭션으로 쓰고 worker가 멈춰도 Postgres에 남으므로 열어 두는 것이 안전하다.
    const source = src('card-sms/card-sms.controller.ts');
    expect(source).not.toContain(GUARD);
  });

  it('상태 없는 파싱 미리보기는 막지 않는다 (쓰기가 아니다)', () => {
    const source = src('card-sms/manual-entry.controller.ts');
    expect(fencedHandlers(source)).not.toContain('parsePreview');
  });

  it('읽기 컨트롤러(거래 목록·상세)는 클래스 레벨로 막히지 않는다', () => {
    // 클래스에 통째로 걸면 모든 GET까지 503이 된다 — 펜스 중에도 가족은 앱을 봐야 한다.
    for (const file of [
      'transactions/transaction.controller.ts',
      'card-sms/card-sms-events.controller.ts',
      'card-sms/manual-entry.controller.ts',
    ]) {
      expect(guardedAtClassLevel(src(file))).toBe(false);
    }
  });

  it('분석·예산·가족 등 다른 도메인 컨트롤러에는 펜스가 없다', () => {
    for (const file of [
      'analytics/analytics.controller.ts',
      'budgets/budget.controller.ts',
      'household/household.controller.ts',
      'auth/auth.controller.ts',
    ]) {
      expect(src(file)).not.toContain(GUARD);
    }
  });
});

describe('막지 않기로 한 것 — 판단을 코드에 남긴다', () => {
  it('mark-duplicate · mark-valid · exclude · include · delete는 펜스 밖이다', () => {
    // 이들은 `status`/`excludedAt`을 바꾼다. `status`는 MONEY_PROTECTED_COLUMNS에
    // 들어 있지만 **금액을 만들거나 환산하지 않는다** — ADR 5단계가 막으라고 한 것은
    // "수동 입력·검토·금액 수정/취소 연결"이고, 이들은 그 목록에 없다.
    // 넓히면 펜스 중 사용자가 할 수 있는 일이 더 줄고, 얻는 안전은 없다.
    // (다만 전환 중 이 값이 바뀌면 수리 manifest의 체크섬이 달라져 자동 되돌림이
    //  보수적으로 멈춘다 — 멈추는 쪽이 덮어쓰는 쪽보다 안전하다.)
    const source = src('transactions/transaction.controller.ts');
    const fenced = fencedHandlers(source);
    for (const handler of [
      'markDuplicate',
      'markValid',
      'exclude',
      'include',
      'remove',
    ]) {
      expect(fenced).not.toContain(handler);
    }
  });
});
