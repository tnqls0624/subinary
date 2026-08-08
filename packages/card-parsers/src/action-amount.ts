/**
 * 액션 결박(action-grounded) 금액 추출 — ADR-0027 결정 §5의 **shadow 구현**.
 *
 * 기존 추출기({@link parseAmount})는 본문의 **첫 `N원`**을 고른다. 그래서
 * `삼성카드 이용한도 1,000,000원 / 승인 10,000원`이 1,000,000원 승인이 되고,
 * `삼성카드 8/10 온라인 결제 시 5,000원 할인`이 5,000원 소비가 된다(ADR-0027 D-4).
 * 환산 이전의 입력 자체가 틀린 경우라 저장 계약만 공통화해서는 막을 수 없다.
 *
 * **이 모듈은 기존 추출기를 대체하지 않는다.** 병행 실행해 결과가 갈리는 지점을
 * 구조화해 돌려줄 뿐이다(롤아웃 3단계 = shadow 측정). 게이트 활성화(L0 성공 조건을
 * 이 결과로 바꾸는 것)는 롤아웃 6단계이고 이번 범위가 아니다.
 *
 * 범위도 좁다: 이것은 **이미 카드 문자로 판정된 본문 안에서 어느 금액이 거래
 * 금액인가**를 고르는 추출기이지, 비카드 문자 배제 게이트(`non-card.ts`,
 * generic의 `NON_CARD_RE`)가 아니다. 카드 문맥이 없는 문자에 단독으로 돌리면
 * 은행 문자에서도 금액을 찾아낸다 — 그건 이 모듈의 실패가 아니라 게이트의 일이다.
 * {@link compareAmountEvidence}가 `routed` 플래그로 그 구분을 남긴다.
 *
 * ## 결정 절차 (전부 결정적, LLM 없음)
 *
 * 1. 본문을 **거래 구간**으로 자른다 — 줄바꿈·파이프·(숫자 사이가 아닌) 슬래시.
 *    슬래시를 숫자 사이에서는 자르지 않는 이유는 `07/19/15:00`이 날짜/시각이기
 *    때문이다. `1,000,000원 / 승인`처럼 숫자에 붙지 않은 슬래시만 구간 경계다.
 * 2. 금액 후보를 열거한다 — 후보 정의는 레시피 경로와 **같은 함수**를 쓴다
 *    ({@link fieldCandidates}). 두 경로가 갈리면 같은 원문에서 서로 다른 증거를
 *    내놓게 되고, ADR-0027 §5의 "같은 span 불변식" 요구가 깨진다.
 * 3. 후보마다 **지배 문맥**(governing context)을 본다: 같은 구간에서 그 후보 직전의
 *    액션 토큰(없으면 구간 시작)부터 후보까지의 텍스트. 여기에 한도·누적·누계·
 *    잔액이 있으면 거래 금액이 아니다(`잔액 340,000원`은 한국어 어순상 키워드가
 *    금액 **앞**에 온다). 반대로 `스타벅스 12,500원 잔액부족`처럼 뒤에 오는 것은
 *    거절 사유이지 잔액 표시가 아니므로 배제하지 않는다 — 이 비대칭이 없으면
 *    ADR-0024의 거절 가시성이 조용히 죽는다.
 * 4. 판촉(할인·혜택·쿠폰·이벤트·적립·캐시백)은 **구간 전체**에 걸어 양방향으로
 *    배제한다. 광고는 `5,000원 할인`처럼 금액 뒤에 수식어가 오기 때문이다.
 * 5. 유효 후보가 **정확히 하나**일 때만 확정한다. 0개나 2개 이상이면 임의로 첫 값을
 *    고르지 않고 그대로 실패를 돌려준다(호출부가 L1→L2→사람 검토로 내려보낸다).
 *
 * ## Tier 1 / Tier 2
 *
 * ADR §5는 "액션과 같은 구간의 후보만 남긴다"고 쓰지만, 한국 카드 문자의 지배적
 * 레이아웃은 액션과 금액이 **다른 줄**이다(`신한카드(1234)승인` ⏎ `12,500원 일시불`).
 * 그래서 두 단계로 나눈다:
 *
 * - **Tier 1** — 액션이 있는 구간 안의 후보. 있으면 여기서 끝낸다.
 * - **Tier 2** — Tier 1이 비었을 때만, 실격되지 않은 전 구간의 후보.
 *
 * Tier 1이 비었을 때만 내려가는 것이 핵심이다. `이용한도 1,000,000원 / 승인 10,000원`은
 * Tier 1에서 `10,000원` 하나가 잡히므로 한도 금액은 애초에 후보 집합에 오르지 않는다.
 *
 * span offset은 ADR-0027 §5대로 **원문(rawContent)의 UTF-16 code unit** 기준
 * `[start,end)`이며 `content.slice(start,end)`가 증거 문자열을 그대로 복원한다.
 */
