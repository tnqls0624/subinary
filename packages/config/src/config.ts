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
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return value;
}, z.boolean());

/** TCP port: coerced from string, integer within the valid port range. */
const portFromEnv = z.coerce.number().int().min(1).max(65535);

/**
 * Application configuration schema (grouped).
 *
 * Groups: `app` / `database` / `redis` / `queue` / `storage` / `ai` / `auth` / `device` / `web`.
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
  ai: z.object({
    provider: z.enum(['mock', 'openai', 'anthropic', 'google']).default('mock'),
  }),
  auth: z.object({
    accessSecret: z.string().min(16),
    accessTtlSec: z.coerce.number().int().positive().default(900),
    refreshTtlSec: z.coerce.number().int().positive().default(2592000),
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
    },
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtlSec: env.JWT_ACCESS_TTL_SEC,
      refreshTtlSec: env.JWT_REFRESH_TTL_SEC,
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
 * (`app`, `database`, `redis`, `queue`, `storage`, `ai`, `auth`, `device`, `web`) a root key of the
 * config store, so it can be read as
 * `configService.get<AppConfig['database']>('database')`.
 */
export function loadConfig(): AppConfig {
  return validateEnv(process.env);
}
