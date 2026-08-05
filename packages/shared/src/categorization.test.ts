import { describe, expect, it } from 'vitest';

import {
  CATEGORY_KEYWORD_RULES,
  DEFAULT_CATEGORIES,
  categorizeByKeyword,
  normalizeMerchant,
} from './categorization.js';

describe('normalizeMerchant', () => {
  it('strips a 2-syllable district branch suffix, keeping the brand', () => {
    // Matches the raw merchant the Phase 3 Shinhan parser emits.
    expect(normalizeMerchant('스타벅스강남점')).toBe('스타벅스');
    expect(normalizeMerchant('이마트성수점')).toBe('이마트');
  });

  it('collapses whitespace and trims a spaced branch suffix', () => {
    expect(normalizeMerchant('  투썸플레이스   역삼점 ')).toBe('투썸플레이스');
  });

  it('strips explicit 본점/지점/직영점 markers', () => {
    expect(normalizeMerchant('올리브영본점')).toBe('올리브영');
    expect(normalizeMerchant('컴포즈커피지점')).toBe('컴포즈커피');
  });

  it('preserves generic single-word terms and non-branch names', () => {
    expect(normalizeMerchant('편의점')).toBe('편의점'); // base would be empty -> kept
    expect(normalizeMerchant('하이마트')).toBe('하이마트'); // no 점 suffix
  });

  it('trims a trailing payment aggregator but keeps it when standalone', () => {
    expect(normalizeMerchant('스타벅스 카카오페이')).toBe('스타벅스');
    expect(normalizeMerchant('네이버페이')).toBe('네이버페이');
  });

  it('strips bracketed carrier headers', () => {
    expect(normalizeMerchant('[Web발신] 배달의민족')).toBe('배달의민족');
  });

  it('returns empty string for empty / whitespace-only input', () => {
    expect(normalizeMerchant('   ')).toBe('');
    expect(normalizeMerchant('')).toBe('');
  });

  // 아래 입력은 전부 실제 수집된 merchant_raw 값이다. 이 단계가 없던 동안
  // 같은 브랜드가 여러 키로 쪼개져 카테고리 규칙이 중복 학습됐다.
  it('strips parenthetical annotations so brand fragments collapse', () => {
    // 결제수단 병기 — 이 둘이 갈려 쿠팡이 2개 가맹점으로 집계됐다(11건 264,800원).
    expect(normalizeMerchant('쿠팡(쿠페이)')).toBe('쿠팡');
    expect(normalizeMerchant('쿠팡')).toBe('쿠팡');
    // 영문 병기가 이름 중간에 삽입된 형태.
    expect(normalizeMerchant('지에스(GS)25여의캐')).toBe('지에스25여의캐');
    // 카드 문자 길이 제한에 닫는 괄호가 잘려나간 형태.
    expect(normalizeMerchant('카카오T일반택시(')).toBe('카카오T일반택시');
  });

  it('keeps the original when the brand itself lives inside the parens', () => {
    expect(normalizeMerchant('(쿠페이)')).toBe('(쿠페이)');
  });

  it('strips corporate-form markers incl. truncated tails', () => {
    expect(normalizeMerchant('주식회사팀오투')).toBe('팀오투');
    expect(normalizeMerchant('(주)벤디스')).toBe('벤디스');
    // 실측: 카드사가 '유한회사'를 '유한회'로 잘라 보낸다.
    expect(normalizeMerchant('애플코리아유한회')).toBe('애플코리아');
    expect(normalizeMerchant('애플코리아유한회사')).toBe('애플코리아');
    expect(normalizeMerchant('㈜벤디스')).toBe('벤디스');
  });

  it('keeps the original when the corporate form was the whole name', () => {
    expect(normalizeMerchant('주식회사')).toBe('주식회사');
  });

  it('still splits truncated names the parser cannot recover (alias territory)', () => {
    // 카드사가 이름을 자른 결과는 정규화로 되돌릴 수 없다 — merchant_aliases의 몫.
    expect(normalizeMerchant('주식회사우아한형')).toBe('우아한형');
    expect(normalizeMerchant('주식회사 우아한형제들')).toBe('우아한형제들');
  });
});

describe('categorizeByKeyword', () => {
  it('classifies cafe merchants (incl. on the raw branch-suffixed name)', () => {
    expect(categorizeByKeyword('스타벅스')).toBe('cafe');
    expect(categorizeByKeyword('스타벅스강남점')).toBe('cafe');
  });

  it('classifies delivery, fuel, transport and shopping merchants', () => {
    expect(categorizeByKeyword('배달의민족')).toBe('delivery');
    expect(categorizeByKeyword('GS칼텍스')).toBe('fuel');
    expect(categorizeByKeyword('카카오T')).toBe('transport');
    expect(categorizeByKeyword('이마트')).toBe('shopping');
  });

  it('respects rule ordering for overlapping keywords', () => {
    // 쿠팡이츠 (delivery) must win over 쿠팡 (shopping).
    expect(categorizeByKeyword('쿠팡이츠')).toBe('delivery');
    expect(categorizeByKeyword('쿠팡')).toBe('shopping');
    // 노브랜드버거 (food) must win over 노브랜드 (grocery).
    expect(categorizeByKeyword('노브랜드버거 홍대점')).toBe('food');
    expect(categorizeByKeyword('노브랜드')).toBe('grocery');
  });

  it('returns null for unknown merchants and payment aggregators', () => {
    expect(categorizeByKeyword('알수없는가게이름')).toBeNull();
    expect(categorizeByKeyword('네이버페이')).toBeNull();
    expect(categorizeByKeyword('')).toBeNull();
  });

  it('composes with normalizeMerchant (parser output -> slug)', () => {
    expect(categorizeByKeyword(normalizeMerchant('스타벅스강남점'))).toBe('cafe');
  });
});

describe('data integrity', () => {
  it('every keyword rule points at a defined system slug', () => {
    const slugs = new Set(DEFAULT_CATEGORIES.map((c) => c.slug));
    for (const rule of CATEGORY_KEYWORD_RULES) {
      expect(slugs.has(rule.slug)).toBe(true);
    }
  });

  it('has unique category slugs', () => {
    const slugs = DEFAULT_CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
