import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { configSchema } from '@family/config';
import { housingBrandSyncErrorSchema, type HousingBrandSyncError } from '@family/contracts';
import { parseSujainRows, type SujainRawRow } from './sujain-parse';

export class SujainBrowserError extends Error {
  constructor(
    readonly code: HousingBrandSyncError,
    /** Fixed allowlisted runner reason only — never credentials or raw stderr. */
    readonly reason: string | null = null,
  ) {
    super('Sujain read did not complete');
  }
}

export type SujainCredentials = { loginId: string; password: string };

/** Allowlisted runner/client reasons only — never credentials, URLs with secrets, or raw stderr. */
const failureReasonSchema = z.enum([
  'chromium_launch_failed',
  'response_validation_failed',
  'response_too_large',
  'parent_deadline',
  'stdin_error',
  'playwright_timeout',
  'runner_exception',
  'runner_exit_nonzero',
]);

/** Letters-only capped error.name from the runner — never message/stack. */
const runnerErrorNameSchema = z.string().regex(/^[A-Za-z]{1,40}$/u);

/** Allowlisted runner stage tokens — never URLs or page path text. */
const runnerStageSchema = z.enum([
  'stdin',
  'validate',
  'import',
  'launch',
  'context',
  'login',
  'scrape_payment',
  'scrape_unit_items',
]);

type RunnerFailurePayload = {
  error: HousingBrandSyncError;
  reason?: z.infer<typeof failureReasonSchema>;
  errorName?: z.infer<typeof runnerErrorNameSchema>;
  stage?: z.infer<typeof runnerStageSchema>;
};

/** Match tools/sujain-web-runner collect.mjs caps and responseSchema below. */
export const SUJAIN_CELL_MAX = 200;
export const SUJAIN_HEADER_MAX = 100;
/** Must fit schema-max JSON after cell/header truncation (100×20×200 + headers). */
export const SUJAIN_STDOUT_MAX_BYTES = 1_048_576;

const rowSchema = z.object({
  cells: z.array(z.string().max(SUJAIN_CELL_MAX)).max(20),
  headers: z.array(z.string().max(SUJAIN_HEADER_MAX)).max(20).optional(),
  sourcePage: z.enum(['payment', 'unit-items']),
}).strict();

const responseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    capturedAt: z.string().datetime({ offset: true }),
    rows: z.array(rowSchema).max(100),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: housingBrandSyncErrorSchema,
    reason: failureReasonSchema.optional(),
    errorName: runnerErrorNameSchema.optional(),
    stage: runnerStageSchema.optional(),
  }).strict(),
]);

function clipText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clipped = value.replace(/\s+/gu, ' ').trim();
  return clipped.length <= max ? clipped : clipped.slice(0, max);
}

/**
 * Coerce runner ok:true rows to schema caps. Truncates overlong strings;
 * returns null when the shape cannot be salvaged without inventing data.
 */
export function coerceSujainRunnerRows(rows: unknown): SujainRawRow[] | null {
  if (!Array.isArray(rows)) return null;
  const out: SujainRawRow[] = [];
  for (const row of rows.slice(0, 100)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    if (record.sourcePage !== 'payment' && record.sourcePage !== 'unit-items') return null;
    if (!Array.isArray(record.cells)) return null;
    const cells: string[] = [];
    for (const cell of record.cells.slice(0, 20)) {
      const clipped = clipText(cell, SUJAIN_CELL_MAX);
      if (clipped === null) return null;
      cells.push(clipped);
    }
    let headers: string[] | undefined;
    if (record.headers !== undefined) {
      if (!Array.isArray(record.headers)) return null;
      headers = [];
      for (const header of record.headers.slice(0, 20)) {
        const clipped = clipText(header, SUJAIN_HEADER_MAX);
        if (clipped === null) return null;
        headers.push(clipped);
      }
    }
    out.push({ cells, headers, sourcePage: record.sourcePage });
  }
  return out;
}

const STDERR_KEEP = /sandbox|no-sandbox|chromium|chrome|playwright|headless|zygote|executable|permission denied|cannot open|\berror\b/i;

