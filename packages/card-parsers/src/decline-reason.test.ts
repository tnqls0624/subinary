import { describe, expect, it } from 'vitest';

import { detectDeclineReason } from './parsers/base.parser.js';
import { parseCardSms } from './dispatch.js';

const receivedAt = new Date('2026-07-19T06:00:00.000Z');

describe('detectDeclineReason', () => {
  it('detects 분실/도난 — 정기결제 수단을 갱신해야 하는 사유', () => {
    // 실측 문자(2026-07-19~25, 7일 연속).
    expect(
      detectDeclineReason(
        '현대카드 뒷자리(9*9*) 분실카드 승인거절 07/19/15:00 OO피트니스 99,000원',
      ),
    ).toBe('lost_or_stolen');
    expect(detectDeclineReason('도난신고 카드 승인거절')).toBe('lost_or_stolen');
  });

  it('detects 한도·잔액·유효기간·정지·인증 사유', () => {
    expect(detectDeclineReason('한도초과로 승인거절')).toBe('limit_exceeded');
    expect(detectDeclineReason('이용 한도 부족 승인불가')).toBe('limit_exceeded');
    expect(detectDeclineReason('잔액부족 결제실패')).toBe('insufficient_balance');
    expect(detectDeclineReason('유효기간 경과 승인거절')).toBe('expired_card');
    expect(detectDeclineReason('이용중지 카드 승인거부')).toBe('suspended');
    expect(detectDeclineReason('비밀번호 오류 승인거절')).toBe('invalid_credential');
  });

  it('falls back to unknown — 거절 사실은 확실하므로 정보를 버리지 않는다', () => {
    expect(detectDeclineReason('승인거절되었습니다')).toBe('unknown');
  });
});

describe('parseCardSms — declineReason 통합', () => {
  it('거절 문자에 사유를 실어 준다', () => {
    const result = parseCardSms({
      sender: '15771234',
      content:
        '[Web발신]\n현대카드 뒷자리(9*9*) 분실카드 승인거절 07/19/15:00 OO피트니스 99,000원',
      receivedAt,
    });
    expect(result.transactionType).toBe('declined');
    expect(result.declineReason).toBe('lost_or_stolen');
    // 사유 추출이 기존 필드 추출을 깨지 않는다.
    expect(result.amount).toBe(99000);
    expect(result.merchantRaw).toContain('OO피트니스');
  });

  it('승인 문자에는 declineReason을 남기지 않는다(거절로 오인 방지)', () => {
    const result = parseCardSms({
      sender: '15771234',
      content: '[Web발신]\n삼성7420승인 이*빈\n4,000원 일시불\n07/25 09:10 메가엠지씨커피',
      receivedAt: new Date('2026-07-25T00:10:00.000Z'),
    });
    expect(result.transactionType).toBe('approval');
    expect(result.declineReason).toBeUndefined();
  });
});

describe('거절 통지의 NON_CARD_RE 우회 (실측 회귀)', () => {
  it('토스뱅크 잔액부족 결제 실패를 declined로 잡는다', () => {
    // 실측(2026-08-01): '잔액'이 NON_CARD_RE에 걸려 no matching parser로 떨어졌다.
    const result = parseCardSms({
      sender: '16617654',
      content:
        '15,800원 결제 실패 공룡통장 카드 | 쿠팡(쿠페이)\n잔액이 부족해요. 계좌 잔액을 확인해주세요.',
      receivedAt: new Date('2026-08-01T05:00:00.000Z'),
    });
    expect(result.transactionType).toBe('declined');
    expect(result.declineReason).toBe('insufficient_balance');
    expect(result.amount).toBe(15800);
  });

  it('한도초과 거절도 잡는다(한도 초과는 NON_CARD가 아니지만 사유로 함께 검증)', () => {
    const result = parseCardSms({
      sender: '15771234',
      content: '[Web발신]\n삼성카드 승인거절 한도초과\n50,000원 08/01 12:00 어떤가게',
      receivedAt: new Date('2026-08-01T03:00:00.000Z'),
    });
    expect(result.transactionType).toBe('declined');
    expect(result.declineReason).toBe('limit_exceeded');
  });

  it('은행 문자는 여전히 배제한다 — 카드 문맥이 없으면 우회가 열리지 않는다', () => {
    // '우리은행'은 CARD_CONTEXT_RE의 브랜드 매칭에서 (?!\s*은행)로 제외된다.
    const result = parseCardSms({
      sender: '15881234',
      content: '우리은행 자동이체 결제 실패 50,000원 잔액이 부족합니다',
      receivedAt: new Date('2026-08-01T03:00:00.000Z'),
    });
    expect(result.transactionType).not.toBe('approval');
    expect(result.confidence).toBeLessThan(60);
  });

  it('평범한 은행 입출금 문자는 계속 배제한다(우회 회귀 방지)', () => {
    const result = parseCardSms({
      sender: '15881234',
      content: '[Web발신]\n하나은행 입금 500,000원 잔액 1,200,000원',
      receivedAt: new Date('2026-08-01T03:00:00.000Z'),
    });
    expect(result.transactionType).not.toBe('approval');
  });
});
