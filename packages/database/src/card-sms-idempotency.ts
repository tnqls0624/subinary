/**
 * 카드 문자 수집 멱등 키 규칙 (P0-9).
 *
 * ## 왜 이 파일이 `@family/database`에 있는가
 *
 * 여기서 만드는 값이 곧 `card_sms_events.event_id`이고, 그 컬럼은
 * `UNIQUE(device_id, event_id)`가 지키는 대상이다. 파생 규칙과 그 규칙을 강제하는
 * 제약이 서로 다른 패키지에 있으면 한쪽만 바뀌어도 아무것도 실패하지 않는다 —
 * 조용히 중복이 생기거나 조용히 사라진다. `transaction-money.ts`(ADR-0027)가 금액
 * 계약을 스키마 옆에 둔 것과 같은 이유다. DB 접근은 하지 않는 순수 함수다.
 *
 * ## 원리적으로 풀 수 없는 딜레마
 *
 * 클라이언트가 고유값을 하나도 주지 않으면 서버는 **"같은 이벤트의 재시도"와 "같은
 * 문자를 만든 별개 결제"를 구분할 수 없다.** 어느 쪽으로 기울여도 대가가 있다.
 *
 * - 중복 제거 우선 → 실제 결제가 사라진다(과소집계, 발견 어려움)
 * - 별개 취급 우선 → 재시도가 거래를 두 배로 만든다(과대집계, 발견 쉬움)
 *
 * 이 모듈은 딜레마를 없애지 않는다. **손실을 영구에서 유한한 창으로 줄이고**, 어느
 * 경로로 들어온 건지 세어 언제 멱등 키를 필수화할 수 있는지 판단할 근거를 남긴다.
 *
 * ## 세 갈래 사다리 (위로 갈수록 정확하다)
 *
 * 1. `client` — 호출자가 `eventId`를 줬다. 그 값을 그대로 쓴다. 멱등을 호출자가
 *    직접 제어하므로 서버가 창을 씌우지 않는다. **최종적으로 도달하고 싶은 상태.**
 * 2. `derived_received_at` — `eventId`는 없지만 수신 시각을 줬다. 시각을 해시에
 *    섞으면 재시도는 같은 값(멱등 유지), 다른 시각의 결제는 다른 값이 된다.
 *    정확도는 클라이언트가 준 시각의 해상도에 달렸다(분 단위면 같은 분은 뭉친다).
 * 3. `derived_window` — 아무것도 없다. 이 경로만이 P0-9의 버그 지점이다.
 *    서버 수신 시각을 {@link CARD_SMS_DEDUPE_WINDOW_MS} 크기로 바닥 정렬해 해시에
 *    섞는다. 창이 넘어가면 같은 문자도 **별개 이벤트**가 된다.
 *
 * ## 창 크기를 왜 3분으로 잡았나
 *
 * 창은 두 가지 실패 사이의 저울이다 — 좁으면 재시도가 중복 거래를 만들고, 넓으면
 * 지금 버그(진짜 결제 소실)가 그만큼 남는다.
 *
 * - **재시도 쪽 상한**: 자동화(MacroDroid/단축어)의 재전송은 즉시 재시도이거나
 *   연결 복구 직후 재발화다. 분 단위를 넘기는 재시도는 관측되지 않았다. 같은 SMS가
 *   OS/RCS 중복 알림으로 두 번 트리거되는 경우도 초 단위다.
 * - **별개 결제 쪽 하한**: 바이트 단위로 같은 문자가 되려면 가맹점·금액·카드가 모두
 *   같아야 하고, 국내 카드사 문자는 대개 `MM/DD HH:mm`을 포함하므로 **같은 분**이어야
 *   한다. 타임스탬프가 없는 짧은 문자만 이 조건에서 자유롭다. 같은 가맹점·같은 금액을
 *   3분 안에 두 번 긁는 것은 POS 재승인 정도이고, 그건 대개 앞선 시도가 거절(별도
 *   문구)이라 본문이 달라진다.
 *
 * 3분은 재시도 실측 상한보다 넉넉하고 별개 결제 하한보다 좁은 구간이다. 무엇보다
 * **손실이 유한해진다**: 최악의 경우 (장치, 동일 본문)당 3분에 1건이고, 그 1건조차
 * 원문이 `card_sms_ingest_suppressions`에 남아 복구할 근거가 있다(현재는 영구 소실 +
 * 흔적 없음).
 *
 * 창을 env로 빼지 않은 이유: 창 크기가 배포마다 다르면 `event_id`의 의미가 배포마다
 * 달라진다. 같은 문자가 어떤 서버에서는 같은 키, 어떤 서버에서는 다른 키가 되면
 * 멱등이 환경 설정에 의존하게 된다. 바꿔야 한다면 코드 변경 + 이 주석의 근거 갱신으로
 * 한다.
 */
