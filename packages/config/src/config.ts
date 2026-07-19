import { z } from 'zod';

/**
 * Boolean coercion tailored for environment variables.
 *
 * `z.coerce.boolean()` treats every non-empty string (including "false") as
 * `true`, which is dangerous for flags such as `STORAGE_FORCE_PATH_STYLE`.
 * This preprocessor parses the common truthy/falsy spellings explicitly and
 * lets `z.boolean()` report a clear type error for anything else.
 */
const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'true' ||
      normalized === '1' ||
      normalized === 'yes' ||
      normalized === 'on'
    ) {
      return true;
    }
    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'no' ||
      normalized === 'off'
    ) {
      return false;
    }
  }
  return value;
}, z.boolean());

/** TCP port: coerced from string, integer within the valid port range. */
const portFromEnv = z.coerce.number().int().min(1).max(65535);

/** 선택 env의 빈 문자열은 미설정으로 정규화한다(`env_file`의 `KEY=` 대응). */
function optionalEnvValue(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * Application configuration schema (grouped).
 *
 * Groups: `app` / `database` / `redis` / `queue` / `storage` / `ai` /
 * `observability` / `auth` / `device` / `web`.
 * Numbers and booleans are coerced from environment variable strings.
 */
export const configSchema = z.object({
  app: z.object({
    nodeEnv: z.enum(['development', 'test', 'production']),
    tz: z.string().min(1).default('Asia/Seoul'),
    apiPort: portFromEnv,
    workerPort: portFromEnv,
    webPort: portFromEnv,
  }),
  database: z.object({
    url: z.string().min(1),
  }),
  redis: z.object({
    host: z.string().min(1),
    port: portFromEnv,
  }),
  queue: z.object({
    prefix: z.string().min(1),
  }),
  storage: z.object({
    endpoint: z.string().min(1),
    region: z.string().min(1),
    accessKey: z.string().min(1),
    secretKey: z.string().min(1),
    bucket: z.string().min(1),
    forcePathStyle: booleanFromEnv,
  }),
  ai: z
    .object({
      provider: z
        .enum(['mock', 'openai', 'anthropic', 'google', 'gemini'])
        .default('mock'),
      /** Gemini API 키 (provider=gemini일 때 필요; 없으면 provider가 Mock 폴백). */
      geminiApiKey: z.string().min(1).optional(),
      /** LLM 모델명 override (선택, 예: gemini-2.0-flash). */
      llmModel: z.string().min(1).optional(),
      /** 임베딩 provider 모델명 override. */
      embeddingModel: z.string().min(1).optional(),
      /** immutable embedding version에 기록할 모델 revision. */
      embeddingModelRevision: z.string().min(1).optional(),
      /** traffic/shadow 후보 LLM provider. 세 후보 identity 필드는 함께 설정한다. */
      candidateProvider: z
        .enum(['mock', 'openai', 'anthropic', 'google', 'gemini'])
        .optional(),
      /** traffic/shadow 후보 LLM 모델명. */
      candidateLlmModel: z.string().min(1).optional(),
      /** registry identity와 대조할 후보 LLM immutable revision. */
      candidateLlmModelRevision: z.string().min(1).optional(),
      /** 후보가 별도 credential을 사용할 때의 Gemini API 키. */
      candidateGeminiApiKey: z.string().min(1).optional(),
      /** true이면 scope/task production alias가 없을 때 AI 호출을 차단한다. */
      modelAliasRequired: booleanFromEnv.optional(),
      /** true이면 API 제어 평면이 monitoring canary를 주기적으로 판정한다. */
      modelCanaryMonitorEnabled: booleanFromEnv.default(false),
      /** canary monitor polling 주기(ms). */
      modelCanaryMonitorIntervalMs: z.coerce
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .default(30_000),
      /** 한 poll에서 평가할 canary 최대 개수. */
      modelCanaryMonitorBatchSize: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50),
    })
    .superRefine((value, context) => {
      const identityFields = [
        value.candidateProvider,
        value.candidateLlmModel,
        value.candidateLlmModelRevision,
      ];
      const configuredCount = identityFields.filter(
        (field) => field !== undefined,
      ).length;
      if (configuredCount !== 0 && configuredCount !== identityFields.length) {
        context.addIssue({
          code: 'custom',
          path: ['candidateProvider'],
          message:
            'candidateProvider, candidateLlmModel, and candidateLlmModelRevision must be configured together',
        });
      }
    }),
  observability: z.object({
    /** 미설정이면 알림은 DB outbox에 쌓고 외부 발송만 비활성화한다. */
    alertWebhookUrl: z.url().optional(),
    alertWebhookBearerToken: z.string().min(1).optional(),
    alertWebhookFormat: z.enum(['generic', 'slack']).default('generic'),
    alertPollIntervalMs: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    alertBatchSize: z.coerce.number().int().min(1).max(100).default(20),
    alertRequestTimeoutMs: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(30_000)
      .default(5_000),
    alertMaxAttempts: z.coerce.number().int().min(1).max(20).default(8),
  }),
  auth: z.object({
    accessSecret: z.string().min(16),
    accessTtlSec: z.coerce.number().int().positive().default(900),
    refreshTtlSec: z.coerce.number().int().positive().default(2592000),
    // 모바일(Capacitor) 자동로그인 세션 TTL — 기본 1년. 웹(쿠키)은 위 30일 유지.
    refreshTtlMobileSec: z.coerce
      .number()
      .int()
      .positive()
      .default(31536000),
  }),
  device: z.object({
    secretEncKey: z.string().regex(/^[0-9a-fA-F]{64}$/),
    hmacTimestampToleranceSec: z.coerce.number().int().positive().default(300),
    nonceTtlSec: z.coerce.number().int().positive().default(600),
    maxBodyBytes: z.coerce.number().int().positive().default(16384),
  }),
  web: z.object({
    corsOrigin: z.string().min(1).default('http://localhost:3000'),
  }),
  notifications: z.object({
    /**
     * FCM 서비스 계정. 세 값이 모두 있으면 푸시가 활성화되고, 하나라도 없으면
     * no-op(발송 스킵)로 동작한다 — dev/mock에서 안전(AI provider 패턴과 동일).
     * privateKey는 env에서 `\n` 이스케이프로 들어오므로 로더가 실제 개행으로 복원.
     */
    fcmProjectId: z.string().min(1).optional(),
    fcmClientEmail: z.string().min(1).optional(),
    fcmPrivateKey: z.string().min(1).optional(),
  }),
});

