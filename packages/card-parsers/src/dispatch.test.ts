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
});