import { parseAmount } from './parsers/base.parser.js';
import { fieldCandidates } from './recipe.js';

import type { Span } from './spans.js';
import type { CardSmsInput, CardSmsParseResult } from './types.js';

/**
 * 구간 경계: 줄바꿈·파이프, 그리고 **양옆이 모두 숫자가 아닌** 슬래시.
 * `07/19/15:00`(날짜+시각)은 자르지 않고 `1,000,000원 / 승인`은 자른다.
 */
const SEGMENT_BREAK_RE = /[\r\n|]|(?<!\d)\/|\/(?!\d)/g;

/**
 * 거래 액션 토큰. base/generic 파서가 쓰는 집합과 같다(`결제` 포함).
 * `승인거절`은 `승인`을 포함하므로 여기서도 액션으로 잡히는데, 거절 문자의 금액은
 * ADR-0024의 가시성 용도로 여전히 유효한 증거다(거래 생성은 별개 문제).
 */
const ACTION_TOKEN_RE = /승인|취소|환불|매출|매입|정정|결제/g;

/**
 * 조건형 `결제 시 …`는 실제 거래 액션이 아니라 광고의 조건절이다(ADR-0027 §5-2).
 * `결제 시간`·`결제 시각`은 조건절이 아니므로 제외한다.
 */
const CONDITIONAL_ACTION_RE = /^\s*시(?![간각])/;

/**
 * 판촉 문맥 — 구간 전체에 양방향으로 적용한다. 광고는 `5,000원 할인`처럼 수식어가
 * 금액 뒤에 오는 어순이 흔해 "앞에 오는 것만" 보면 놓친다.
 */
const PROMOTION_RE = /할인|혜택|쿠폰|이벤트|적립|캐시백|사은|증정|프로모션|특가/;

/**
 * 상태·예고 금액 문맥 — 후보 **앞**(지배 문맥)에만 적용한다. `잔액 340,000원`,
 * `누적123,456원`, `이용한도 1,000,000원` 모두 키워드가 금액을 수식하며 앞에 온다.
 *
 * `잔액`을 여기 넣는 것은 안전하다: 이 모듈은 파서 게이트가 아니라 **금액 선택**만
 * 하므로, 잔액 라인을 후보에서 빼도 정상 승인 금액은 다른 줄에서 그대로 잡힌다
 * (토스뱅크 파서가 `BALANCE_LINE_RE`로 이미 같은 일을 한다). 게이트 단계에서 잔액을
 * 배제하면 정상 결제가 통째로 parse_failed가 되지만, 여기서는 그런 일이 없다.
 */
const STATE_AMOUNT_RE = /한도|누적|누계|잔액|잔여/;

/** 청구·예고 문맥 — 어순이 양쪽 다 나타나므로 구간 전체에 적용한다. */
const BILLING_RE = /청구|예정/;

