import { describe, expect, it } from 'vitest';

import { TossBankCardParser } from './toss.parser.js';

const parser = new TossBankCardParser();

/** 실제 카카오 알림톡 중계 레이아웃(체크카드 국내 결제). */
const APPROVAL = [
  '[토스뱅크] 체크카드 국내 결제',
  '김*진님의 공룡통장 카드',
  '46,460원 결제 | 영등포농협 하나로마트 도림시장',
  '잔액 109,798원',
].join('\n');

describe('TossBankCardParser', () => {
  it('supports Toss Bank card payments only', () => {
    const receivedAt = new Date();
    expect(parser.supports({ sender: 'kakao', content: APPROVAL, receivedAt })).toBe(true);
    // 계좌 입출금/이체 알림은 카드 결제가 아니다.
    expect(
      parser.supports({
        sender: 'kakao',
        content: '[토스뱅크] 김*진님의 통장에 50,000원 입금\n잔액 159,798원',
        receivedAt,
      }),
    ).toBe(false);
    // 타사 카드 문자는 담당하지 않는다.
    expect(
      parser.supports({ sender: '15447200', content: '신한카드(1234)승인 5,000원', receivedAt }),
    ).toBe(false);
  });

  it('rejects declined-payment notifications (실패/거절/한도초과)', () => {
    const receivedAt = new Date();
    // 잔액 부족 등으로 승인되지 않은 결제가 approved 거래로 승격되면 안 된다.
    expect(
      parser.supports({
        sender: 'kakao',
        content: [
          '[토스뱅크] 체크카드 결제 실패',
          '김*진님의 공룡통장 카드',
          '46,460원 결제 | 영등포농협 하나로마트 도림시장',
          '잔액 1,234원',
        ].join('\n'),
        receivedAt,
      }),
    ).toBe(false);
    expect(
      parser.supports({
        sender: 'kakao',
        content: '[토스뱅크] 체크카드 결제 거절\n한도 초과\n46,460원 결제 | 가맹점',
        receivedAt,
      }),
    ).toBe(false);
  });

  it('preserves the pipe merchant on foreign-currency variants (no 원 on the pay line)', () => {
    const result = parser.parse({
      sender: 'kakao',
      content: [
        '[토스뱅크] 체크카드 해외 결제',
        '김*진님의 공룡통장 카드',
        '5.99 USD 결제 | OPENAI CHATGPT',
        '잔액 109,798원',
      ].join('\n'),
      receivedAt: new Date('2026-07-15T09:00:00+09:00'),
    });

    // KRW 금액은 없어(잔액 라인 제외) parse_failed → 검토로 가지만, 가맹점은 보존된다.
    expect(result.merchantRaw).toBe('OPENAI CHATGPT');
  });

  it('parses the approval layout (amount, merchant, balance line ignored)', () => {
    const receivedAt = new Date('2026-07-15T18:42:11+09:00');
    const result = parser.parse({ sender: 'kakao', content: APPROVAL, receivedAt });

    expect(result.issuer).toBe('토스뱅크');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(46460); // 잔액(109,798)이 아니라 결제 금액.
    expect(Number.isInteger(result.amount)).toBe(true);
    expect(result.currency).toBe('KRW');
    expect(result.merchantRaw).toBe('영등포농협 하나로마트 도림시장');
    expect(result.maskedCardNumber).toBeUndefined();
    // 본문에 시각이 없어 receivedAt 으로 근사한다.
    expect(result.occurredAt).toEqual(receivedAt);
    expect(result.warnings).toContain('occurredAt approximated from receivedAt');
    expect(result.confidence).toBeGreaterThanOrEqual(70);
  });

  it('parses a cancellation (결제 취소)', () => {
    const content = [
      '[토스뱅크] 체크카드 결제 취소',
      '김*진님의 공룡통장 카드',
      '46,460원 결제 취소 | 영등포농협 하나로마트 도림시장',
      '잔액 156,258원',
    ].join('\n');
    const result = parser.parse({
      sender: 'kakao',
      content,
      receivedAt: new Date('2026-07-15T19:00:00+09:00'),
    });

    expect(result.transactionType).toBe('cancellation');
    expect(result.amount).toBe(46460);
    expect(result.merchantRaw).toBe('영등포농협 하나로마트 도림시장');
  });

  it('never treats the balance line as the payment amount', () => {
    // 방어: 결제 라인이 `결제` 키워드 없이 온 변형이라도 잔액 라인은 금액 후보에서 제외.
    const content = [
      '[토스뱅크] 체크카드 국내 승인',
      '잔액 999,999원',
      '12,000원 | 스타벅스 성수점',
    ].join('\n');
    const result = parser.parse({
      sender: 'kakao',
      content,
      receivedAt: new Date('2026-07-15T09:00:00+09:00'),
    });

    expect(result.amount).toBe(12000);
    expect(result.merchantRaw).toBe('스타벅스 성수점');
  });

  it('keeps merchant undefined when the pipe segment is missing', () => {
    const content = ['[토스뱅크] 체크카드 국내 결제', '46,460원 결제', '잔액 109,798원'].join(
      '\n',
    );
    const result = parser.parse({
      sender: 'kakao',
      content,
      receivedAt: new Date('2026-07-15T09:00:00+09:00'),
    });

    expect(result.merchantRaw).toBeUndefined();
    expect(result.warnings).toContain('merchant not found');
  });
});