/** Keep only short Chromium/Playwright launch signals. Never persist raw stderr. */
export function sanitizeSujainRunnerStderr(raw: string, credentials?: SujainCredentials): string {
  let text = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  if (credentials?.loginId) text = text.split(credentials.loginId).join('[redacted]');
  if (credentials?.password) text = text.split(credentials.password).join('[redacted]');
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && STDERR_KEEP.test(line))
    .join(' | ')
    .slice(0, 240);
}

export function classifySujainRunnerFailure(
  exitCode: number | null,
  payload: RunnerFailurePayload | null,
  stderr: string,
): {
  code: HousingBrandSyncError;
  reason: string | null;
  errorName: string | null;
  stage: string | null;
} {
  if (payload) {
    return {
      code: payload.error,
      reason: payload.reason ?? null,
      errorName: payload.errorName ?? null,
      stage: payload.stage ?? null,
    };
  }
  if (/Running as root without --no-sandbox|No usable sandbox|chromium.?sandbox/i.test(stderr)) {
    return {
      code: 'runtime_unavailable',
      reason: 'chromium_launch_failed',
      errorName: null,
      stage: null,
    };
  }
  if (exitCode !== 0) {
    return {
      code: 'operation_unknown',
      reason: 'runner_exit_nonzero',
      errorName: null,
      stage: null,
    };
  }
  return {
    code: 'operation_unknown',
    reason: 'response_validation_failed',
    errorName: null,
    stage: null,
  };
}

/** Build warn line fragments from allowlisted tokens only. */
export function formatSujainRunnerWarnExtras(
  errorName: string | null | undefined,
  stage: string | null | undefined,
): string {
  const parts: string[] = [];
  if (typeof errorName === 'string' && runnerErrorNameSchema.safeParse(errorName).success) {
    parts.push(`errorName=${errorName}`);
  }
  if (typeof stage === 'string' && runnerStageSchema.safeParse(stage).success) {
    parts.push(`stage=${stage}`);
  }
  return parts.join(' ');
}

/**
 * 수자인 전용 브라우저 자식. 신한 bank-web-runner와 경로·공급자를 섞지 않는다.
 * 자격증명은 stdin JSON으로만 넘기고 argv/env/로그에 평문을 두지 않는다.
 */
@Injectable()
export class SujainBrowserClient {
  readonly configured: boolean;
  readonly available: boolean;
  readonly #logger = new Logger(SujainBrowserClient.name);
  #runner: string;
  #executable: string;
  #active = false;

  constructor(config: ConfigService) {
    const parsed = configSchema.shape.sujainWebConnections.safeParse(config.get('sujainWebConnections'));
    if (!parsed.success) throw new Error('Sujain browser configuration unavailable');
    this.configured = parsed.data.enabled;
    this.#runner = resolve(parsed.data.runnerPath ?? join(process.cwd(), 'tools/sujain-web-runner/run.mjs'));
    this.#executable = parsed.data.browserExecutable ?? '';
    let runtimePresent = false;
    if (this.configured && isAbsolute(this.#executable) && existsSync(this.#runner) && existsSync(this.#executable)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dirname(this.#runner), 'node_modules/playwright-core/package.json'), 'utf8')) as { name?: string; version?: string };
        runtimePresent = pkg.name === 'playwright-core' && pkg.version === '1.62.0';
      } catch { /* Missing runtime is a capability, never a request for credentials. */ }
    }
    this.available = this.configured && runtimePresent;
  }

  /** 테스트·합성용. 브라우저 없이 표 행만 해석한다. */
  parseRows(rows: SujainRawRow[]) {
    return parseSujainRows(rows);
  }

