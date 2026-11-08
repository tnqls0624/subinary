import {
  ERRORS,
  SujainReadError,
  allowedRequest,
  classifyUntypedRunnerError,
  sanitizeLayoutDiagnostics,
  sanitizeRunnerStage,
  validateJob,
} from './policy.mjs';
import { readSujainPages } from './collect.mjs';
import { routeAllowlist } from './kit/allowlist.mjs';
import {
  chromiumSandboxEnabled,
  createCloser,
  installSignalCleanup,
  isAbsoluteExecutable,
  launchHeadless,
  openIsolatedContext,
} from './kit/launch.mjs';
import { buildFailurePayload, writeResult } from './kit/result.mjs';
import { readJobJson } from './kit/stdin.mjs';

let browser, context, job;
/** Fixed reason codes only — never Chromium stderr, URLs with secrets, or credentials. */
let failureReason;
/**
 * Allowlisted stage token + optional safe layout snapshots (header texts / counts only).
 * Never URLs, credentials, or data-cell values.
 */
const diagnostics = { stage: 'stdin', layout: {} };
const close = createCloser([() => context, () => browser]);
installSignalCleanup(close);
try {
  job = await readJobJson(process.stdin, {
    maxBytes: 8192,
    onError: (code) => new SujainReadError(code),
    onReadComplete: () => { diagnostics.stage = 'validate'; },
    validate: validateJob,
  });
  let chromium;
  diagnostics.stage = 'import';
  try { ({ chromium } = await import('playwright-core')); } catch { throw new SujainReadError('runtime_unavailable'); }
  const executablePath = process.env.SUJAIN_WEB_BROWSER_EXECUTABLE;
  if (!isAbsoluteExecutable(executablePath)) throw new SujainReadError('runtime_unavailable');
  diagnostics.stage = 'launch';
  try {
    browser = await launchHeadless({ chromium, executablePath, chromiumSandbox: chromiumSandboxEnabled() });
  } catch {
    failureReason = 'chromium_launch_failed';
    throw new SujainReadError('runtime_unavailable');
  }
  diagnostics.stage = 'context';
  context = await openIsolatedContext(browser);
  await routeAllowlist(context, allowedRequest);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const capture = await readSujainPages(page, job, diagnostics);
  writeResult({ ok: true, ...capture });
} catch (error) {
  // 실패 JSON 키 순서는 ok·error·reason·errorName·stage·layout 이다(API responseSchema·경고 로그가 읽는다).
  // layout 은 수자인 허용 토큰으로 거른 진단이라 키트 밖에서 맨 뒤 키로 붙인다.
  const payload = buildFailurePayload({
    error,
    code: error instanceof SujainReadError ? error.code : 'operation_unknown',
    allowedCodes: ERRORS,
    failureReason,
    stage: sanitizeRunnerStage(diagnostics.stage),
    classify: classifyUntypedRunnerError,
  });
  const layout = sanitizeLayoutDiagnostics(diagnostics.layout);
  if (layout) payload.layout = layout;
  writeResult(payload);
} finally {
  if (job?.credentials) {
    job.credentials.password = '';
    job.credentials.loginId = '';
  }
  await close();
}
