import { describe, expect, it } from 'vitest';

import { maskForLlm } from './mask.js';

/** 실제 카드 문자 레이아웃(이름·번호는 이미 마스킹된 형태). */
const FIXTURES = [
  '[Web발신]\n삼성2승인 이*빈\n1,169원 일시불\n07/20 14:32 영등포구청',
  '[Web발신]\n네이버 현대카드 승인\n김*진\n30,000원 일시불\n07/19 15:00\n모바일티머니선불\n누적123,456원',
  '[Web발신]\n네이버 현대카드 뒷자리(1*2*) 분실카드 승인거절 07/19/15:00 버핏서울 106,000원',
  '[토스뱅크] 체크카드 국내 결제 \n김*진님의 공룡통장 카드 \n5,000원 결제 | 메가엠지씨커피 도림점 \n잔액 126,713원',
  '[Web발신]\n네이버 현대카드 해외승인\n김*진님\n07/20 19:31\nUSD 22.00\nANTHROPIC*CLAUDESUB',
  '신한카드(1234)승인\n5,000원 일시불\n07/15 09:30\n투썸플레이스',
  'KB국민카드 승인 ****5678\n12,500원\n07/15 12:00\n스타벅스',
];

describe('maskForLlm', () => {
  it('길이를 항상 보존한다 (span 오프셋 정합의 전제)', () => {
    for (const fixture of FIXTURES) {
      expect(maskForLlm(fixture)).toHaveLength(fixture.length);
    }
  });

  it('무작위 숫자 조합에서도 길이를 보존한다', () => {
    const separators = ['', '-', ' ', ',', '.', ':', '/'];
    for (let seed = 0; seed < 500; seed += 1) {
      // 결정적 의사난수 — 실패 재현이 가능해야 한다.
      let state = seed * 2654435761;
      const next = (bound: number): number => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % bound;
      };
      let sample = '';
      for (let part = 0; part < 6; part += 1) {
        const digits = next(14) + 1;
        for (let d = 0; d < digits; d += 1) sample += String(next(10));
        sample += separators[next(separators.length)];
      }
      expect(maskForLlm(sample)).toHaveLength(sample.length);
    }
  });

  it('16자리 카드번호를 구분자 유무와 무관하게 가린다', () => {
    expect(maskForLlm('카드 1234-5678-9012-3456 결제')).toBe('카드 ••••-••••-••••-•••• 결제');
    expect(maskForLlm('카드 1234567890123456 결제')).toBe('카드 •••••••••••••••• 결제');
  });

  it('계좌번호와 전화번호를 가린다', () => {
    expect(maskForLlm('계좌 110-123-456789')).toBe('계좌 •••-•••-••••••');
    expect(maskForLlm('연락 01012345678')).toBe('연락 •••••••••••');
  });

  it('금액·날짜·시각은 건드리지 않는다 (파싱에 필요)', () => {
    const content = '12,500원 07/19 15:00 2026-07-19';
    expect(maskForLlm(content)).toBe(content);
  });

  it('이미 마스킹된 카드 뒷자리는 그대로 둔다', () => {
    expect(maskForLlm('신한카드(1234)승인')).toBe('신한카드(1234)승인');
    expect(maskForLlm('승인 ****5678')).toBe('승인 ****5678');
  });

  it('실제 문자 픽스처에서 금액 토큰이 살아남는다', () => {
    expect(maskForLlm(FIXTURES[0])).toContain('1,169원');
    expect(maskForLlm(FIXTURES[4])).toContain('USD 22.00');
  });
});