  async read(credentials: SujainCredentials, signal: AbortSignal): Promise<{
    capturedAt: string;
    rows: SujainRawRow[];
  }> {
    if (!this.available || signal.aborted || this.#active) throw new SujainBrowserError('runtime_unavailable');
    return new Promise((resolveResult, rejectResult) => {
      let output = '';
      let stderr = '';
      let bytes = 0;
      let errBytes = 0;
      let settled = false;
      const child = spawn(process.execPath, [this.#runner], {
        cwd: dirname(this.#runner),
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          TZ: 'Asia/Seoul',
          SUJAIN_WEB_BROWSER_EXECUTABLE: this.#executable,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.#active = true;
      const finish = (
        error?: HousingBrandSyncError,
        payload?: { capturedAt: string; rows: SujainRawRow[] },
        reason: string | null = null,
        extras: { errorName?: string | null; stage?: string | null } = {},
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        const diagnostic = sanitizeSujainRunnerStderr(stderr, credentials);
        output = '';
        stderr = '';
        if (error || !payload) {
          const extrasText = formatSujainRunnerWarnExtras(extras.errorName, extras.stage);
          const base = `sujain runner failed code=${error ?? 'operation_unknown'} reason=${reason ?? 'none'}`;
          const withExtras = extrasText ? `${base} ${extrasText}` : base;
          if (diagnostic) {
            this.#logger.warn(`${withExtras} detail=${diagnostic}`);
          } else if (reason || extrasText) {
            this.#logger.warn(withExtras);
          }
          rejectResult(new SujainBrowserError(error ?? 'operation_unknown', reason));
        } else resolveResult(payload);
      };
      const stop = () => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM');
          const hard = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
          hard.unref();
        }
      };
      const abort = () => { stop(); finish('operation_unknown', undefined, 'parent_deadline'); };
      const timer = setTimeout(abort, 60_000);
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', () => { this.#active = false; finish('runtime_unavailable'); });
      child.stdin.on('error', () => { stop(); finish('operation_unknown', undefined, 'stdin_error'); });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > SUJAIN_STDOUT_MAX_BYTES) {
          stop();
          finish('operation_unknown', undefined, 'response_too_large');
          return;
        }
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errBytes += chunk.byteLength;
        if (errBytes > 8_192) return;
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code) => {
        this.#active = false;
        if (settled) return;
        let payload: RunnerFailurePayload | null = null;
        let success: { capturedAt: string; rows: SujainRawRow[] } | undefined;
        if (code === 0) {
          try {
            const raw: unknown = JSON.parse(output);
            const parsed = responseSchema.safeParse(raw);
            if (parsed.success) {
              if (parsed.data.ok) success = { capturedAt: parsed.data.capturedAt, rows: parsed.data.rows };
              else {
                payload = {
                  error: parsed.data.error,
                  ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
                  ...(parsed.data.errorName ? { errorName: parsed.data.errorName } : {}),
                  ...(parsed.data.stage ? { stage: parsed.data.stage } : {}),
                };
              }
            } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
              const record = raw as Record<string, unknown>;
              if (record.ok === true && typeof record.capturedAt === 'string') {
                const coerced = coerceSujainRunnerRows(record.rows);
                const again = coerced
                  ? responseSchema.safeParse({
                    ok: true,
                    capturedAt: record.capturedAt,
                    rows: coerced,
                  })
                  : null;
                if (again?.success && again.data.ok) {
                  success = { capturedAt: again.data.capturedAt, rows: again.data.rows };
                } else {
                  payload = { error: 'operation_unknown', reason: 'response_validation_failed' };
                }
              } else if (record.ok === false) {
                const errorParsed = housingBrandSyncErrorSchema.safeParse(record.error);
                if (errorParsed.success) {
                  const reasonParsed = failureReasonSchema.safeParse(record.reason);
                  const errorNameParsed = runnerErrorNameSchema.safeParse(record.errorName);
                  const stageParsed = runnerStageSchema.safeParse(record.stage);
                  payload = {
                    error: errorParsed.data,
                    ...(reasonParsed.success ? { reason: reasonParsed.data } : {}),
                    ...(errorNameParsed.success ? { errorName: errorNameParsed.data } : {}),
                    ...(stageParsed.success ? { stage: stageParsed.data } : {}),
                  };
                } else {
                  payload = { error: 'operation_unknown', reason: 'response_validation_failed' };
                }
              } else {
                payload = { error: 'operation_unknown', reason: 'response_validation_failed' };
              }
            } else {
              payload = { error: 'operation_unknown', reason: 'response_validation_failed' };
            }
          } catch {
            payload = { error: 'operation_unknown', reason: 'response_validation_failed' };
          }
        }
        if (success) { finish(undefined, success); return; }
        const failure = classifySujainRunnerFailure(code, payload, stderr);
        finish(failure.code, undefined, failure.reason, {
          errorName: failure.errorName,
          stage: failure.stage,
        });
      });
      child.stdin.end(JSON.stringify({
        provider: 'sujain',
        credentials: { loginId: credentials.loginId, password: credentials.password },
      }));
      if (signal.aborted) abort();
    });
  }
}
