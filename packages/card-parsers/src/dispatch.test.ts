import { describe, expect, it } from 'vitest';

import { parseCardSms } from './dispatch.js';

describe('parseCardSms dispatch', () => {
  it('routes Shinhan messages to the Shinhan parser', () => {
    const content = ['신한카드(1234)승인', '5,000원 일시불', '07/15 09:30', '투썸플레이스'].join('\n');
    const result = parseCardSms({
      sender: '15447200',
      content,
      receivedAt: new Date('2026-07-15T09:31:00+09:00'),
    });

    expect(result.issuer).toBe('신한카드');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(5000);
    expect(result.currency).toBe('KRW');
  });

  it('routes KB / 국민 messages to the Kookmin parser', () => {
    const content = ['KB국민카드', '승인 7,700원 일시불', '07/15 11:00', '컴포즈커피'].join('\n');
    const result = parseCardSms({
      sender: '15881688',
      content,
      receivedAt: new Date('2026-07-15T11:01:00+09:00'),
    });

    expect(result.issuer).toBe('KB국민카드');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(7700);
  });

  it('routes Toss Bank 알림톡 to the Toss parser (generic would reject on 잔액)', () => {
    const content = [
      '[토스뱅크] 체크카드 국내 결제',
      '김*진님의 공룡통장 카드',
      '46,460원 결제 | 영등포농협 하나로마트 도림시장',
      '잔액 109,798원',
    ].join('\n');
    const result = parseCardSms({
      sender: 'kakao',
      content,
      receivedAt: new Date('2026-07-15T18:42:11+09:00'),
    });

    // 가맹점의 '농협' 때문에 NH농협카드로 오라벨되지 않아야 한다.
    expect(result.issuer).toBe('토스뱅크');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(46460);
    expect(result.merchantRaw).toBe('영등포농협 하나로마트 도림시장');
  });

  it('keeps Toss messages away from Shinhan/KB parsers even when the merchant contains their keywords', () => {
    // 신한/KB 파서의 supports()는 키워드('신한'/'KB'/'국민')만 보므로, 토스 파서가
    // 먼저 등록돼 있지 않으면 이 문자를 선점해 발급사 오라벨 + 가맹점 오추출
    // (lastMerchant가 잔액 라인)으로 타인 카드에 자동 연결될 수 있다.
    const content = [
      '[토스뱅크] 체크카드 국내 결제',
      '김*진님의 공룡통장 카드',
      '18,000원 결제 | 신한서적 강남점',
      '잔액 91,798원',
    ].join('\n');
    const result = parseCardSms({
      sender: 'kakao',
      content,
      receivedAt: new Date('2026-07-15T18:42:11+09:00'),
    });

    expect(result.issuer).toBe('토스뱅크');
    expect(result.merchantRaw).toBe('신한서적 강남점');
    expect(result.amount).toBe(18000);
  });

  // 실제 유입 문자 회귀: 접힌(펼치지 않은) 토스 알림. 예전엔 'no matching parser'로
  // parse_failed. 이제 토스로 라우팅돼 발급사/가맹점/유형이 채워진다(금액은 원문에
  // 없어 undefined — 워커가 parse_failed 로 두지만 검토 가능한 레코드가 된다).
  it('routes a collapsed Toss notification to the Toss parser instead of failing', () => {
    const result = parseCardSms({
      sender: '16617654',
      content: '공룡통장 카드 | 쿠팡(쿠페이)\n잔액 126,713원',
      receivedAt: new Date('2026-07-22T19:49:46+09:00'),
    });

    expect(result.issuer).toBe('토스뱅크');
    expect(result.transactionType).toBe('approval');
    expect(result.merchantRaw).toBe('쿠팡(쿠페이)');
    expect(result.amount).toBeUndefined();
    expect(result.warnings).not.toContain('no matching parser');
  });

  it('flags payment aggregators without inventing a real merchant', () => {
    const content = ['신한카드(1234)승인', '15,000원 일시불', '07/15 20:00', '네이버페이'].join('\n');
    const result = parseCardSms({
      sender: '15447200',
      content,
      receivedAt: new Date('2026-07-15T20:01:00+09:00'),
    });

    expect(result.merchantRaw).toBe('네이버페이');
    expect(result.warnings).toContain('payment aggregator; merchant unconfirmed');
    expect(result.amount).toBe(15000);
  });

  it('returns unknown with confidence 0 when no parser matches', () => {
    const result = parseCardSms({
      sender: '01000000000',
      content: '[안내] 이번 주 마트 세일 정보를 확인하세요.',
      receivedAt: new Date('2026-07-15T09:00:00+09:00'),
    });

    expect(result.transactionType).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.warnings).toContain('no matching parser');
    expect(result.amount).toBeUndefined();
  });

  it('returns unknown when a supported issuer message is not a transaction', () => {
    const content = ['신한은행', '고객님 안녕하세요. 신한 이벤트 안내입니다.'].join('\n');
    const result = parseCardSms({
      sender: '15447200',
      content,
      receivedAt: new Date('2026-07-15T09:00:00+09:00'),
    });

    expect(result.transactionType).toBe('unknown');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  // 실제 유입 문자 회귀(홈↔거래화면 불일치의 근본 원인): 단일 라인 레이아웃 +
  // 날짜/시각이 '/'로 연결(07/19/15:00) + '승인거절'. 세 결함이 함께 잡혀야 한다.
  it('classifies a single-line 승인거절 as declined and still extracts fields', () => {
    const content =
      '[Web발신]\n네이버 현대카드 뒷자리(6*0*) 분실카드 승인거절 07/19/15:00 버핏서울 106,000원';
    const result = parseCardSms({
      sender: '+8215776200',
      content,
      receivedAt: new Date('2026-07-19T15:01:00+09:00'),
    });

    // 승인거절은 승인이 아니다(→ processor가 거래로 승격하지 않음).
    expect(result.transactionType).toBe('declined');
    // 무공백 '/' 구분 날짜/시각도 파싱된다.
    expect(result.occurredAt).toEqual(new Date('2026-07-19T15:00:00+09:00'));
    // 모든 필드가 한 줄이어도 가맹점만 깨끗이 추출(뒤 금액 토큰 제거).
    expect(result.merchantRaw).toBe('버핏서울');
    expect(result.amount).toBe(106000);
    expect(result.issuer).toBe('현대카드');
  });

  it('keeps 승인취소 as cancellation (거절과 구분)', () => {
    const content = ['현대카드 승인취소', '106,000원 일시불', '07/19 15:00', '버핏서울'].join('\n');
    const result = parseCardSms({
      sender: '+8215776200',
      content,
      receivedAt: new Date('2026-07-19T15:01:00+09:00'),
    });

    expect(result.transactionType).toBe('cancellation');
    expect(result.amount).toBe(106000);
  });

  it('keeps a plain 승인 as approval (거절 오탐 없음)', () => {
    const content = ['현대카드 승인', '106,000원 일시불', '07/19 15:00', '버핏서울'].join('\n');
    const result = parseCardSms({
      sender: '+8215776200',
      content,
      receivedAt: new Date('2026-07-19T15:01:00+09:00'),
    });

    expect(result.transactionType).toBe('approval');
    expect(result.merchantRaw).toBe('버핏서울');
  });

  // 실제 유입 문자 회귀(해외승인/외화): 이전엔 원화 게이트에 막혀 'no matching
  // parser'로 parse_failed. 이제 generic 라우팅 + minor-units 변환 + 통화 코드 +
  // 선행 외화 토큰 제거로 모든 필드가 잡혀야 한다. 이것이 다통화 지원 인수 테스트.
  it('parses a foreign-currency 해외승인 (USD) into minor units + currency', () => {
    const content = [
      '[Web발신]',
      '네이버 현대카드 해외승인',
      '김*진님',
      '07/20 19:31',
      'USD 22.00',
      'ANTHROPIC*CLAUDESUB',
    ].join('\n');
    const result = parseCardSms({
      sender: '15776200@botplatform.maapservice.com',
      content,
      receivedAt: new Date('2026-07-20T19:31:43+09:00'),
    });

    expect(result.issuer).toBe('현대카드');
    expect(result.transactionType).toBe('approval');
    expect(result.currency).toBe('USD');
    expect(result.amount).toBe(2200); // $22.00 → minor units 2200
    expect(result.occurredAt).toEqual(new Date('2026-07-20T19:31:00+09:00'));
    expect(result.merchantRaw).toBe('ANTHROPIC*CLAUDESUB');
  });

  it('parses a single-line 해외승인 with a leading foreign amount token', () => {
    const content = '삼성카드 해외승인 07/20 19:31 USD 22.00 ANTHROPIC*CLAUDESUB';
    const result = parseCardSms({
      sender: '15771234',
      content,
      receivedAt: new Date('2026-07-20T19:31:43+09:00'),
    });

    expect(result.issuer).toBe('삼성카드');
    expect(result.transactionType).toBe('approval');
    expect(result.currency).toBe('USD');
    expect(result.amount).toBe(2200);
    // 선행 외화 토큰(USD 22.00)이 제거되고 가맹점만 남는다.
    expect(result.merchantRaw).toBe('ANTHROPIC*CLAUDESUB');
  });
});
