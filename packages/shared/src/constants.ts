/** Default project timezone. All user-facing times are rendered in this zone. */
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

/**
 * BullMQ queue names shared between the api (producer) and worker (consumer).
 * Phase 0 only ships the end-to-end `test` queue.
 */
export const QUEUE_NAMES = { TEST: 'test' } as const;
