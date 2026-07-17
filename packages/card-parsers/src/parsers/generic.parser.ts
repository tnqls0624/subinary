/**
 * 범용 카드 SMS 파서 (fallback).
 *
 * 신한/KB 전용 파서가 매칭되지 않는 나머지 카드사(삼성/현대/롯데/하나/우리/BC/
 * 씨티/NH농협 등)를 위한 마지막 순위 파서. 한국 카드 결제 문자는 발급사와 무관하게
 * 레이아웃이 유사(승인/취소 + `N원` + `MM/DD HH:mm` + 가맹점)하므로, 공통
 * {@link buildResult} 파이프라인만으로 대부분의 필드를 추출할 수 있다.
 *
 * `supports()`는 오탐(비카드 문자 → 쓰레기 '승인' 거래)이 미탐(parse_failed →
 * 검토 큐)보다 훨씬 해로우므로 3중으로 좁힌다:
 *   1) 금액(`N원`) + 액션(승인/취소/…) — 결제성 문자의 최소 조건
 *   2) 카드 문맥 — '카드'/'일시불'/'N개월'/마스킹 꼬리 `(1234)` 또는 발급사
 *      브랜드 키워드(단, 바로 뒤에 '은행'이 붙으면 은행 문자로 보고 제외)
 *   3) 은행/청구 배제 — 입출금·이체·잔액·'결제 예정'·청구 등은 카드 승인이 아님
 * 발급사 라벨은 액션이 있는 헤더 라인에서 우선 추론한다 — 본문 전체를 먼저 훑으면
 * 가맹점명('하나로마트', '현대백화점')이 발급사로 오라벨되기 때문. 못 찾으면 일반
 * `카드`로 둔다(가맹점을 지어내지 않는 원칙과 동일).
 */
import { buildResult } from './base.parser.js';

import type { CardSmsInput, CardSmsParseResult, CardSmsParser } from '../types.js';

/** 결제성 문자의 최소 조건: 금액 토큰 + 액션 키워드. */
const AMOUNT_TOKEN_RE = /[\d,]+\s*원/;
const ACTION_TOKEN_RE = /(승인|취소|결제|매출|매입|환불|정정)/;

/**
 * 카드 문맥: '카드'·할부 표기·마스킹 꼬리, 또는 발급사 브랜드 키워드.
 * 브랜드 키워드는 바로 뒤에 '은행'이 오면 매칭하지 않는다("우리은행 자동이체"가
 * '우리' 브랜드로 오인되어 카드 문자로 흡수되는 것을 방지).
 */
const CARD_CONTEXT_RE =
  /(카드|일시불|\d{1,2}\s*개월|\(\d{4}\)|(?:신한|국민|KB|삼성|현대|롯데|하나|우리|비씨|BC|씨티|NH|농협)(?!\s*은행))/;

/**
 * 은행/청구성 문자 배제: 계좌 입출금·이체·잔액 통지, 요금 '결제 예정'·청구 안내는
 * 금액+액션 형태가 카드 승인과 겹치므로 명시적으로 걸러낸다. (오배제 시 실패
 * 모드는 parse_failed → 검토 화면 노출이라 복구 가능 — 쓰레기 승인 거래보다 안전.)
 */
const NON_CARD_RE = /(입금|출금|이체|송금|잔액|결제\s*예정|청구|대출)/;

/**
 * 발급사 키워드 → 정식 라벨. 신한/KB는 전용 파서가 먼저 처리하지만, 안전하게
 * 여기에도 포함해 둔다.
 */
const ISSUER_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/신한/, '신한카드'],
  [/(?:KB|국민)/, 'KB국민카드'],
  [/삼성/, '삼성카드'],
  [/현대/, '현대카드'],
  [/롯데/, '롯데카드'],
  [/하나/, '하나카드'],
  [/우리/, '우리카드'],
  [/(?:비씨|BC)/, 'BC카드'],
  [/씨티/, '씨티카드'],
  [/(?:NH|농협)/, 'NH농협카드'],
];

/**
 * 발급사 라벨 추론. 액션 키워드가 있는 헤더 라인들(예: `NH농협카드 승인`)을 먼저
 * 스캔해 가맹점 라인('하나로마트' 등)의 브랜드 오탐을 배제하고, 헤더에서 못 찾으면
 * 본문 전체로 폴백한다. 그래도 없으면 일반 `카드`.
 */
function detectIssuer(content: string): string {
  const headerLines = content
    .split(/[\r\n]+/)
    .filter((line) => ACTION_TOKEN_RE.test(line))
    .join('\n');

  for (const scope of [headerLines, content]) {
    if (!scope) continue;
    for (const [re, label] of ISSUER_LABELS) {
      if (re.test(scope)) return label;
    }
  }
  return '카드';
}

export class GenericCardParser implements CardSmsParser {
  readonly issuer = '카드';

  supports(input: CardSmsInput): boolean {
    const { content } = input;
    return (
      AMOUNT_TOKEN_RE.test(content) &&
      ACTION_TOKEN_RE.test(content) &&
      CARD_CONTEXT_RE.test(content) &&
      !NON_CARD_RE.test(content)
    );
  }

  parse(input: CardSmsInput): CardSmsParseResult {
    return buildResult(detectIssuer(input.content), input);
  }
}
