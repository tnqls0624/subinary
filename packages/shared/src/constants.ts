/** Default project timezone. All user-facing times are rendered in this zone. */
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

/**
 * BullMQ queue names shared between the api (producer) and worker (consumer).
 * - `test`: Phase 0 end-to-end smoke queue.
 * - `card-sms-parse`: Phase 3 asynchronous card-SMS parsing queue
 *   (api enqueues, worker consumes).
 */
export const QUEUE_NAMES = {
  TEST: 'test',
  CARD_SMS_PARSE: 'card-sms-parse',
} as const;
