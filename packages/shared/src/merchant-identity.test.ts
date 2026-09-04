/**
 * 브랜드/지점 구조 추출과 병합 후보 — 운영 실측을 그대로 고정한다.
 *
 * 이름과 건수·금액은 2026-09-04 프로덕션 `merchant_normalized` 실값이다(거래 264건,
 * 서로 다른 이름 102개). 사전을 손볼 때 "실제 데이터에서 무엇이 묶이고 무엇이
 * 안 묶이는지"가 바뀌면 여기서 걸린다.
 *
 * **가장 중요한 블록은 "절대 묶여서는 안 되는 것"이다.** 잘못 묶으면 두 회사의 지출이
 * 한 이름으로 합쳐지고, 되돌려도 사용자가 그 사이 본 숫자는 이미 틀렸다.
 */
import { describe, expect, it } from 'vitest';

import {
  MERCHANT_BRANDS,
  extractMerchantIdentity,
  findMerchantIdentityCandidates,
  rollupByMerchantBrand,
  type MerchantIdentityInput,
} from './merchant-identity.js';

const row = (
  name: string,
  transactionCount = 1,
  netTotal = 1000,
  aliasOf: string | null = null,
): MerchantIdentityInput => ({ name, transactionCount, netTotal, aliasOf });

/* -------------------------------------------------------------------------- */