import { createHash } from 'node:crypto';

/**
 * 멱등 키가 없을 때 서버가 "같은 이벤트"로 볼 최대 간격(밀리초). 이 시간이 지나면
 * 바이트 단위로 같은 문자도 별개 결제로 취급한다. 근거는 파일 상단 주석 참조.
 */
export const CARD_SMS_DEDUPE_WINDOW_MS = 3 * 60 * 1000;

/**
 * 멱등 키의 출처. `card_sms_events.key_source`에 그대로 저장되어 "키 있는 수집 /
 * 키 없는 수집"의 집계 근거가 된다 — 이 비율이 충분히 낮아져야 `eventId`를 필수화할
 * 수 있다.
 */
export const CARD_SMS_KEY_SOURCES = [
  'client',
  'derived_received_at',
  'derived_window',
] as const;
export type CardSmsKeySource = (typeof CARD_SMS_KEY_SOURCES)[number];

/** 파생(폴백) 경로인지 — 관측 집계와 창 기반 중복 판정 적용 여부의 기준. */
export function isDerivedCardSmsKey(source: CardSmsKeySource): boolean {
  return source !== 'client';
}

/**
 * `sha256(sender + "\n" + content)` 소문자 hex — **본문 지문**.
 *
 * 수신 시각을 일부러 섞지 않는다: 이 값의 용도는 "같은 원문인가" 상관/감사이고,
 * `card_sms_events.content_hash`가 이미 같은 규칙으로 채워져 있다. 창 기반 중복
 * 판정이 배포 이전 행과도 맞물리는 이유가 이것이다 — 키 형식이 바뀌어도 지문은 그대로다.
 */
export function cardSmsContentHash(sender: string, content: string): string {
  return createHash('sha256').update(`${sender}\n${content}`, 'utf8').digest('hex');
}

/**
 * 멱등 키 파생 — `sha256(sender + "\n" + content [+ "\n" + tag])`.
 *
 * `tag`는 시간 축을 넣는 자리다(클라이언트 수신 시각 또는 서버 창 시작점). 비어 있으면
 * 시간 축이 전혀 없는 옛 규칙이 되며, 그 형태는 P0-9의 버그 그 자체다 — 새 코드에서
 * tag 없이 부르지 말 것. (인자를 남겨 둔 이유는 배포 이전 행의 키를 재현해야 하는
 * 검증·조사 경로 때문이다.)
 */
export function deriveCardSmsEventId(
  sender: string,
  content: string,
  tag?: string,
): string {
  const trimmed = (tag ?? '').trim();
  return createHash('sha256')
    .update(`${sender}\n${content}${trimmed ? `\n${trimmed}` : ''}`, 'utf8')
    .digest('hex');
}

/**
 * 수신 시각을 창 크기로 **바닥 정렬**한 시작점. epoch 기준으로 정렬하므로 서버가
 * 여러 대여도 같은 창을 본다(로컬 타임존·프로세스 시작 시각에 의존하지 않는다).
 *
 * 창을 키에 섞으면 같은 창 안의 동시 재시도는 `UNIQUE(device_id, event_id)`가 DB에서
 * 흡수한다. 창 **경계**를 사이에 두고 갈라지는 재시도(예: 179초/181초)는 키가 달라지므로
 * 제약으로는 못 잡는다 — 그건 지문 + 슬라이딩 창 조회가 맡는다. 두 장치가 함께 있어야
 * 재시도가 안전하다.
 */
export function cardSmsDedupeWindowStart(at: Date): Date {
  const ms = at.getTime();
  return new Date(Math.floor(ms / CARD_SMS_DEDUPE_WINDOW_MS) * CARD_SMS_DEDUPE_WINDOW_MS);
}

/** 창 기반 중복 조회의 하한 — `received_at > lowerBound` 인 행만 같은 이벤트로 본다. */
export function cardSmsDedupeWindowLowerBound(at: Date): Date {
  return new Date(at.getTime() - CARD_SMS_DEDUPE_WINDOW_MS);
}

