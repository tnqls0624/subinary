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

/**
 * 카드 결제가 **아닌** 문자가 approval 거래로 승격되지 않는지 고정한다(ADR-0026).
 *
 * 왜 필요한가: 승격된 유령 거래는 그 달 총액을 조용히 부풀리고, 사용자가 알아채도
 * 원문이 카드 문자가 아니므로 어디서 왔는지 추적하기 어렵다. 게이트
 * (generic의 `CARD_CONTEXT_RE`/`NON_CARD_RE`/`DECLINE_NOTICE_RE`, toss의
 * `TRANSFER_RE`/`DECLINED_RE`)는 이미 이 문자들을 막고 있으나 **회귀 테스트가 없어**
 * 게이트를 손대면 조용히 열릴 수 있었다. 이 describe가 그 그물이다.
 *
 * `unknown` + `no matching parser`면 워커가 `parse_failed`로 두고 승격하지 않는다
 * (= 안전한 실패 방향). 오배제 대가는 검토 목록 항목 하나뿐이다.
 */
describe('비카드 문자 배제 (유령 거래 방지)', () => {
  const receivedAt = new Date('2026-08-03T19:15:00+09:00');

  /**
   * 실유입 회귀 — 토스뱅크 모임통장 **은행 출금** 4건(sender 16617654, 2026-07~08).
   * 이 4건은 과거 파서에서 `approval`로 승격돼 카드 지출에 섞여 있었다(ATM현금
   * 50,000 · 도시가스 12,920 · 송금 6,500). 현재는 toss의 `TRANSFER_RE`(출금)와
   * generic의 `NON_CARD_RE`(출금)가 함께 막는다. 원문은 DB `card_sms_events`에서
   * 그대로 가져온 것이므로 공백·개행을 바꾸지 말 것.
   */
  const TOSS_BANK_WITHDRAWALS: ReadonlyArray<readonly [string, string]> = [
    [
      'ATM 현금 인출',
      '토스뱅크 [출금 안내] \n공룡통장 모임통장에서 50,000원이 출금됐어요. \n07/30 17:58\nATM현금\n거래한 모임원 : 김*진',
    ],
    [
      '공과금 자동납부',
      '토스뱅크 [토스뱅크 모임통장] \n이*빈님, 공룡통장 모임통장에서 12,920원이 출금됐어요. \n도시가스07x705 \n07/31 19:04',
    ],
    [
      '모임원 송금',
      '토스뱅크 [출금 안내] \n공룡통장 모임통장에서 6,500원이 출금됐어요. \n08/03 19:14\n조심미\n거래한 모임원 : 김*진',
    ],
    [
      '모임금고 저금',
      '토스뱅크 [모임통장 안내]\n공룡통장 모임통장 모임금고에 200,000원이 저금됐어요.\n08/02 16:23\n비상금\n거래한 모임원: 김*진',
    ],
  ];

  it.each(TOSS_BANK_WITHDRAWALS)(
    '토스뱅크 은행 거래를 승격하지 않는다: %s',
    (_label, content) => {
      const result = parseCardSms({ sender: '16617654', content, receivedAt });

      expect(result.transactionType).toBe('unknown');
      expect(result.warnings).toContain('no matching parser');
      // 금액이 잡히면 워커가 승격할 여지가 생긴다 — 금액도 없어야 한다.
      expect(result.amount).toBeUndefined();
    },
  );

  /**
   * 실유입 서식 기반 합성 픽스처 — 실제 유입은 0건이지만(2026-08 기준 청구·결제예정·
   * 자동이체 문자 없음) generic 게이트가 조여지거나 풀릴 때 잡히도록 고정한다.
   * 각 문자는 금액과 액션 동사를 갖고 있어 게이트가 없으면 approval이 된다.
   */
  const NON_CARD_NOTICES: ReadonlyArray<readonly [string, string]> = [
    ['은행 자동이체', '우리은행 자동이체 결제 50,000원 정상 처리되었습니다.'],
    ['카드 결제 예정 안내', '삼성카드 08/25 결제 예정 금액 1,234,000원 안내입니다.'],
    ['이용대금 청구', '현대카드 이용대금 청구 안내 총 청구금액 890,000원'],
    ['계좌 입금', '토스뱅크 공룡통장에 300,000원이 입금됐어요.'],
  ];

  it.each(NON_CARD_NOTICES)('비카드 안내를 승격하지 않는다: %s', (_label, content) => {
    const result = parseCardSms({ sender: '15771234', content, receivedAt });

    expect(result.transactionType).not.toBe('approval');
    expect(result.transactionType).not.toBe('cancellation');
  });

  /**
   * 전용 파서(신한/KB)는 `supports()`가 발급사 키워드만 봤기 때문에 generic의 비카드
   * 게이트를 거치지 않았다. 그래서 `KB국민카드 결제 예정 금액 1,200,000원`(청구 예고)이
   * **approval 1,200,000원**으로 승격됐다 — '결제'가 액션으로 인식되기 때문이다.
   *
   * 이제 두 파서가 `isNonCardNotice()`를 공유한다(`parsers/non-card.ts`). 그 게이트는
   * **`잔액`을 보지 않는다** — 발급사가 확실한 문자에서 잔액 라인은 체크카드 승인
   * 알림의 정상 구성 요소다(아래 마지막 케이스가 그것을 고정한다).
   */
  const ISSUER_NON_CARD: ReadonlyArray<readonly [string, string]> = [
    ['신한 은행 출금', '신한은행 자동이체 출금 50,000원 도시가스'],
    ['신한 이용대금 청구', '신한카드 이용대금 청구 안내 890,000원'],
    ['KB 은행 이체', 'KB국민은행 이체 30,000원 홍길동'],
    ['KB 결제 예정', 'KB국민카드 결제 예정 금액 1,200,000원'],
  ];

  it.each(ISSUER_NON_CARD)(
    '전용 파서(신한/KB)도 비카드 문자를 승격하지 않는다: %s',
    (_label, content) => {
      const result = parseCardSms({ sender: '15447200', content, receivedAt });

      expect(result.transactionType).not.toBe('approval');
      expect(result.transactionType).not.toBe('cancellation');
    },
  );

  it('신한/KB 게이트가 잔액 라인이 있는 정상 승인 문자를 막지 않는다', () => {
    // 체크카드 승인 알림에는 잔액이 함께 오는 경우가 있다. 게이트가 '잔액'까지 보면
    // 정상 결제가 parse_failed 로 떨어진다(= 과소집계, 더 발견하기 어려운 실패).
    const content = [
      '신한카드(1234)승인',
      '12,500원 일시불',
      '08/03 09:30',
      '스타벅스강남점',
      '잔액 340,000원',
    ].join('\n');
    const result = parseCardSms({ sender: '15447200', content, receivedAt });

    expect(result.issuer).toBe('신한카드');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(12_500);
  });

  it('신한/KB 게이트가 거절 통지는 우회시킨다(declined 판정 유지)', () => {
    // 거절 사유가 곧 비카드 단어라서 게이트와 구조적으로 충돌한다. declined는 거래로
    // 승격되지 않으므로 통과시키는 쪽이 안전하다.
    const content = '신한카드(1234) 승인거절 08/03 09:30 스타벅스 12,500원 잔액부족';
    const result = parseCardSms({ sender: '15447200', content, receivedAt });

    expect(result.transactionType).toBe('declined');
    expect(result.warnings).not.toContain('no matching parser');
  });
});
