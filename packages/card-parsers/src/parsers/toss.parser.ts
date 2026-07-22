/**
 * 토스뱅크 체크카드 알림(카카오 알림톡 중계) 파서.
 *
 * 대표 레이아웃:
 *
 * ```
 * [토스뱅크] 체크카드 국내 결제
 * 김*진님의 공룡통장 카드
 * 46,460원 결제 | 영등포농협 하나로마트 도림시장
 * 잔액 109,798원
 * ```
 *
 * 공통 파이프라인({@link buildResult})을 쓰지 못하는 이유:
 * - 하단 `잔액 N원` 라인이 generic 파서의 은행 문자 배제 규칙(`잔액`)에 걸려
 *   메시지 전체가 parse_failed 로 떨어진다.
 * - 가맹점이 `N원 결제 | 가맹점` 형태로 금액 라인 뒤에 붙어, 공통 휴리스틱은
 *   `잔액 …` 라인을 가맹점으로 오추출한다.
 * - 가맹점 라인의 지역 농협/은행 상호(`영등포농협 …`)가 발급사로 오라벨된다.
 * - 승인 시각이 본문에 없다 — 알림톡은 결제 직후 실시간 수신되므로 receivedAt
 *   으로 근사한다(occurredAt 부재 시 취소↔승인 연결·유사중복 판정이 모두
 *   비활성화되는 것보다 근사가 낫다). 근사 사실은 warning 으로 남긴다.
 *
 * **접힌(collapsed) 알림 변형** — 자동화 도구(MacroDroid/단축어)가 펼치지 않은
 * 알림을 캡처하면 헤더(`[토스뱅크]`)와 결제 금액 라인(`N원 결제`)이 통째로 빠진
 * 채 `<카드> | <가맹점>` + `잔액 N원` 두 줄만 도착한다(예:
 * `공룡통장 카드 | 쿠팡(쿠페이)` / `잔액 126,713원`). 결제 금액이 원문에 없어
 * (잔액≠결제액) 금액은 복원할 수 없다 — 이 건은 워커에서 여전히 parse_failed 로
 * 남지만, 발급사/가맹점/유형을 채우고 원인을 warning 으로 남겨 'no matching
 * parser' 대신 검토 가능한 레코드가 되게 한다. 근본 해결은 자동화가 펼친 알림
 * (bigText)을 캡처하도록 고치는 것이다.
 *
 * 카드번호가 없어 자동연결은 발급사 폴백(가족 내 활성 '토스뱅크' 카드가 유일할
 * 때)으로만 이루어진다 — 카드 등록 시 발급사를 '토스뱅크'로 선택해야 한다.
 */
import { KNOWN_CURRENCY_CODES, toMinorUnits } from '../currency.js';

import {
  computeConfidence,
  parseInstallmentMonths,
  parseMaskedCardNumber,
  parseOccurredAt,
} from './base.parser.js';

import type { CardSmsInput, CardSmsParseResult, CardSmsParser } from '../types.js';

/** `46,460원 결제` — 결제 금액 라인(잔액 라인과 구분되는 유일한 앵커). */
const PAY_AMOUNT_RE = /([\d,]+)\s*원\s*결제/;
/** 임의 금액 토큰(잔액 라인 제외 폴백용). */
const ANY_AMOUNT_RE = /([\d,]+)\s*원/;
/** 외화 통화 코드(KRW 제외). */
const FX_CODE_ALT = KNOWN_CURRENCY_CODES.filter((code) => code !== 'KRW').join('|');
/** `5.99 USD 결제` 또는 `USD 5.99 결제` — 해외 결제 앵커(결제/승인 suffix로 잔액 오인 방지). */
const FX_PAY_RE = new RegExp(
  `(?:([\\d,]+(?:\\.\\d+)?)\\s*(${FX_CODE_ALT})|(${FX_CODE_ALT})\\s*([\\d,]+(?:\\.\\d+)?))\\s*(?:결제|승인)`,
);
/** 잔액 안내 라인 — 금액 폴백에서 제외한다. */
const BALANCE_LINE_RE = /^\s*잔액/;
/** 잔액 라인 존재 여부(접힌 알림 판별용, 본문 전체 대상). */
const BALANCE_ANY_RE = /잔액\s*[\d,]+\s*원/;
/** `… | <가맹점>` — 파이프 뒤에 실제 가맹점 토큰이 있는지(접힌 알림 판별용). */
const PIPE_MERCHANT_RE = /\|\s*[^\s|]/;
/**
 * `N원 결제 [취소] | 가맹점` — 같은 줄의 파이프 뒤가 가맹점. 앵커에 결제/승인/카드를
 * 포함해 (a) 해외 결제 변형(`5.99 USD 결제 | OPENAI …` — '원' 없음)과 (b) 접힌 알림
 * 변형(`공룡통장 카드 | 쿠팡(쿠페이)` — 결제 금액·키워드 없음)에서도 가맹점을
 * 보존한다(금액은 못 살려도 검토 화면에서 식별이 쉬워진다). `카드` 앵커는 파이프가
 * 있는 줄에서만 발동하므로(`[^|\r\n]*\|` 요구) 표준 레이아웃의 가맹점 추출에
 * 영향을 주지 않는다.
 */
const MERCHANT_AFTER_PIPE_RE = /(?:원|결제|승인|카드)[^|\r\n]*\|\s*([^\r\n]+)/;
/** 계좌 입출금/이체 알림 배제(카드 결제 알림이 아님). */
const TRANSFER_RE = /(입금|출금|이체|송금)/;
/**
 * 결제 실패/거절 알림 배제 — 승인되지 않은 지출이 approved 거래로 승격되는 것을
 * 막는다(generic 파서였다면 '잔액' 배제로 걸렸을 문자가, 이 파서는 잔액 배제를
 * 풀었으므로 여기서 직접 걸러야 한다).
 */
