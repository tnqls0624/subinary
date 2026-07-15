import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Sensitive fields that must never reach log output.
 * Covers auth headers, credentials, storage keys, signatures and raw
 * user content (privacy requirement).
 */
const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  '*.password',
  '*.secret',
  '*.accessKey',
  '*.secretKey',
  '*.signature',
  '*.content',
];

export interface CreateLoggerOptions {
  /** pino log level (default: `'info'`). */
  level?: string;
  /** Enable the pino-pretty transport for local development (default: `false`). */
  pretty?: boolean;
}

/**
 * Create a named pino logger with mandatory redaction of sensitive fields.
 *
 * In development, pass `{ pretty: true }` to route output through the
 * `pino-pretty` transport; in production the default NDJSON output is used.
 */
export function createLogger(name: string, opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const pretty = opts.pretty ?? false;

  const options: LoggerOptions = {
    name,
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };

  if (pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-MM-dd HH:mm:ss.l o',
        ignore: 'pid,hostname',
      },
    };
  }

  return pino(options);
}