/** 금액 후보가 탈락한 이유. shadow 리포트가 오탐/미탐을 설명하는 근거다. */
export type DiscardReason =
  /** 판촉 구간(할인·혜택·쿠폰·이벤트·적립…). */
  | 'promotion'
  /** 한도·누적·누계·잔액 등 상태 금액. */
  | 'state_amount'
  /** 청구·결제예정 등 예고 금액. */
  | 'billing'
  /** 통화를 확정할 수 없어 정규화 실패. */
  | 'not_normalizable'
  /** 유효했지만 후보가 여럿이라 확정하지 못함. */
  | 'ambiguous';

export interface DiscardedAmountCandidate {
  readonly span: Span;
  /** 원문 slice — `content.slice(span.start, span.end)`와 동일. */
  readonly text: string;
  readonly reason: DiscardReason;
}

export type ActionAmountStatus =
  /** 액션에 결박된 유효 후보가 정확히 하나 — 확정. */
  | 'resolved'
  /** 금액 후보 자체가 없음. */
  | 'no_candidate'
  /** 후보는 있으나 전부 판촉·한도·누적·잔액·청구 문맥 — 거래 금액 아님. */
  | 'rejected_non_transaction'
  /** 본문 어디에도 거래 액션 토큰이 없음. */
  | 'no_action'
  /** 유효 후보가 둘 이상 — 첫 값을 고르지 않고 실패로 둔다. */
  | 'ambiguous';

/** 확정된 금액이 어느 범위에서 나왔는지. 게이트 강도를 나중에 조절할 수 있게 남긴다. */
export type ActionAmountScope =
  /** 액션 토큰과 같은 구간(ADR §5의 엄격 해석). */
  | 'action_segment'
  /** 액션은 다른 구간에 있고 후보가 전 구간에서 유일했음(줄 분리 레이아웃). */
  | 'message_block';

export interface ActionGroundedAmount {
  readonly status: ActionAmountStatus;
  /** minor units 정수. `status === 'resolved'`일 때만 존재. */
  readonly amount?: number;
  readonly currency?: string;
  /** 확정된 금액의 원문 span. */
  readonly amountSpan?: Span;
  /** 금액을 결박한 액션 토큰의 원문 span. */
  readonly actionSpan?: Span;
  readonly scope?: ActionAmountScope;
  /** 탈락한 후보와 사유(순서는 원문 등장 순). */
  readonly discarded: readonly DiscardedAmountCandidate[];
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** 조건형을 뺀 액션 토큰 span(구간 내, 원문 절대 좌표). */
  readonly actions: readonly Span[];
  readonly promotional: boolean;
  readonly billing: boolean;
}

/** 본문을 거래 구간으로 자른다. 공백뿐인 구간은 버린다(원문 좌표는 보존). */
function splitSegments(content: string): { start: number; end: number }[] {
  const bounds: { start: number; end: number }[] = [];
  const re = new RegExp(SEGMENT_BREAK_RE.source, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null = re.exec(content);
  while (match !== null) {
    bounds.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
    match = re.exec(content);
  }
  bounds.push({ start: cursor, end: content.length });
  return bounds.filter((b) => content.slice(b.start, b.end).trim().length > 0);
}

/** 구간 안의 액션 토큰 span. 조건형(`결제 시 …`)은 액션이 아니므로 건너뛴다. */
function findActions(content: string, start: number, end: number): Span[] {
  const text = content.slice(start, end);
  const re = new RegExp(ACTION_TOKEN_RE.source, 'g');
  const spans: Span[] = [];
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const tail = text.slice(match.index + match[0].length);
    if (!CONDITIONAL_ACTION_RE.test(tail)) {
      spans.push({ start: start + match.index, end: start + match.index + match[0].length });
    }
    match = re.exec(text);
  }
  return spans;
}

function buildSegments(content: string): Segment[] {
  return splitSegments(content).map(({ start, end }) => {
    const text = content.slice(start, end);
    return {
      start,
      end,
      text,
      actions: findActions(content, start, end),
      promotional: PROMOTION_RE.test(text),
      billing: BILLING_RE.test(text),
    };
  });
}

