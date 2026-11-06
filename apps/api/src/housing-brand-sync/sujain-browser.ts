import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { configSchema } from '@family/config';
import { housingBrandSyncErrorSchema, type HousingBrandSyncError } from '@family/contracts';
import { parseSujainRows, type SujainRawRow } from './sujain-parse';

export class SujainBrowserError extends Error {
  constructor(readonly code: HousingBrandSyncError) {
    super('Sujain read did not complete');
  }
}

export type SujainCredentials = { loginId: string; password: string };

const responseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    capturedAt: z.string().datetime({ offset: true }),
    rows: z.array(z.object({
      cells: z.array(z.string().max(200)).max(20),
      headers: z.array(z.string().max(100)).max(20).optional(),
      sourcePage: z.enum(['payment', 'unit-items']),
    }).strict()).max(100),
  }).strict(),
  z.object({ ok: z.literal(false), error: housingBrandSyncErrorSchema }).strict(),
]);

/**
 * 수자인 전용 브라우저 자식. 신한 bank-web-runner와 경로·공급자를 섞지 않는다.
 * 자격증명은 stdin JSON으로만 넘기고 argv/env/로그에 평문을 두지 않는다.
 */
@Injectable()
export class SujainBrowserClient {
  readonly configured: boolean;
  readonly available: boolean;
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
      let bytes = 0;
      let settled = false;
      const child = spawn(process.execPath, [this.#runner], {
        cwd: dirname(this.#runner),
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          TZ: 'Asia/Seoul',
          SUJAIN_WEB_BROWSER_EXECUTABLE: this.#executable,
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      this.#active = true;
      const finish = (error?: HousingBrandSyncError, payload?: { capturedAt: string; rows: SujainRawRow[] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        output = '';
        if (error || !payload) rejectResult(new SujainBrowserError(error ?? 'operation_unknown'));
        else resolveResult(payload);
      };
      const stop = () => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM');
          const hard = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
          hard.unref();
        }
      };
      const abort = () => { stop(); finish('operation_unknown'); };
      const timer = setTimeout(abort, 60_000);
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', () => { this.#active = false; finish('runtime_unavailable'); });
      child.stdin.on('error', () => { stop(); finish('operation_unknown'); });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 65_536) { stop(); finish('operation_unknown'); return; }
        output += chunk.toString('utf8');
      });
      child.on('close', (code) => {
        this.#active = false;
        if (settled) return;
        if (code !== 0) { finish('operation_unknown'); return; }
        try {
          const parsed = responseSchema.safeParse(JSON.parse(output));
          if (!parsed.success) { finish('operation_unknown'); return; }
          if (!parsed.data.ok) { finish(parsed.data.error); return; }
          finish(undefined, { capturedAt: parsed.data.capturedAt, rows: parsed.data.rows });
        } catch { finish('operation_unknown'); }
      });
      child.stdin.end(JSON.stringify({
        provider: 'sujain',
        credentials: { loginId: credentials.loginId, password: credentials.password },
      }));
      if (signal.aborted) abort();
    });
  }
}
