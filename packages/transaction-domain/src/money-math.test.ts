import { describe, expect, it } from 'vitest';

import { currencyExponent } from '@family/shared';

import {
  convertToKrw,
  fxBaseDate,
  fxRateDisplayValue,
  isSupportedMoneyCurrency,
  moneyCurrencyExponent,
  MONEY_SUPPORTED_CURRENCIES,
  parseFxRate,
} from './money-math.js';

describe('통화 지수', () => {
  // ADR-0027 §3: 지수는 한 ISO 매핑에서만 가져온다. 목록이 shared와 어긋나면
  // 같은 통화가 두 값으로 환산되므로 여기서 잠근다.
  it('지원 목록의 지수는 @family/shared 매핑과 같다', () => {
    for (const currency of MONEY_SUPPORTED_CURRENCIES) {
      expect(moneyCurrencyExponent(currency)).toBe(currencyExponent(currency));
    }
  });

  it('모르는 통화는 지수 2로 가정하지 않고 null이다', () => {
    // shared의 currencyExponent는 표시용 폴백으로 2를 준다 — 금액 계약에서는 금지다.
    expect(currencyExponent('XYZ')).toBe(2);
    expect(moneyCurrencyExponent('XYZ')).toBeNull();
    expect(isSupportedMoneyCurrency('XYZ')).toBe(false);
  });

  it('소문자 코드도 같은 지수로 읽는다', () => {
    expect(moneyCurrencyExponent('usd')).toBe(2);
  });
});

describe('환율 파싱', () => {
  it('numeric(24,12) 문자열을 정수 스케일로 읽는다', () => {
    expect(parseFxRate('1300.000000000000')).toBe(1_300_000_000_000_000n);
    expect(parseFxRate('9.1')).toBe(9_100_000_000_000n);
  });

  it('스케일보다 긴 소수부는 자르지 않고 거부한다', () => {
    // 자르면 "저장된 환율"과 "계산에 쓴 환율"이 갈린다.
    expect(parseFxRate('1300.0000000000001')).toBeNull();
  });

  it('0 이하·지수 표기·비숫자는 거부한다', () => {
    expect(parseFxRate('0')).toBeNull();
    expect(parseFxRate('-1300')).toBeNull();
    expect(parseFxRate('1.3e3')).toBeNull();
    expect(parseFxRate('')).toBeNull();
  });

  it('표시값은 double로 되돌린다(계산 원본이 아니다)', () => {
    expect(fxRateDisplayValue('1300.000000000000')).toBe(1300);
    expect(fxRateDisplayValue('bad')).toBeNull();
  });
});

describe('KRW 환산', () => {
  it('USD 100(=10,000 minor)를 1,300원에 환산하면 130,000원', () => {
    expect(convertToKrw(10_000, 'USD', '1300.000000000000')).toEqual({
      ok: true,
      krw: 130_000,
    });
  });

  it('지수 0 통화(JPY)는 minor==major다', () => {
    expect(convertToKrw(10_000, 'JPY', '9.100000000000')).toEqual({ ok: true, krw: 91_000 });
  });

  // ADR-0027 회귀 테스트 7: 정확히 0.5원 경계는 언제나 올림(ROUND_HALF_UP).
  it('정확히 0.5원 경계는 올린다', () => {
    expect(convertToKrw(1, 'USD', '50.000000000000')).toEqual({ ok: true, krw: 1 });
    expect(convertToKrw(3, 'USD', '50.000000000000')).toEqual({ ok: true, krw: 2 });
  });

  it('0.5 미만은 내린다', () => {
    expect(convertToKrw(1, 'USD', '49.000000000000')).toEqual({ ok: true, krw: 0 });
  });

  it('중간값이 안전정수를 넘는 큰 금액도 정확하다', () => {
    // 2e9 minor units × 1400.123456789012 → 분자가 2.8e24라 double이면 자릿수가
    // 날아간다. bigint로 계산해 정확히 ROUND_HALF_UP된 값을 얻는다.
    expect(convertToKrw(2_000_000_000, 'USD', '1400.123456789012')).toEqual({
      ok: true,
      krw: 28_002_469_136,
    });
  });

  it('0원은 0원이다', () => {
    expect(convertToKrw(0, 'USD', '1300.000000000000')).toEqual({ ok: true, krw: 0 });
  });

  it('지원하지 않는 통화·잘못된 환율·음수는 사유와 함께 거부한다', () => {
    expect(convertToKrw(100, 'XYZ', '1300.000000000000')).toEqual({
      ok: false,
      failure: 'unsupported_currency',
    });
    expect(convertToKrw(100, 'USD', 'nope')).toEqual({ ok: false, failure: 'invalid_rate' });
    expect(convertToKrw(-1, 'USD', '1300.000000000000')).toEqual({
      ok: false,
      failure: 'invalid_minor_units',
    });
    expect(convertToKrw(1.5, 'USD', '1300.000000000000')).toEqual({
      ok: false,
      failure: 'invalid_minor_units',
    });
  });
});

describe('환율 기준일', () => {
  // ADR-0027 회귀 테스트 5: occurredAt이 없으면 고정된 receivedAt 서울 날짜를 쓰고
  // 재시도 결과가 같다. `new Date()`는 어느 쪽에도 들어오지 않는다.
  it('occurredAt의 서울 날짜를 쓴다', () => {
    const occurred = new Date('2026-08-07T16:30:00Z'); // 서울 8/8 01:30
    expect(fxBaseDate(occurred, new Date('2026-08-09T00:00:00Z'))).toBe('2026-08-08');
  });

  it('occurredAt이 없으면 receivedAt으로 내려간다', () => {
    expect(fxBaseDate(null, new Date('2026-08-07T16:30:00Z'))).toBe('2026-08-08');
  });

  it('같은 입력은 몇 번을 불러도 같은 기준일이다', () => {
    const occurred = new Date('2026-07-31T15:00:00Z'); // 서울 8/1 00:00
    const first = fxBaseDate(occurred, new Date());
    const second = fxBaseDate(occurred, new Date());
    expect(first).toBe('2026-08-01');
    expect(second).toBe(first);
  });
});
