/**
 * 실시간 무효화 힌트 채널 규약 (worker publisher ↔ api SSE bridge 공유).
 *
 * 워커가 거래 승격/파싱 완료 시 Redis pub/sub로 가족(household) 채널에 힌트를
 * 발행하고, API가 psubscribe로 받아 SSE로 클라이언트에 중계한다. 클라이언트는
 * 페이로드를 신뢰하지 않고 "무효화 신호"로만 쓴다 — 따라서 유실 허용(at-most-once,
 * 재생 불가)이며 금액·가맹점 등 PII는 절대 싣지 않는다(식별자·타입만).
 */

/** 채널 프리픽스. BullMQ의 `fma:` 네임스페이스와 구분되는 `fma:rt:`를 쓴다. */
export const REALTIME_CHANNEL_PREFIX = 'fma:rt:household:';

/** psubscribe 패턴 (API 측 단일 구독). */
export const REALTIME_CHANNEL_PATTERN = `${REALTIME_CHANNEL_PREFIX}*`;

/** householdId → 발행/구독 채널명. */
export function realtimeChannel(householdId: string): string {
  return `${REALTIME_CHANNEL_PREFIX}${householdId}`;
}

/** 채널명 → householdId (패턴 불일치 시 null). */
export function householdIdFromChannel(channel: string): string | null {
  if (!channel.startsWith(REALTIME_CHANNEL_PREFIX)) return null;
  const id = channel.slice(REALTIME_CHANNEL_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** 실시간 이벤트 타입. 클라이언트는 종류별 무효화 범위 판단에만 쓴다. */
export type RealtimeEventType =
  | 'transactions.changed'
  | 'categories.changed';

/** 발행 페이로드(JSON). PII 금지 — 타입/버전만. */
export interface RealtimeEvent {
  type: RealtimeEventType;
  v: 1;
}
