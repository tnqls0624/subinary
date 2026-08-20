/**
 * 절단 변종 감지 — 운영 실측 데이터를 그대로 고정한다.
 *
 * 이름 목록은 2026-08-20 프로덕션 `merchant_normalized` 실값이다. 규칙을 손볼 때
 * "실제 데이터에서 무엇이 잡히고 무엇이 안 잡히는지"가 바뀌면 여기서 걸린다.
 */
import { describe, expect, it } from 'vitest';

import {
  findTruncationCandidates,
  type TruncationCandidateInput,
} from './merchant-truncation.js';

const row = (
  name: string,
  transactionCount = 1,
  netTotal = 1000,
  aliasOf: string | null = null,
): TruncationCandidateInput => ({
  name,
  transactionCount,
  netTotal,
  aliasOf,
});

describe('findTruncationCandidates — 잡아야 하는 것', () => {
  it('접두 관계를 이행적으로 한 묶음으로 만든다', () => {
    // 실측: 세븐일레븐중구E(3건 8,500) / ENA(4건 14,800) / ENA센터(1건 3,000)
    const groups = findTruncationCandidates([
      row('세븐일레븐중구E', 3, 8500),
      row('세븐일레븐중구ENA', 4, 14800),
      row('세븐일레븐중구ENA센터', 1, 3000),
    ]);
    expect(groups).toHaveLength(1);
    // 쌍이 아니라 셋이 한 번에 묶여야 한다 — 아니면 사용자가 두 번 묶는다.
    expect(groups[0]?.aliases).toHaveLength(2);
    expect(groups[0]?.transactionCount).toBe(8);
    expect(groups[0]?.netTotal).toBe(26300);
  });

  it('대표는 가장 긴 이름이다 (지출이 큰 쪽이 아니다)', () => {
    // 절단된 쪽이 더 많이 쌓일 수 있다. 그쪽을 대표로 삼으면 지점 정보를 잃는다.
    const groups = findTruncationCandidates([
      row('카카오T일반택시', 3, 41400),
      row('카카오T일반택시_0', 1, 3000),
    ]);
    expect(groups[0]?.canonical).toBe('카카오T일반택시_0');
    expect(groups[0]?.aliases).toEqual(['카카오T일반택시']);
  });

  it('공백은 이름의 일부다 — 지우지 않는다', () => {
    // 절단은 꼬리를 자르므로 접두를 공백까지 보존한다. 공백 없는 짧은 이름은
    // 절단이 아니라 카드사가 다른 형식으로 보낸 것이다(브랜드·지점 병합 = 제품 결정).
    expect(
      findTruncationCandidates([
        row('지에스25 영등포도림', 8, 46050),
        row('지에스25영등포', 1, 8200),
      ]),
    ).toEqual([]);
    // 공백까지 같으면 정상적으로 잡힌다.
    expect(
      findTruncationCandidates([
        row('지에스25 영등포도림', 8, 46050),
        row('지에스25 영등포', 1, 8200),
      ]),
    ).toHaveLength(1);
  });

  it('큰 덩어리부터 제안한다', () => {
    const groups = findTruncationCandidates([
      row('메가엠지씨커피', 2, 9500),
      row('메가엠지씨커피도', 1, 3700),
      row('우아한형', 3, 46500),
      row('우아한형제들', 1, 22395),
    ]);
    expect(groups[0]?.netTotal).toBe(68895);
    expect(groups[1]?.netTotal).toBe(13200);
  });
});

describe('findTruncationCandidates — 잡으면 안 되는 것', () => {
  it('짧은 이름의 우연한 접두는 제안하지 않는다', () => {
    // `쿠팡` ⊂ `쿠팡플레이`는 실제로 다른 서비스다(실측: 각각 20건/2건).
    // 이런 제안 하나가 도구의 신뢰를 깎는다.
    expect(
      findTruncationCandidates([
        row('쿠팡', 20, 445180),
        row('쿠팡플레이', 2, 5200),
      ]),
    ).toEqual([]);
  });

  it('로마자↔한글 음차는 감지하지 않는다 (사람만 아는 판단)', () => {
    // 실측 12건 58,850원이지만 접두 관계가 아니다. 음차 표를 만들면 오병합이 시작된다.
    expect(
      findTruncationCandidates([
        row('지에스25 영등포도림', 8, 46050),
        row('GS25영등포도림', 4, 12800),
      ]),
    ).toEqual([]);
  });

  it('브랜드가 같아도 접두가 아니면 묶지 않는다', () => {
    // 지점별 vs 브랜드별은 제품 결정이고 ADR-0019가 답하지 않는다.
    expect(
      findTruncationCandidates([
        row('씨제이올리브영', 2, 72150),
        row('올리브영신도림테크노', 1, 18900),
      ]),
    ).toEqual([]);
  });

  it('이름이 비슷한 다른 업종을 묶지 않는다', () => {
    // `올리브약국`(약국)과 `올리브영...`(화장품)은 접두 관계가 아니다.
    expect(
      findTruncationCandidates([
        row('올리브약국', 1, 4000),
        row('올리브영신도림테크노', 1, 18900),
      ]),
    ).toEqual([]);
  });

  it('이미 묶인 별칭 행은 후보가 아니다', () => {
    expect(
      findTruncationCandidates([
        row('세븐일레븐중구ENA센터', 1, 3000),
        row('세븐일레븐중구E', 3, 8500, '세븐일레븐중구ENA센터'),
      ]),
    ).toEqual([]);
  });

  it('혼자인 이름은 제안하지 않는다', () => {
    expect(findTruncationCandidates([row('쿠팡', 20, 445180)])).toEqual([]);
  });
});

