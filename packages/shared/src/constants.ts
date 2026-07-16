/** Default project timezone. All user-facing times are rendered in this zone. */
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

/**
 * BullMQ queue names shared between the api (producer) and worker (consumer).
 * - `test`: Phase 0 end-to-end smoke queue.
 * - `card-sms-parse`: Phase 3 asynchronous card-SMS parsing queue
 *   (api enqueues, worker consumes).
 * - `slack-import`: Phase 6 asynchronous Slack export parsing queue
 *   (api enqueues, worker consumes).
 * - `rag-index`: Phase 7 RAG indexing queue — chunk + embed a workspace's
 *   Slack threads/messages (worker enqueues after a successful import,
 *   worker consumes; jobId keyed by workspace to collapse re-enqueues).
 * - `memory-extract`: Phase 8 long-term memory extraction queue — rule-based
 *   extraction of memory candidates from a workspace's chunks (api enqueues,
 *   worker consumes; jobId keyed by workspace to collapse re-enqueues).
 */
export const QUEUE_NAMES = {
  TEST: 'test',
  CARD_SMS_PARSE: 'card-sms-parse',
  SLACK_IMPORT: 'slack-import',
  RAG_INDEX: 'rag-index',
  MEMORY_EXTRACT: 'memory-extract',
} as const;