function segmentOf(segments: readonly Segment[], span: Span): Segment | undefined {
  return segments.find((seg) => span.start >= seg.start && span.start < seg.end);
}

/**
 * 후보의 지배 문맥 = 같은 구간에서 후보 직전의 액션 토큰(없으면 구간 시작)부터
 * 후보 시작까지. 액션 토큰에서 끊는 이유: `이용한도 1,000,000원 승인 10,000원`이
 * 한 구간으로 와도 `승인` 뒤의 `10,000원`은 한도의 지배를 받지 않기 때문이다.
 */
function governingContext(content: string, segment: Segment, span: Span): string {
  const priorActionEnd = segment.actions
    .filter((action) => action.end <= span.start)
    .reduce((max, action) => Math.max(max, action.end), segment.start);
  return content.slice(priorActionEnd, span.start);
}

/**
 * 액션에 결박된 거래 금액을 추출한다. 확정하지 못하면 값을 지어내지 않고 사유를
 * 돌려준다 — ADR-0027 §5-3("0개 또는 여러 개면 임의로 첫 값을 고르지 않는다").
 */
export function extractActionGroundedAmount(content: string): ActionGroundedAmount {
  const candidates = fieldCandidates(content, 'amount');
  if (candidates.length === 0) return { status: 'no_candidate', discarded: [] };

  const segments = buildSegments(content);
  const discarded: DiscardedAmountCandidate[] = [];
  const eligible: { span: Span; segment: Segment; amount: number; currency: string }[] = [];

  for (const span of candidates) {
    const text = content.slice(span.start, span.end);
    const segment = segmentOf(segments, span);
    if (segment === undefined) {
      // 구간에 속하지 않는 후보는 존재할 수 없지만, 조용히 승격되는 것보다 버린다.
      discarded.push({ span, text, reason: 'not_normalizable' });
      continue;
    }
    if (segment.promotional) {
      discarded.push({ span, text, reason: 'promotion' });
      continue;
    }
    if (segment.billing) {
      discarded.push({ span, text, reason: 'billing' });
      continue;
    }
    if (STATE_AMOUNT_RE.test(governingContext(content, segment, span))) {
      discarded.push({ span, text, reason: 'state_amount' });
      continue;
    }
    // 값은 원문 slice를 기존 결정적 함수에 통과시켜서만 만든다(ADR-0023 규약).
    const parsed = parseAmount(text);
    if (parsed.amount === undefined || parsed.currency === undefined) {
      discarded.push({ span, text, reason: 'not_normalizable' });
      continue;
    }
    eligible.push({ span, segment, amount: parsed.amount, currency: parsed.currency });
  }

  if (eligible.length === 0) return { status: 'rejected_non_transaction', discarded };

  // 액션은 실격 구간에서도 인정한다 — 실격은 그 구간의 **금액**에 대한 판단이지
  // "여기에 거래가 없다"는 판단이 아니다(`삼성카드 승인거절 한도초과` ⏎ `50,000원 …`).
  const allActions = segments.flatMap((seg) => seg.actions);
  if (allActions.length === 0) return { status: 'no_action', discarded };

  const tier1 = eligible.filter((c) => c.segment.actions.length > 0);
  const scope: ActionAmountScope = tier1.length > 0 ? 'action_segment' : 'message_block';
  const pool = tier1.length > 0 ? tier1 : eligible;

  if (pool.length > 1) {
    return {
      status: 'ambiguous',
      discarded: [
        ...discarded,
        ...pool.map((c) => ({ span: c.span, text: content.slice(c.span.start, c.span.end), reason: 'ambiguous' as const })),
      ],
    };
  }

  const chosen = pool[0];
  const actionSpan =
    scope === 'action_segment'
      ? // 같은 구간의 액션 중 후보를 결박하는 것: 후보 앞의 마지막 액션, 없으면 첫 액션.
        (chosen.segment.actions.filter((a) => a.end <= chosen.span.start).at(-1) ??
        chosen.segment.actions[0])
      : allActions[0];

  return {
    status: 'resolved',
    amount: chosen.amount,
    currency: chosen.currency,
    amountSpan: chosen.span,
    actionSpan,
    scope,
    discarded,
  };
}

