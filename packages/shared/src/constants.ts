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
 *   Slack threads/messages after a full import, or rebuild one affected
 *   message/thread after a create/edit/delete event.
 * - `source-tombstone`: 원본 삭제 요청을 소비해 object storage와 파생 projection을
 *   멱등 정리하는 privacy propagation queue.
 * - `memory-extract`: Phase 8 long-term memory extraction queue — RAG가 발행한
 *   chunk revision 단위 증분 잡을 기본으로 소비하고, API의 workspace rebuild를
 *   복구·backfill 경로로 유지한다.
 * - `graph-extract`: Phase 9 temporal-graph extraction queue — RAG가 발행한
 *   chunk revision 단위 증분 잡을 기본으로 소비하고, API의 workspace rebuild를
 *   복구·backfill 경로로 유지한다.
 * - `category-suggest`: LLM merchant-category suggestion queue — the worker
 *   promotion pipeline enqueues one job per unclassified merchant
 *   (jobId `catsug_${householdId}_${md5(merchantNormalized)}`, no colons),
 *   the worker consumes it, asks the LLM for a category slug and self-learns
 *   via `merchant_category_rules`. LLM failure/invalid output falls back to
 *   leaving the transaction unclassified (deterministic fallback, mock-safe).
 */
export const QUEUE_NAMES = {
  TEST: 'test',
  CARD_SMS_PARSE: 'card-sms-parse',
  SLACK_IMPORT: 'slack-import',
  RAG_INDEX: 'rag-index',
  SOURCE_TOMBSTONE: 'source-tombstone',
  MEMORY_EXTRACT: 'memory-extract',
  GRAPH_EXTRACT: 'graph-extract',
  CATEGORY_SUGGEST: 'category-suggest',
  // 거래 승격 완료 시 푸시 알림을 발송하는 큐(promotion=생산자, worker=소비자).
  NOTIFICATION_DISPATCH: 'notification-dispatch',
} as const;

/** offline 평가와 serving alias가 공유하는 안정적인 model task 식별자. */
export const MODEL_SERVING_TASKS = {
  RAG_EMBEDDING: 'rag-embedding',
  RAG_RERANKER: 'rag-reranker',
  RAG_ANSWER: 'rag-answer',
  MERCHANT_CATEGORY: 'merchant-category',
} as const;

/** 운영 제어 평면의 기본 named alias. */
export const DEFAULT_MODEL_SERVING_ALIAS = 'production';

/** 가맹점 분류 모델 artifact와 Training Runner가 공유하는 구현 버전. */
export const MERCHANT_CLASSIFIER_TRAINER_VERSION =
  'merchant-char-ngram-nb-v1';

/** 가맹점 분류 모델의 라벨 수집·학습 진입 공용 기준. */
export const MERCHANT_TRAINING_READINESS = {
  minimumLabels: 100,
  minimumClasses: 3,
  minimumLabelsPerClass: 10,
} as const;

/**
 * BullMQ 큐 공용 기본 잡 옵션(api producer + worker 공용).
 *
 * BullMQ 기본값(attempts=1, maxStalledCount=1)에서는 장시간 잡(slack-import,
 * rag-index 등)이 워커 재시작에 두 번 걸리면 재시도 없이 영구 failed가 된다 —
 * dev에서는 파일 저장→nodemon 재시작(3초 강제 종료)만으로 재현된다. 모든 잡
 * 처리(파싱/승격/인덱싱/추출)는 upsert·onConflict 기반 멱등이므로 재시도가
 * 안전하다. registerQueue의 defaultJobOptions로 전달해 add() 호출별 지정 없이
 * 일괄 적용한다. (plain object — @nestjs/bullmq의 JobsOptions와 구조 호환.)
 */
export const QUEUE_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
} as const;