export interface CardSmsIdempotencyInput {
  /** 호출자가 명시한 멱등 키. 비었거나 공백뿐이면 없는 것으로 본다. */
  eventId?: string | null;
  sender: string;
  content: string;
  /** 계약상의 UTC ISO-8601 수신 시각(선택). */
  receivedAt?: string | null;
  /**
   * `card-sms-text` 전용 자유 형식 수신 시각 헤더(`X-Received-At`). ISO가 아닐 수
   * 있어 `receivedAt`으로 파싱하지 못하지만 **시간 축으로서는 유효하다** — 같은 문자의
   * 재전송이면 같은 문자열이 오기 때문이다. 해시 재료로만 쓰고 저장하지는 않는다.
   */
  receivedAtTag?: string | null;
  /** 서버가 이 요청을 받은 순간. 창 정렬의 기준. */
  ingestedAt: Date;
}

export interface CardSmsIdempotency {
  eventId: string;
  keySource: CardSmsKeySource;
  /** `sha256(sender\ncontent)` — 창 기반 중복 조회 키이자 `content_hash` 컬럼 값. */
  contentHash: string;
  /**
   * 창 기반 중복 판정을 적용해야 하는 경우의 조회 하한. `derived_window`에서만 값이
   * 있고 나머지 경로는 null이다 — 호출자가 시간 축을 이미 줬는데 서버가 창을 덧씌우면
   * 서로 다른 시각의 결제가 뭉친다.
   */
  windowLowerBound: Date | null;
}

/**
 * 세 갈래 사다리로 멱등 키를 결정한다. 어느 갈래를 탔는지(`keySource`)를 함께 돌려주는
 * 것이 이 함수의 핵심이다 — 그 값이 없으면 "언제 키를 필수화해도 되는가"를 영원히
 * 판단할 수 없다.
 */
export function resolveCardSmsIdempotency(
  input: CardSmsIdempotencyInput,
): CardSmsIdempotency {
  const contentHash = cardSmsContentHash(input.sender, input.content);

  const clientKey = (input.eventId ?? '').trim();
  if (clientKey) {
    return {
      eventId: clientKey,
      keySource: 'client',
      contentHash,
      windowLowerBound: null,
    };
  }

  // 계약상의 receivedAt이 우선. 없으면 text 경로의 자유 형식 태그를 쓴다 — 둘 다
  // "호출자가 준 시간 축"이라는 점에서 같은 등급이고, 해시 재료로서 차이가 없다.
  const clientTime = (input.receivedAt ?? '').trim() || (input.receivedAtTag ?? '').trim();
  if (clientTime) {
    return {
      eventId: deriveCardSmsEventId(input.sender, input.content, clientTime),
      keySource: 'derived_received_at',
      contentHash,
      windowLowerBound: null,
    };
  }

  // 시간 축이 전혀 없는 경로 — 여기만 창을 씌운다.
  // `w:` 접두사는 창 시작점과 클라이언트가 준 ISO 시각이 같은 문자열이 되어도 두 경로의
  // 키가 겹치지 않게 한다(다른 의미의 값은 다른 키여야 한다).
  const windowStart = cardSmsDedupeWindowStart(input.ingestedAt);
  return {
    eventId: deriveCardSmsEventId(
      input.sender,
      input.content,
      `w:${windowStart.toISOString()}`,
    ),
    keySource: 'derived_window',
    contentHash,
    windowLowerBound: cardSmsDedupeWindowLowerBound(input.ingestedAt),
  };
}

/**
 * 중복으로 판정해 저장하지 않은 이유. `card_sms_ingest_suppressions.reason`에 저장된다.
 *
 * - `event_id_conflict` — 같은 `(device, event_id)` 행이 이미 있다(정상 멱등).
 * - `fingerprint_window` — 키는 새로 파생됐지만 창 안에 같은 지문의 행이 있다
 *   (창 경계를 사이에 둔 재시도). **오판 가능성이 가장 큰 값이다** — 이 값이 많으면
 *   창이 너무 넓다는 뜻이다.
 * - `insert_race` — 동시 요청이 UNIQUE 경합에서 졌다.
 */
export const CARD_SMS_SUPPRESSION_REASONS = [
  'event_id_conflict',
  'fingerprint_window',
  'insert_race',
] as const;
export type CardSmsSuppressionReason = (typeof CARD_SMS_SUPPRESSION_REASONS)[number];
