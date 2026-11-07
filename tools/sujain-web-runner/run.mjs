import {
  SujainReadError,
  allowedRequest,
  chromiumSandboxEnabled,
  classifyUntypedRunnerError,
  sanitizeRunnerStage,
  validateJob,
} from './policy.mjs';
import { readSujainPages } from './collect.mjs';

let browser, context, job;
let closing = false;
/** Fixed reason codes only — never Chromium stderr, URLs with secrets, or credentials. */
let failureReason;
/** Allowlisted stage token only — never URLs or page text. */
const diagnostics = { stage: 'stdin' };
async function close() {
  if (closing) return;
  closing = true;
  try { await context?.close(); } catch { /* No diagnostic body. */ }
  try { await browser?.close(); } catch { /* No diagnostic body. */ }
}
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void close().finally(() => process.exit(0)); });
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input, 'utf8') > 8192) throw new SujainReadError('operation_unknown');
  }
  diagnostics.stage = 'validate';
  try { job = validateJob(JSON.parse(input)); } catch { throw new SujainReadError('operation_unknown'); }
  input = '';
  let chromium;
  diagnostics.stage = 'import';
  try { ({ chromium } = await import('playwright-core')); } catch { throw new SujainReadError('runtime_unavailable'); }
  const executablePath = process.env.SUJAIN_WEB_BROWSER_EXECUTABLE;
  if (!executablePath?.startsWith('/')) throw new SujainReadError('runtime_unavailable');
  diagnostics.stage = 'launch';
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: chromiumSandboxEnabled(),
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TZ: 'Asia/Seoul' },
    });
  } catch {
    failureReason = 'chromium_launch_failed';
    throw new SujainReadError('runtime_unavailable');
  }
  diagnostics.stage = 'context';
  context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
  await context.route('**/*', (route) => (allowedRequest(route.request().url()) ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const capture = await readSujainPages(page, job, diagnostics);
  process.stdout.write(JSON.stringify({ ok: true, ...capture }));
} catch (error) {
  const payload = {
    ok: false,
    error: error instanceof SujainReadError ? error.code : 'operation_unknown',
  };
  if (failureReason && payload.error === 'runtime_unavailable') {
    payload.reason = failureReason;
  } else {
    const untyped = classifyUntypedRunnerError(error);
    if (untyped) {
      payload.reason = untyped.reason;
      if (untyped.errorName) payload.errorName = untyped.errorName;
    }
  }
  const stage = sanitizeRunnerStage(diagnostics.stage);
  if (stage) payload.stage = stage;
  process.stdout.write(JSON.stringify(payload));
} finally {
  if (job?.credentials) {
    job.credentials.password = '';
    job.credentials.loginId = '';
  }
  await close();
}
