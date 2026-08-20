/**
 * 공용 카드 집계 규약을 소스에서 고정한다.
 *
 * 이 기능의 핵심은 **하지 않는 것**에 있다: 금액을 지분으로 쪼개지 않고, 거래 행을
 * UPDATE하지 않는다. 둘 중 하나라도 들어오면 설계가 무너지는데, 단위 테스트로는
 * "계산이 맞다"까지만 증명되고 그 두 가지는 드러나지 않는다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');
const analytics = readFileSync(resolve(SRC, 'analytics/analytics.service.ts'), 'utf8');
const cardService = readFileSync(resolve(SRC, 'cards/card.service.ts'), 'utf8');

describe('구성원 집계의 공용 버킷', () => {
  it('isShared를 읽어 버킷을 가른다', () => {
    expect(analytics).toContain('paymentCards.isShared');
    expect(analytics).toContain("'공용'");
  });

  it('카드 조인은 left join이다 — 미연결 거래가 사라지면 안 된다', () => {
    // inner join으로 바꾸면 카드 없는 거래(수기 입력 등)가 구성원 집계에서 통째로 빠져
    // 합계가 조용히 줄어든다.
    const block = analytics.slice(
      analytics.indexOf('const bucketId'),
      analytics.indexOf('.orderBy(desc(netExpr))', analytics.indexOf('const bucketId')),
    );
    expect(block).toContain('.leftJoin(');
    expect(block).not.toMatch(/\.innerJoin\(\s*schema\.paymentCards/);
  });

  it('groupBy가 버킷 표현식을 쓴다 — memberId 원본으로 묶으면 공용이 갈라진다', () => {
    expect(analytics).toContain('.groupBy(bucketId, bucketName)');
  });
});

describe('공용 표시는 거래를 건드리지 않는다', () => {
  it('isShared 처리가 거래를 건드리지 않는다', () => {
    // 소급이 자동으로 되는 이유가 이것이다 — 집계가 조인 시점에 플래그를 읽으므로
    // 과거 거래를 고칠 필요가 없고, 되돌리기는 플래그를 끄는 것으로 끝난다.
    //
    // 파일 전체를 보지 않는다: 카드 **등록** 경로에는 미연결 거래를 새 카드에 잇는
    // 백필이 원래 있고(그건 이 기능과 무관하다), 그것까지 금지하면 검사가 거짓이 된다.
    const start = cardService.indexOf('input.isShared !== undefined');
    expect(start).toBeGreaterThan(0);
    const block = cardService.slice(start, cardService.indexOf('patch.isShared', start) + 40);
    expect(block).not.toContain('cardTransactions');
    expect(block).not.toContain('.update(');
  });

  it('금액을 지분으로 쪼개는 흔적이 없다', () => {
    // 50/50은 실측이 아니라 가정이다. 소수 지분은 KRW 정수 불변식과
    // "거래 1건 = member 1명" 규약을 둘 다 깬다.
    for (const forbidden of ['* 0.5', '/ 2', 'share', 'split']) {
      expect(analytics.toLowerCase()).not.toContain(`${forbidden} `);
    }
  });
});

describe('나만 보기와 공용은 함께 성립하지 않는다', () => {
  it('private + isShared 조합을 거절한다', () => {
    // "같이 쓰는데 나만 본다"는 모순이고, 그 조합에서는 집계가 사람마다 달라진다.
    const block = cardService.slice(cardService.indexOf('input.isShared !== undefined'));
    expect(block).toContain("'private'");
    expect(block).toContain('BadRequestException');
  });
});