/* ---------------------------------------------------------------------------
 * shadow 비교 — 기존 결과와 새 추출기의 차이를 분류한다.
 * ------------------------------------------------------------------------- */

export type AmountShadowVerdict =
  /** 동일(금액·통화 일치, 또는 양쪽 다 금액 없음). */
  | 'same'
  /** 신규가 비승격 판정 — 판촉·한도·잔액·청구로 걸러 오탐 후보를 제거했다. */
  | 'new_rejects_legacy'
  /** 금액 다름 — 어느 쪽이 옳은지는 픽스처가 판정한다. */
  | 'amount_differs'
  /** 신규가 추출 실패(후보 없음/모호) — 미탐 후보. */
  | 'new_missing'
  /** 기존이 못 뽑은 금액을 신규가 뽑음. */
  | 'legacy_missing';

export interface AmountShadowRecord {
  /**
   * 이 문자가 실제로 어떤 파서에 라우팅됐는지. `false`면 비카드 게이트가 이미
   * 걸러낸 문자이므로 verdict를 게이트 지표로 집계하면 안 된다.
   */
  readonly routed: boolean;
  readonly verdict: AmountShadowVerdict;
  readonly legacyAmount?: number;
  readonly legacyCurrency?: string;
  readonly candidate: ActionGroundedAmount;
}

/** 신규가 "거래 금액이 아니다"라고 **판정**한 상태(단순 실패와 구분). */
const REJECTING_STATUSES: ReadonlySet<ActionAmountStatus> = new Set([
  'rejected_non_transaction',
  'no_action',
]);

/**
 * 기존 파싱 결과와 새 추출기를 대조한다. **아무것도 바꾸지 않는다** — 판정만
 * 돌려준다(롤아웃 3단계).
 */
export function compareAmountEvidence(
  input: CardSmsInput,
  legacy: CardSmsParseResult,
): AmountShadowRecord {
  const candidate = extractActionGroundedAmount(input.content);
  const routed = !legacy.warnings.includes('no matching parser');
  const legacyAmount = legacy.amount;
  const base = {
    routed,
    legacyAmount,
    legacyCurrency: legacy.currency,
    candidate,
  };

  if (legacyAmount === undefined) {
    return { ...base, verdict: candidate.status === 'resolved' ? 'legacy_missing' : 'same' };
  }
  if (candidate.status !== 'resolved') {
    return {
      ...base,
      verdict: REJECTING_STATUSES.has(candidate.status) ? 'new_rejects_legacy' : 'new_missing',
    };
  }
  const same =
    candidate.amount === legacyAmount &&
    (legacy.currency === undefined || candidate.currency === legacy.currency);
  return { ...base, verdict: same ? 'same' : 'amount_differs' };
}

/** shadow 집계용 요약. 게이트 판정에 쓰이는 것은 `routed` 레코드뿐이다. */
export interface AmountShadowSummary {
  readonly total: number;
  readonly routed: number;
  readonly unrouted: number;
  readonly byVerdict: Readonly<Record<AmountShadowVerdict, number>>;
}

export function summarizeAmountShadow(
  records: readonly AmountShadowRecord[],
): AmountShadowSummary {
  const byVerdict: Record<AmountShadowVerdict, number> = {
    same: 0,
    new_rejects_legacy: 0,
    amount_differs: 0,
    new_missing: 0,
    legacy_missing: 0,
  };
  let routed = 0;
  for (const record of records) {
    if (!record.routed) continue;
    routed += 1;
    byVerdict[record.verdict] += 1;
  }
  return {
    total: records.length,
    routed,
    unrouted: records.length - routed,
    byVerdict,
  };
}