/** Inferred application configuration type. */
export type AppConfig = z.infer<typeof configSchema>;

/**
 * Parse and validate raw environment variables into an {@link AppConfig}.
 *
 * Maps flat env var names to the grouped config structure, coercing numbers
 * and booleans. Throws an `Error` listing every offending path when
 * validation fails. Secret values are never included in the error message —
 * only paths and zod issue messages.
 */
export function validateEnv(env: NodeJS.ProcessEnv): AppConfig {
  const candidate = {
    app: {
      nodeEnv: env.NODE_ENV,
      tz: env.TZ,
      apiPort: env.API_PORT,
      workerPort: env.WORKER_PORT,
      webPort: env.WEB_PORT,
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    queue: {
      prefix: env.BULLMQ_PREFIX,
    },
    storage: {
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      accessKey: env.STORAGE_ACCESS_KEY,
      secretKey: env.STORAGE_SECRET_KEY,
      bucket: env.STORAGE_BUCKET,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    },
    ai: {
      provider: env.AI_PROVIDER,
      geminiApiKey: env.GEMINI_API_KEY,
      llmModel: env.GEMINI_MODEL,
      embeddingModel: env.AI_EMBEDDING_MODEL,
      embeddingModelRevision: env.AI_EMBEDDING_MODEL_REVISION,
      candidateProvider: env.AI_CANDIDATE_PROVIDER,
      candidateLlmModel: env.AI_CANDIDATE_LLM_MODEL,
      candidateLlmModelRevision: env.AI_CANDIDATE_LLM_MODEL_REVISION,
      candidateGeminiApiKey: env.AI_CANDIDATE_GEMINI_API_KEY,
      modelAliasRequired: env.AI_MODEL_ALIAS_REQUIRED,
      modelCanaryMonitorEnabled: env.AI_MODEL_CANARY_MONITOR_ENABLED,
      modelCanaryMonitorIntervalMs: env.AI_MODEL_CANARY_MONITOR_INTERVAL_MS,
      modelCanaryMonitorBatchSize: env.AI_MODEL_CANARY_MONITOR_BATCH_SIZE,
    },
    observability: {
      alertWebhookUrl: env.PIPELINE_ALERT_WEBHOOK_URL,
      alertWebhookBearerToken: env.PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN,
      alertWebhookFormat: env.PIPELINE_ALERT_WEBHOOK_FORMAT,
      alertPollIntervalMs: env.PIPELINE_ALERT_POLL_INTERVAL_MS,
      alertBatchSize: env.PIPELINE_ALERT_BATCH_SIZE,
      alertRequestTimeoutMs: env.PIPELINE_ALERT_REQUEST_TIMEOUT_MS,
      alertMaxAttempts: env.PIPELINE_ALERT_MAX_ATTEMPTS,
    },
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtlSec: env.JWT_ACCESS_TTL_SEC,
      refreshTtlSec: env.JWT_REFRESH_TTL_SEC,
      refreshTtlMobileSec: env.JWT_REFRESH_TTL_MOBILE_SEC,
    },
    device: {
      secretEncKey: env.DEVICE_SECRET_ENC_KEY,
      hmacTimestampToleranceSec: env.HMAC_TIMESTAMP_TOLERANCE_SEC,
      nonceTtlSec: env.DEVICE_NONCE_TTL_SEC,
      maxBodyBytes: env.MOBILE_MAX_BODY_BYTES,
    },
    web: {
      corsOrigin: env.CORS_ORIGIN,
    },
    notifications: {
      fcmProjectId: optionalEnvValue(env.FCM_PROJECT_ID),
      fcmClientEmail: optionalEnvValue(env.FCM_CLIENT_EMAIL),
      // env는 개행을 `\n` 리터럴로 담으므로 실제 개행으로 복원(PEM 파싱 위함).
      fcmPrivateKey: optionalEnvValue(env.FCM_PRIVATE_KEY)?.replace(
        /\\n/g,
        '\n',
      ),
    },
  };

  const parsed = configSchema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  return parsed.data;
}

/**
 * Load and validate configuration from `process.env`.
 *
 * NestJS usage: `ConfigModule.forRoot({ isGlobal: true, load: [loadConfig] })`
 * — passing `loadConfig` directly makes each top-level group key
 * (`app`, `database`, `redis`, `queue`, `storage`, `ai`, `observability`, `auth`, `device`, `web`) a root key of the
 * config store, so it can be read as
 * `configService.get<AppConfig['database']>('database')`.
 */
export function loadConfig(): AppConfig {
  return validateEnv(process.env);
}