describe('extractMerchantIdentity — 브랜드를 떼고 지점을 남긴다', () => {
  it('음차 차이를 같은 브랜드·같은 지점으로 읽는다', () => {
    // 실측: 지에스25 영등포도림(11건 67,850) / GS25영등포도림(7건 29,300)
    const a = extractMerchantIdentity('지에스25 영등포도림');
    const b = extractMerchantIdentity('GS25영등포도림');
    expect(a.brand).toBe('GS25');
    expect(b.brand).toBe('GS25');
    // 브랜드를 뗀 뒤의 공백은 구분자일 뿐이라 지운다.
    expect(a.branch).toBe('영등포도림');
    expect(b.branch).toBe('영등포도림');
  });

  it('일치한 토큰 원문을 근거로 남긴다(사전 id가 아니라)', () => {
    // 화면이 "지에스25를 GS25로 읽었다"를 보여줘야 사용자가 판정을 검증한다.
    expect(extractMerchantIdentity('지에스25여의캐').matchedToken).toBe('지에스25');
    expect(extractMerchantIdentity('GS25S2신도').matchedToken).toBe('GS25');
  });

  it('브랜드 이름만 있고 지점이 없으면 branch가 빈 문자열이다', () => {
    expect(extractMerchantIdentity('아성다이소')).toMatchObject({
      brand: '다이소',
      branch: '',
    });
    expect(extractMerchantIdentity('다이소아성산업')).toMatchObject({
      brand: '다이소',
      branch: '',
    });
  });

  it('사전에 없는 이름은 미판정이다 — 실패가 아니다', () => {
    // 실측 상위 가맹점 중 브랜드 사전에 없는 것들.
    for (const name of ['벤디스', '영등포구청', '팀오투', 'ANTHROPIC*CLAUDESUB']) {
      expect(extractMerchantIdentity(name)).toEqual({
        brand: null,
        branch: '',
        matchedToken: null,
      });
    }
  });

  it('빈 입력과 비문자열에 던지지 않는다', () => {
    expect(extractMerchantIdentity('').brand).toBeNull();
    expect(extractMerchantIdentity(undefined as unknown as string).brand).toBeNull();
  });

  it('결정적이다 — 같은 입력이면 항상 같은 출력', () => {
    const names = ['지에스25 영등포도림', '이마트24 센트럴', '쿠팡플레이', '올리브약국'];
    const first = names.map((n) => extractMerchantIdentity(n));
    for (let i = 0; i < 5; i += 1) {
      expect(names.map((n) => extractMerchantIdentity(n))).toEqual(first);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('extractMerchantIdentity — 최장 일치로 경계를 지킨다', () => {
  it('이마트24를 이마트로 떼지 않는다 (다른 회사)', () => {
    // 실측: 이마트 신(2건 149,080) / 이마트24 센트럴(1건)
    expect(extractMerchantIdentity('이마트24 센트럴').brand).toBe('이마트24');
    expect(extractMerchantIdentity('이마트 신').brand).toBe('이마트');
  });

  it('쿠팡플레이를 쿠팡으로 떼지 않는다 (다른 서비스)', () => {
    // 쿠팡은 실측 27건 504,680원으로 가장 큰 가맹점이다. 쿠팡플레이(3건 1,300원)에
    // 묶이면 가장 큰 숫자가 오염된다.
    expect(extractMerchantIdentity('쿠팡플레이').brand).toBe('쿠팡플레이');
    expect(extractMerchantIdentity('쿠팡').brand).toBe('쿠팡');
  });

  it('지에스더프레시를 GS25로 떼지 않는다 (다른 업태)', () => {
    expect(extractMerchantIdentity('지에스더프레시 안산초').brand).toBe('GS더프레시');
  });
});

/* -------------------------------------------------------------------------- */

describe('MERCHANT_BRANDS — 사전에 있어서는 안 되는 토큰', () => {
  const allTokens = MERCHANT_BRANDS.flatMap((e) => e.tokens);

  it('"올리브"를 브랜드 토큰으로 두지 않는다', () => {
    // 실측 `올리브약국`(1건)이 올리브영으로 잡힌다 — 약국과 화장품 매장이다.
    expect(allTokens).not.toContain('올리브');
    expect(extractMerchantIdentity('올리브약국').brand).toBeNull();
    expect(extractMerchantIdentity('올리브영신도림테크노').brand).toBe('올리브영');
  });

  it('"홈플러스"를 브랜드 토큰으로 두지 않는다', () => {
    // `홈플러스익스프레스`(1건)는 대형마트가 아니라 별도 업태(SSM)다. 묶을 짝이
    // 없어 실익이 0인데 오분류 위험만 남는다.
    expect(allTokens).not.toContain('홈플러스');
    expect(extractMerchantIdentity('홈플러스익스프레스').brand).toBeNull();
  });

  it('결제 대행을 브랜드 토큰으로 두지 않는다', () => {
    // 실제 가맹점을 모른다 — 지어내지 않는다.
    for (const token of ['카카오', '토스페이', '네이버페이', '발트페이']) {
      expect(allTokens).not.toContain(token);
    }
    expect(extractMerchantIdentity('토스페이').brand).toBeNull();
    expect(extractMerchantIdentity('네이버페이').brand).toBeNull();
  });

  it('같은 토큰이 두 브랜드에 중복 등록되지 않았다', () => {
    // 중복이 있으면 최장 일치 정렬이 사전순 tie-break으로 넘어가 판정이 사전의
    // 나열 순서와 무관하게 정해진다 — 결정적이긴 하지만 의도한 브랜드가 아니다.
    const seen = new Map<string, string>();
    for (const entry of MERCHANT_BRANDS) {
      for (const token of entry.tokens) {
        const key = token.toUpperCase();
        expect(seen.has(key), `중복 토큰: ${token}`).toBe(false);
        seen.set(key, entry.id);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('findMerchantIdentityCandidates — 절대 묶여서는 안 되는 것', () => {
  it('브랜드가 다르면 지점명이 같아도 묶지 않는다 (CU vs GS25)', () => {
    // 실측: 씨유영등포도림(1건 10,940) / GS25영등포도림(7건 29,300).
    // 지명이 같아 어떤 문자열 유사도로도 높게 나오지만 **경쟁 브랜드**다.
    const groups = findMerchantIdentityCandidates([
      row('씨유영등포도림', 1, 10_940),
      row('GS25영등포도림', 7, 29_300),
    ]);
    expect(groups).toEqual([]);
  });

  it('이마트와 이마트24를 묶지 않는다', () => {
    const groups = findMerchantIdentityCandidates([
      row('이마트 신', 2, 149_080),
      row('이마트24 센트럴', 1, 3_000),
    ]);
    expect(groups).toEqual([]);
  });

  it('쿠팡과 쿠팡플레이를 묶지 않는다', () => {
    const groups = findMerchantIdentityCandidates([
      row('쿠팡', 27, 504_680),
      row('쿠팡플레이', 3, 1_300),
    ]);
    expect(groups).toEqual([]);
  });

  it('미판정 이름끼리 묶지 않는다', () => {
    // 브랜드를 모르는 이름들이 "기타"로 한 묶음이 되면 없는 사실을 만든다.
    const groups = findMerchantIdentityCandidates([
      row('벤디스', 18, 46_200),
      row('팀오투', 8, 283_642),
      row('영등포구청', 20, 2_849),
    ]);
    expect(groups).toEqual([]);
  });

  it('이미 별칭인 이름은 후보가 아니다', () => {
    const groups = findMerchantIdentityCandidates([
      row('지에스25 영등포도림', 11, 67_850),
      row('GS25영등포도림', 7, 29_300, '지에스25 영등포도림'),
    ]);
    expect(groups).toEqual([]);
  });

  it('excludeNames로 다른 제안이 다루는 이름을 뺀다', () => {
    // 절단 제안이 먼저 다루는 묶음이 여기서 또 나오면 사용자가 두 번 처리한다.
    const items = [row('씨유영등포', 2, 24_040), row('씨유영등포도림', 1, 10_940)];
    expect(findMerchantIdentityCandidates(items)).toHaveLength(1);
    expect(
      findMerchantIdentityCandidates(items, {
        excludeNames: new Set(['씨유영등포', '씨유영등포도림']),
      }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('findMerchantIdentityCandidates — 잡아야 하는 것', () => {
  it('음차 차이를 같은 매장으로 제안하고 지출 큰 이름을 대표로 삼는다', () => {
    const groups = findMerchantIdentityCandidates([
      row('지에스25 영등포도림', 11, 67_850),
      row('GS25영등포도림', 7, 29_300),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      brand: 'GS25',
      reason: 'brand_notation',
      canonical: '지에스25 영등포도림',
      aliases: ['GS25영등포도림'],
      transactionCount: 18,
      netTotal: 97_150,
    });
  });

  it('어순 차이(법인명 표기)를 같은 브랜드·지점 없음으로 제안한다', () => {
    // 실측: 다이소아성산업(4건 26,000) / 아성다이소(2건 19,500).
    // 둘 다 지점 정보가 없어 "이 이름으로는 매장을 특정할 수 없다"가 같다.
    const groups = findMerchantIdentityCandidates([
      row('다이소아성산업', 4, 26_000),
      row('아성다이소', 2, 19_500),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      brand: '다이소',
      reason: 'brand_notation',
      canonical: '다이소아성산업',
      aliases: ['아성다이소'],
    });
  });

  it('지점명 절단을 별도 사유로 제안한다', () => {
    // 실측: 지에스25영등포(3건 18,500) / 지에스25 영등포도림(11건 67,850).
    // 전체 이름으로는 접두가 아니어서 findTruncationCandidates가 놓친다 —
    // 브랜드를 떼면 `영등포` ⊂ `영등포도림`이 드러난다.
    const groups = findMerchantIdentityCandidates([
      row('지에스25영등포', 3, 18_500),
      row('지에스25 영등포도림', 11, 67_850),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      reason: 'brand_branch_prefix',
      // 절단이 의심되면 정보가 많은 긴 쪽을 대표로 남긴다.
      canonical: '지에스25 영등포도림',
      aliases: ['지에스25영등포'],
    });
  });

  it('근거에 각 이름의 브랜드 토큰과 지점을 담는다', () => {
    const [group] = findMerchantIdentityCandidates([
      row('지에스25 영등포도림', 11, 67_850),
      row('GS25영등포도림', 7, 29_300),
    ]);
    expect(group?.evidence).toEqual([
      { name: '지에스25 영등포도림', matchedToken: '지에스25', branch: '영등포도림' },
      { name: 'GS25영등포도림', matchedToken: 'GS25', branch: '영등포도림' },
    ]);
  });

  it('같은 이름이 표기 차이와 절단 제안에 동시에 나오지 않는다', () => {
    // GS25 실측 전체. 영등포도림 2표기는 brand_notation으로 묶이고, 그 뒤 절단
    // 판정에서 다시 나오면 사용자가 같은 가게를 두 번 처리한다.
    const groups = findMerchantIdentityCandidates([
      row('지에스25 영등포도림', 11, 67_850),
      row('GS25영등포도림', 7, 29_300),
      row('지에스25여의캐', 7, 23_100),
      row('지에스25영등포', 3, 18_500),
      row('지에스25S9샛강', 1, 2_000),
      row('GS25S2신도', 1, 1_500),
    ]);
    const notation = groups.filter((g) => g.reason === 'brand_notation');
    expect(notation).toHaveLength(1);
    const claimed = new Set(notation.flatMap((g) => [g.canonical, ...g.aliases]));
    for (const g of groups.filter((x) => x.reason === 'brand_branch_prefix')) {
      for (const name of [g.canonical, ...g.aliases]) {
        expect(claimed.has(name), `${name}이 두 제안에 있다`).toBe(false);
      }
    }
  });

  it('지점 없는 이름을 지점 있는 이름에 흡수하지 않는다', () => {
    // 빈 지점은 모든 문자열의 접두다. BRANCH_MIN_PREFIX_LENGTH가 이것을 막는다.
    // 실측 세 쌍 모두 **다른 매장**이라 막는 것이 맞다.
    for (const pair of [
      [row('한국맥도날드', 1, 11_100), row('맥도날드안산고잔', 2, 18_400)],
      [row('CJCGV', 1, 20_000), row('CJ CGV온라인예매_문화비', 1, 15_500)],
      [row('씨제이올리브영', 2, 72_150), row('올리브영신도림테크노', 1, 18_900)],
    ]) {
      expect(findMerchantIdentityCandidates(pair)).toEqual([]);
    }
  });

  it('표기 차이를 확정하면 다음 라운드에 지점 절단 후보가 드러난다', () => {
    // 실측 GS25 영등포 계열. 1라운드에서는 `지에스25 영등포도림`이 표기 차이 묶음의
    // 대표로 쓰여 `지에스25영등포`의 절단 후보가 나오지 않는다.
    const before = findMerchantIdentityCandidates([
      row('지에스25 영등포도림', 11, 67_850),
      row('GS25영등포도림', 7, 29_300),
      row('지에스25영등포', 3, 18_500),
    ]);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ reason: 'brand_notation' });

    // 사용자가 그 병합을 확정하면 별칭 쪽이 pool에서 빠지고, 절단 후보가 나타난다.
    const after = findMerchantIdentityCandidates([
      row('지에스25 영등포도림', 18, 97_150),
      row('GS25영등포도림', 0, 0, '지에스25 영등포도림'),
      row('지에스25영등포', 3, 18_500),
    ]);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      reason: 'brand_branch_prefix',
      canonical: '지에스25 영등포도림',
      aliases: ['지에스25영등포'],
    });
  });

  it('결정적이다 — 실측 전체를 순서만 바꿔 넣어도 같은 결과', () => {
    const items = [
      row('지에스25 영등포도림', 11, 67_850),
      row('GS25영등포도림', 7, 29_300),
      row('지에스25여의캐', 7, 23_100),
      row('씨유영등포', 2, 24_040),
      row('씨유영등포도림', 1, 10_940),
      row('다이소아성산업', 4, 26_000),
      row('아성다이소', 2, 19_500),
    ];
    const forward = findMerchantIdentityCandidates(items);
    const reversed = findMerchantIdentityCandidates([...items].reverse());
    expect(reversed).toEqual(forward);
  });
});

/* -------------------------------------------------------------------------- */

describe('rollupByMerchantBrand — 이름을 바꾸지 않는 파생 축', () => {
  it('브랜드별로 합산하고 묶인 이름을 지출 큰 순으로 남긴다', () => {
    const rollups = rollupByMerchantBrand([
      row('지에스25 영등포도림', 11, 67_850),
      row('GS25영등포도림', 7, 29_300),
      row('지에스25여의캐', 7, 23_100),
      row('씨유영등포', 2, 24_040),
    ]);
    expect(rollups[0]).toMatchObject({
      brand: 'GS25',
      storeCount: 3,
      transactionCount: 25,
      netTotal: 120_250,
      names: ['지에스25 영등포도림', 'GS25영등포도림', '지에스25여의캐'],
    });
    expect(rollups[1]).toMatchObject({ brand: 'CU', storeCount: 1 });
  });

  it('별칭 행을 이중 계상하지 않는다', () => {
    // 서버가 거래를 대표 이름으로 백필하므로 별칭 행의 건수·금액은 0이지만,
    // 목록에는 이름이 남는다. 여기서 세면 storeCount가 실제보다 커진다.
    const rollups = rollupByMerchantBrand([
      row('지에스25 영등포도림', 18, 97_150),
      row('GS25영등포도림', 0, 0, '지에스25 영등포도림'),
    ]);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ storeCount: 1, transactionCount: 18 });
  });

  it('미판정 이름을 "기타"로 묶지 않는다', () => {
    const rollups = rollupByMerchantBrand([
      row('벤디스', 18, 46_200),
      row('팀오투', 8, 283_642),
    ]);
    expect(rollups).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('MERCHANT_BRANDS — Apple은 브랜드 축만, 병합은 하지 않는다', () => {
  it('두 Apple 이름이 브랜드 축에서만 합산되고 병합 후보가 아니다', () => {
    // `Apple-엔에이치`의 `엔에이치`가 지점인지 카드사 표기인지 알 수 없다.
    // 근거가 없으므로 이름을 합치지 않고 브랜드 합계만 낸다.
    const items = [row('애플코리아', 2, 129_000), row('Apple-엔에이치', 1, 19_500)];
    expect(findMerchantIdentityCandidates(items)).toEqual([]);
    expect(rollupByMerchantBrand(items)[0]).toMatchObject({
      brand: 'Apple',
      storeCount: 2,
      transactionCount: 3,
      netTotal: 148_500,
    });
  });
});
