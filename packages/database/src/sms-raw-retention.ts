/**
 * 문자 원문 보존 정책(SOO-34 / P1-8) — 어떤 원문을 지울지 고르는 순수 규칙.
 *
 * DB·객체 저장소를 건드리지 않는다. API 미리보기와 worker purge가 **같은 함수**를
 * 써야 "미리 본 건수"와 "실제로 지운 건수"가 어긋나지 않는다.
 *
 * 기준 시각은 수집 경로가 이미 쓰는 `received_at`(이벤트) / `first_seen_at`(억제 행)이다.
 * 새 시계를 만들지 않는다.
 */
export const SMS_RETENTION_POLICIES = [
  'none',
  'days_30',
  'after_parse',
  'failures_only',
] as const;

export type SmsRetentionPolicy = (typeof SMS_RETENTION_POLICIES)[number];

/** `days_30`이 쓰는 보관 일수. 수신 시각 기준. */
export const SMS_RETENTION_DAYS_30 = 30;

/** 카드 문자 파싱 상태 — schema `card_sms_parse_status`와 같아야 한다. */
export type CardSmsParseStatus =
  | 'pending'
  | 'parsed'
  | 'parse_failed'
  | 'pending_review'
  | 'quarantined'
  | 'ignored';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 원문이 아직 남아 있는가. purge는 빈 문자열로 지운 자리를 표시한다. */
export function hasSmsRawCopy(rawContent: string): boolean {
  return rawContent.length > 0;
}

/**
 * 이벤트 원문이 지금 정책에 걸려 지워져야 하는가.
 *
 * - `none`: 절대 안 지움
 * - `days_30`: 수신 시각이 30일보다 오래됨
 * - `after_parse`: 파싱 성공(`parsed`)만
 * - `failures_only`: 실패(`parse_failed`)와 아직 끝나지 않은 상태만 남기고,
 *   끝난 성공(`parsed`)·비거래로 확정(`ignored`) 원문은 지움
 */
export function eventRawMatchesRetention(input: {
  policy: SmsRetentionPolicy;
  rawContent: string;
  parseStatus: CardSmsParseStatus;
  receivedAt: Date;
  now: Date;
}): boolean {
  if (input.policy === 'none') return false;
  if (!hasSmsRawCopy(input.rawContent)) return false;

  switch (input.policy) {
    case 'days_30':
      return (
        input.now.getTime() - input.receivedAt.getTime() >=
        SMS_RETENTION_DAYS_30 * MS_PER_DAY
      );
    case 'after_parse':
      return input.parseStatus === 'parsed';
    case 'failures_only':
      return (
        input.parseStatus === 'parsed' || input.parseStatus === 'ignored'
      );
    default: {
      const _exhaustive: never = input.policy;
      return _exhaustive;
    }
  }
}

/**
 * 중복 억제 행의 원문.
 *
 * - `days_30`: `first_seen_at` 기준 30일
 * - `after_parse` / `failures_only`: 짝이 된 이벤트가 있으면 **그 이벤트와 같은
 *   판정**을 쓴다. 짝이 없으면(경합 등으로 matched_event_id가 null) 상태를 알 수
 *   없으니 지우지 않는다 — 지키지 못할 삭제를 하지 않는다.
 */
export function suppressionRawMatchesRetention(input: {
  policy: SmsRetentionPolicy;
  rawContent: string;
  firstSeenAt: Date;
  now: Date;
  matchedEvent?: {
    rawContent: string;
    parseStatus: CardSmsParseStatus;
    receivedAt: Date;
  } | null;
}): boolean {
  if (input.policy === 'none') return false;
  if (!hasSmsRawCopy(input.rawContent)) return false;

  switch (input.policy) {
    case 'days_30':
      return (
        input.now.getTime() - input.firstSeenAt.getTime() >=
        SMS_RETENTION_DAYS_30 * MS_PER_DAY
      );
    case 'after_parse':
    case 'failures_only': {
      const matched = input.matchedEvent;
      if (!matched) return false;
      return eventRawMatchesRetention({
        policy: input.policy,
        rawContent: matched.rawContent.length > 0 ? matched.rawContent : 'x',
        parseStatus: matched.parseStatus,
        receivedAt: matched.receivedAt,
        now: input.now,
      });
    }
    default: {
      const _exhaustive: never = input.policy;
      return _exhaustive;
    }
  }
}

/** 화면·미리보기에 쓰는 정책별 한 줄 설명(서비스가 실제로 하는 일만). */
export function retentionPolicyEffectSummary(
  policy: SmsRetentionPolicy,
): string {
  switch (policy) {
    case 'none':
      return '자동으로 원문을 지우지 않아요.';
    case 'days_30':
      return '받은 지 30일이 지난 문자 원문을 지워요. 기준은 수신 시각이에요.';
    case 'after_parse':
      return '파싱에 성공한 문자의 원문을 지워요. 거래·금액은 남아요.';
    case 'failures_only':
      return '실패한 문자와 아직 처리 중인 문자의 원문만 남기고, 성공·비거래로 끝난 원문은 지워요.';
    default: {
      const _exhaustive: never = policy;
      return _exhaustive;
    }
  }
}