const DECLINED_RE = /(실패|거절|한도\s*초과)/;

/** 콤마 금액 문자열 → KRW 정수(minor==major, 부동소수 금지). */
function toKrwInteger(raw: string): { amount?: number; currency?: string; warning?: string } {
  const digits = raw.replace(/[,\s]/g, '');
  if (digits.length === 0) return { warning: 'amount not found' };
  const amount = Number(digits);
  if (!Number.isInteger(amount) || amount < 0) {
    return { warning: `amount not an integer: ${raw}` };
  }
  return { amount, currency: 'KRW' };
}

/**
 * 결제 금액 추출: 원화 `N원 결제` 우선 → 외화 `N USD 결제` → 잔액 제외 첫 원화.
 * 외화는 minor units + 통화 코드로 반환한다(해외 결제 알림톡 지원).
 */
function parseTossAmount(content: string): {
  amount?: number;
  currency?: string;
  warning?: string;
} {
  const pay = content.match(PAY_AMOUNT_RE);
  if (pay) return toKrwInteger(pay[1]);

  const fx = content.match(FX_PAY_RE);
  if (fx) {
    const raw = fx[1] ?? fx[4];
    const code = (fx[2] ?? fx[3]).toUpperCase();
    const { minor, warning } = toMinorUnits(raw, code);
    if (minor === undefined) return { warning: warning ?? 'amount not found' };
    return { amount: minor, currency: code, warning };
  }

  for (const line of content.split(/[\r\n]+/)) {
    if (BALANCE_LINE_RE.test(line)) continue;
    const match = line.match(ANY_AMOUNT_RE);
    if (match) return toKrwInteger(match[1]);
  }
  return { warning: 'amount not found' };
}

/** 가맹점: `| ` 뒤 텍스트. 없으면 undefined(지어내지 않는다). */
function parseTossMerchant(content: string): string | undefined {
  const match = content.match(MERCHANT_AFTER_PIPE_RE);
  if (!match) return undefined;
  const merchant = match[1].trim();
  return merchant.length > 0 ? merchant : undefined;
}

export class TossBankCardParser implements CardSmsParser {
  readonly issuer = '토스뱅크';

  /**
   * 카드 문맥 필수 + (표준) 토스뱅크 헤더·결제 액션·금액, 또는 (접힌 알림)
   * `<카드> | <가맹점>` 파이프 + `잔액` 라인. 어느 쪽이든 계좌 입출금/이체 알림과
   * 결제 실패/거절 알림은 먼저 배제한다(잔액 라인 자체는 결제 알림에도 있어 배제
   * 사유가 아니다 — generic 파서와의 차이점).
   *
   * 접힌 알림 갈래는 금액·헤더가 빠진 변형을 인식하기 위한 것으로, `| 가맹점` +
   * `잔액`이라는 토스 푸시 특유의 시그니처를 함께 요구해 오탐을 좁힌다. 이 갈래로
   * 잡혀도 금액이 없으면 워커가 parse_failed 로 두므로 유령 거래 승격은 없다.
   */
  supports(input: CardSmsInput): boolean {
    const { content } = input;
    if (!content.includes('카드')) return false;
    if (TRANSFER_RE.test(content) || DECLINED_RE.test(content)) return false;

    const standard =
      content.includes('토스뱅크') && /(결제|승인)/.test(content) && ANY_AMOUNT_RE.test(content);
    const collapsed = PIPE_MERCHANT_RE.test(content) && BALANCE_ANY_RE.test(content);
    return standard || collapsed;
  }

  parse(input: CardSmsInput): CardSmsParseResult {
    const warnings: string[] = [];

    // supports()가 결제/승인을 보장하므로 unknown 은 없다. 취소가 우선.
    const transactionType: CardSmsParseResult['transactionType'] = /(취소|환불)/.test(
      input.content,
    )
      ? 'cancellation'
      : 'approval';

    const { amount, currency, warning: amountWarning } = parseTossAmount(input.content);
    if (amountWarning) warnings.push(amountWarning);
    // 접힌 알림(결제 금액 라인 없이 잔액만) — 금액은 복원 불가(잔액≠결제액). 검토
    // 화면에서 원인이 드러나도록, 그리고 자동화 캡처 수정을 유도하도록 남긴다.
    if (amount === undefined && BALANCE_ANY_RE.test(input.content)) {
      warnings.push('payment amount line missing (collapsed notification); expand notification capture');
    }

    // 본문에 시각이 있으면 사용, 없으면 receivedAt 근사(알림톡은 실시간 수신).
    let { occurredAt } = parseOccurredAt(input.content, input.receivedAt);
    if (!occurredAt) {
      occurredAt = input.receivedAt;
      warnings.push('occurredAt approximated from receivedAt');
    }

    const merchantRaw = parseTossMerchant(input.content);
    if (merchantRaw === undefined) warnings.push('merchant not found');

    const result: CardSmsParseResult = {
      issuer: this.issuer,
      transactionType,
      amount,
      currency: amount !== undefined ? (currency ?? 'KRW') : undefined,
      merchantRaw,
      occurredAt,
      maskedCardNumber: parseMaskedCardNumber(input.content),
      installmentMonths: parseInstallmentMonths(input.content),
      confidence: 0,
      warnings,
    };
    result.confidence = computeConfidence(result);
    return result;
  }
}