describe('운영 목록 전량 (2026-08-20) — 잡히는 덩어리가 고정된다', () => {
  /** 프로덕션 `merchant_normalized` 실값 중 접두 관계가 걸릴 수 있는 이름 전부. */
  const PRODUCTION_NAMES: TruncationCandidateInput[] = [
    row('쿠팡', 20, 445180),
    row('쿠팡플레이', 2, 5200),
    row('우아한형', 3, 46500),
    row('우아한형제들', 1, 22395),
    row('메가엠지씨커피', 2, 9500),
    row('메가엠지씨커피도', 1, 3700),
    row('씨유영등포', 1, 1240),
    row('씨유영등포도림', 1, 9700),
    row('세븐일레븐중구E', 3, 8500),
    row('세븐일레븐중구ENA', 4, 14800),
    row('세븐일레븐중구ENA센터', 1, 3000),
    row('카카오T일반택시', 1, 3000),
    row('카카오T일반택시_0', 3, 41400),
    row('지에스25여의캐', 7, 23100),
    row('지에스25영등포', 1, 8200),
    row('지에스25 영등포도림', 8, 46050),
    row('지에스25S9샛강', 1, 2700),
    row('GS25영등포도림', 4, 12800),
    row('씨제이올리브영', 2, 72150),
    row('올리브영신도림테크노', 1, 18900),
    row('올리브약국', 1, 4000),
    row('CJCGV', 1, 5500),
    row('CJ CGV온라인예매_문화비', 1, 30000),
  ];

  it('제안 덩어리와 그 금액이 고정된다', () => {
    const groups = findTruncationCandidates(PRODUCTION_NAMES);
    const summary = groups.map((g) => ({
      canonical: g.canonical,
      aliases: g.aliases.length,
      net: g.netTotal,
    }));
    // 지에스25 5변종은 **하나도** 제안되지 않는다: 여의캐/영등포/S9샛강는 서로 접두가
    // 아니고, `지에스25영등포`와 `지에스25 영등포도림`은 공백이 달라 절단이 아니다.
    // 그 12건 58,850원은 사람이 판단할 몫으로 남는다(음차 + 지점 병합).
    expect(summary).toEqual([
      { canonical: '우아한형제들', aliases: 1, net: 68895 },
      { canonical: '카카오T일반택시_0', aliases: 1, net: 44400 },
      { canonical: '세븐일레븐중구ENA센터', aliases: 2, net: 26300 },
      { canonical: '메가엠지씨커피도', aliases: 1, net: 13200 },
      { canonical: '씨유영등포도림', aliases: 1, net: 10940 },
    ]);
  });

  it('음차·브랜드·업종 오병합이 하나도 섞이지 않는다', () => {
    const groups = findTruncationCandidates(PRODUCTION_NAMES);
    const merged = groups.flatMap((g) => [g.canonical, ...g.aliases]);
    // 이 이름들이 어떤 제안에도 들어가면 안 된다.
    for (const forbidden of [
      'GS25영등포도림', // 음차
      '쿠팡', // 우연한 접두
      '쿠팡플레이',
      '올리브약국', // 다른 업종
      '씨제이올리브영', // 브랜드 병합
      '올리브영신도림테크노',
      'CJCGV',
      'CJ CGV온라인예매_문화비',
      '지에스25여의캐', // 다른 지점
      '지에스25S9샛강',
      '지에스25영등포', // 공백이 달라 절단이 아니다
      '지에스25 영등포도림',
    ]) {
      expect(merged).not.toContain(forbidden);
    }
  });
});
