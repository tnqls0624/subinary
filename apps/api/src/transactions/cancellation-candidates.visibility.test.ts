/**
 * 저장 경로(`linkCancellation`)의 공개범위 판정.
 *
 * 이 판정이 없던 동안 후보 목록은 타인의 `private` 승인을 주지 않는데 저장은
 * 허용해, UUID만 알면 남의 비공개 승인에 **쓰기**가 됐고 응답이 그 승인을
 * 마스킹 없이 돌려줬다. 후보 목록이 타인의 `summary_only` 승인 id를 주므로
 * 추측 없이 도달할 수 있는 경로였다.
 */
import { describe, expect, it } from 'vitest';

import { actorCanSeeApproval } from './cancellation-candidates';

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

describe('actorCanSeeApproval — 저장 경로 공개범위', () => {
  it('본인 행은 visibility와 무관하게 허용한다', () => {
    for (const visibility of ['private', 'household', 'summary_only']) {
      expect(actorCanSeeApproval({ memberId: ME, visibility }, ME)).toBe(true);
    }
  });

  it('타인의 private은 막는다 — 이게 이 판정의 존재 이유다', () => {
    expect(
      actorCanSeeApproval({ memberId: OTHER, visibility: 'private' }, ME),
    ).toBe(false);
  });

  it('타인의 household·summary_only는 허용한다 (후보 목록과 같은 범위)', () => {
    expect(
      actorCanSeeApproval({ memberId: OTHER, visibility: 'household' }, ME),
    ).toBe(true);
    expect(
      actorCanSeeApproval({ memberId: OTHER, visibility: 'summary_only' }, ME),
    ).toBe(true);
  });

  it('권한(owner/admin) 예외가 없다', () => {
    // 이 함수는 역할을 인자로 받지 않는다. 받게 되는 순간 "owner는 볼 수 없는
    // 거래를 고칠 수 있다"가 되어 visibilityScope()와 규약이 갈라진다.
    expect(actorCanSeeApproval.length).toBe(2);
  });
});
