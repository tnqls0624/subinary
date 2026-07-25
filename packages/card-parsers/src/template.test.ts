import { describe, expect, it } from 'vitest';

import { templateFingerprint, templateSkeleton } from './template.js';

const SAMSUNG_SENDER = '15881688';
const samsung = (amount: string, time: string, merchant: string): string =>
  `[Web발신]\n삼성2승인 이*빈\n${amount} 일시불\n${time} ${merchant}`;

describe('templateSkeleton', () => {
  it('금액·시각을 #로, 가맹점·이름을 @로 접는다', () => {
    const skeleton = templateSkeleton(samsung('1,169원', '07/20 14:32', '영등포구청'));
    expect(skeleton).not.toContain('영등포구청');
    expect(skeleton).not.toContain('1,169');
    expect(skeleton).toContain('일시불');
  });

  it('고정 어휘는 보존한다 (레이아웃 식별 근거)', () => {
    const skeleton = templateSkeleton(samsung('1,169원', '07/20 14:32', '영등포구청'));
    for (const keyword of ['Web발신', '삼성', '승인', '일시불']) {
      expect(skeleton).toContain(keyword);
    }
  });
});

describe('templateFingerprint', () => {
  it('가맹점만 다르면 같은 지문이다 (캐시 히트의 핵심)', () => {
    const a = templateFingerprint(SAMSUNG_SENDER, samsung('1,169원', '07/20 14:32', '영등포구청'));
    const b = templateFingerprint(
      SAMSUNG_SENDER,
      samsung('8,900원', '07/21 09:05', '커피온리샛강역사'),
    );
    expect(a).toBe(b);
  });

  it('가맹점이 여러 어절이어도 같은 지문이다', () => {
    const a = templateFingerprint(SAMSUNG_SENDER, samsung('1,169원', '07/20 14:32', '영등포구청'));
    const b = templateFingerprint(
      SAMSUNG_SENDER,
      samsung('3,000원', '07/22 11:11', '주식회사 우아한형제들'),
    );
    expect(a).toBe(b);
  });

  it('레이아웃이 다르면 다른 지문이다 (일시불 vs 할부)', () => {
    const lump = templateFingerprint(SAMSUNG_SENDER, samsung('1,169원', '07/20 14:32', '영등포구청'));
    const installment = templateFingerprint(
      SAMSUNG_SENDER,
      `[Web발신]\n삼성2승인 이*빈\n120,000원 3개월\n07/20 14:32 애플코리아`,
    );
    expect(lump).not.toBe(installment);
  });

  it('발급사가 다르면 다른 지문이다', () => {
    const samsungFp = templateFingerprint(
      SAMSUNG_SENDER,
      samsung('1,169원', '07/20 14:32', '영등포구청'),
    );
    const hyundai = templateFingerprint(
      '15776000',
      '[Web발신]\n네이버 현대카드 승인\n김*진\n30,000원 일시불\n07/19 15:00\n모바일티머니선불\n누적123,456원',
    );
    expect(samsungFp).not.toBe(hyundai);
  });

  it('같은 레이아웃이라도 발신번호가 다르면 지문이 갈린다', () => {
    const content = samsung('1,169원', '07/20 14:32', '영등포구청');
    expect(templateFingerprint('15881688', content)).not.toBe(
      templateFingerprint('01012345678', content),
    );
  });

  it('sha256 hex 형식이다', () => {
    expect(templateFingerprint(SAMSUNG_SENDER, samsung('1원', '07/20 14:32', 'X'))).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
