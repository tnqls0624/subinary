import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  allowedRequest,
  chromiumSandboxEnabled,
  classifyUntypedRunnerError,
  formatLayoutWarnFragment,
  isLoginUrl,
  sanitizeLayoutDiagnostics,
  sanitizeLayoutHeaderText,
  sanitizeLayoutPagePath,
  sanitizePageLayoutDiagnostic,
  sanitizeRunnerErrorName,
  sanitizeRunnerStage,
  validateJob,
  SujainReadError,
} from '../policy.mjs';

test('allows only sujain hosts', () => {
  assert.equal(allowedRequest('https://www.sujain.co.kr/mypage/payment'), true);
  assert.equal(allowedRequest('https://m.sujain.co.kr/login'), true);
  assert.equal(allowedRequest('https://bank.shinhan.com/'), false);
  assert.equal(allowedRequest('https://hoban.co.kr/'), false);
  assert.equal(allowedRequest('https://evil.example/www.sujain.co.kr'), false);
});

test('isLoginUrl treats /login/result as still in the login flow until home', () => {
  // Official success lands on /login/result with a success alert; waiters must not
  // treat that intermediate as "left login" or the race classifies the alert as extra auth.
  assert.equal(isLoginUrl('https://www.sujain.co.kr/login'), true);
  assert.equal(isLoginUrl('https://www.sujain.co.kr/login/result'), true);
  assert.equal(isLoginUrl('https://www.sujain.co.kr/index'), false);
  assert.equal(isLoginUrl('https://www.sujain.co.kr/'), false);
  assert.equal(isLoginUrl('https://www.sujain.co.kr/mypage/payment'), false);
});

test('rejects non-sujain provider and keeps secrets out of thrown messages', () => {
  assert.throws(() => validateJob({
    provider: 'shinhan_bank',
    credentials: { loginId: 'synthetic-id', password: 'SYNTHETIC_SECRET' },
  }), (error) => error instanceof SujainReadError && !String(error).includes('SYNTHETIC_SECRET'));
});

test('accepts synthetic sujain credentials shape', () => {
  const job = validateJob({
    provider: 'sujain',
    credentials: { loginId: 'synthetic.id', password: 'SYNTHETIC_SECRET' },
  });
  assert.equal(job.provider, 'sujain');
});

test('disables Chromium sandbox only when running as root (production API container)', () => {
  assert.equal(chromiumSandboxEnabled(() => 0), false);
  assert.equal(chromiumSandboxEnabled(() => 1000), true);
  assert.equal(chromiumSandboxEnabled(undefined), true);
});

test('runner turns sandbox off via policy and maps launch failure to runtime_unavailable', async () => {
  const runtime = await readFile(new URL('../run.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /chromiumSandboxEnabled\(\)/);
  assert.match(runtime, /chromium_launch_failed/);
  assert.match(runtime, /runtime_unavailable/);
  assert.doesNotMatch(runtime, /chromiumSandbox:\s*true/);
  assert.doesNotMatch(runtime, /console\.(log|error|info|debug|warn)/);
  assert.doesNotMatch(runtime, /BANK_WEB_/);
  assert.doesNotMatch(runtime, /--no-sandbox/);
});

test('sanitizeRunnerErrorName keeps letters-only capped tokens and drops message text', () => {
  const destroyed = new Error('Execution context was destroyed synthetic page text');
  destroyed.name = 'Error';
  assert.equal(sanitizeRunnerErrorName(destroyed), 'Error');

  const closed = new Error('Target page synthetic secret closed');
  closed.name = 'TargetClosedError';
  assert.equal(sanitizeRunnerErrorName(closed), 'TargetClosedError');

  const noisy = new Error('synthetic');
  noisy.name = 'Error123!@#Timeout';
  assert.equal(sanitizeRunnerErrorName(noisy), 'ErrorTimeout');

  const long = new Error('synthetic');
  long.name = `X${'a'.repeat(80)}`;
  assert.equal(sanitizeRunnerErrorName(long)?.length, 40);

  assert.equal(sanitizeRunnerErrorName(null), null);
  assert.equal(sanitizeRunnerErrorName('string-throw'), null);
  assert.equal(sanitizeRunnerErrorName({ name: '123!@#' }), null);
  // Spaces and punctuation are stripped; only A–Z / a–z remain.
  assert.equal(sanitizeRunnerErrorName({ name: 'Target Closed' }), 'TargetClosed');
});

test('sanitizeRunnerStage allowlists runner stages only', () => {
  assert.equal(sanitizeRunnerStage('login'), 'login');
  assert.equal(sanitizeRunnerStage('scrape_payment'), 'scrape_payment');
  assert.equal(sanitizeRunnerStage('scrape_unit_items'), 'scrape_unit_items');
  assert.equal(sanitizeRunnerStage('launch'), 'launch');
  assert.equal(sanitizeRunnerStage('context'), 'context');
  assert.equal(sanitizeRunnerStage('not-a-stage'), null);
  assert.equal(sanitizeRunnerStage('https://www.sujain.co.kr/login'), null);
  assert.equal(sanitizeRunnerStage(null), null);
});

test('classifyUntypedRunnerError uses error.name only — never message text', () => {
  const timeout = new Error('page.setDefaultTimeout synthetic secret Timeout 5000ms exceeded');
  timeout.name = 'TimeoutError';
  assert.deepEqual(classifyUntypedRunnerError(timeout), {
    reason: 'playwright_timeout',
    errorName: 'TimeoutError',
  });

  const destroyed = new Error('Execution context was destroyed synthetic page text');
  destroyed.name = 'Error';
  assert.deepEqual(classifyUntypedRunnerError(destroyed), {
    reason: 'runner_exception',
    errorName: 'Error',
  });

  const closed = new Error('Target closed synthetic');
  closed.name = 'TargetClosedError';
  assert.deepEqual(classifyUntypedRunnerError(closed), {
    reason: 'runner_exception',
    errorName: 'TargetClosedError',
  });

  assert.equal(classifyUntypedRunnerError(new SujainReadError('credentials_invalid')), null);
  assert.deepEqual(classifyUntypedRunnerError(null), {
    reason: 'runner_exception',
    errorName: null,
  });
  assert.deepEqual(classifyUntypedRunnerError('string-throw'), {
    reason: 'runner_exception',
    errorName: null,
  });
});

test('runner catch attaches allowlisted reason, errorName, and stage for untyped failures', async () => {
  const runtime = await readFile(new URL('../run.mjs', import.meta.url), 'utf8');
  const policy = await readFile(new URL('../policy.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /classifyUntypedRunnerError/);
  assert.match(runtime, /sanitizeRunnerErrorName|errorName/);
  assert.match(runtime, /sanitizeRunnerStage|payload\.stage/);
  assert.match(runtime, /sanitizeLayoutDiagnostics/);
  assert.match(runtime, /payload\.layout/);
  assert.match(policy, /playwright_timeout/);
  assert.match(policy, /runner_exception/);
  assert.match(policy, /error\.name/);
  assert.match(policy, /sanitizeRunnerErrorName/);
  assert.match(policy, /sanitizeRunnerStage/);
  assert.match(policy, /sanitizeLayoutDiagnostics/);
  assert.doesNotMatch(policy, /error\.message/);
  assert.doesNotMatch(runtime, /error\.message/);
  assert.doesNotMatch(runtime, /\.stack/);
});

test('layout sanitizer keeps header texts and counts, drops cell values and URL-like headers', () => {
  assert.equal(sanitizeLayoutHeaderText('항목'), '항목');
  assert.equal(sanitizeLayoutHeaderText('금액'), '금액');
  assert.equal(sanitizeLayoutHeaderText('https://evil.example/?token=1'), null);
  assert.equal(sanitizeLayoutHeaderText('path?q=1'), null);

  assert.equal(
    sanitizeLayoutPagePath('https://www.sujain.co.kr/mypage/payment?session=SECRET_TOKEN#frag'),
    'https://www.sujain.co.kr/mypage/payment',
  );
  assert.equal(sanitizeLayoutPagePath('/mypage/unit-items?x=1'), '/mypage/unit-items');
  assert.equal(sanitizeLayoutPagePath('https://user:pass@evil.example/x'), null);

  const dirty = {
    payment: {
      tableCount: 1,
      tableHeaders: [['항목', '내용']],
      rawRowCount: 2,
      eligibleRowCount: 0,
      tables: [{ rawRowCount: 2, preSkipRowCount: 3, formControlCount: 0 }],
      outsideTableFormControlCount: 2,
      outsideTableFormControls: {
        visibleInput: 1,
        visibleSelect: 1,
        visibleTextarea: 0,
        hidden: 0,
        other: 0,
        secretType: 'password',
      },
      iframeCount: 1,
      iframePaths: ['https://www.sujain.co.kr/embed?token=SECRET_IFRAME#x'],
      pagePath: 'https://www.sujain.co.kr/mypage/payment?session=SECRET_TOKEN#top',
      lookupNonPlaceholderOptionCount: 0,
      lookupClicked: false,
      lookupBodyRowsAppeared: false,
      cells: ['합성 회원', '000-0000-0000'],
      rows: [{ cells: ['이름', '합성 회원'] }],
    },
    'unit-items': {
      tableCount: 1,
      tableHeaders: [['품목', '금액'], ['https://leak.example/?id=1']],
      rawRowCount: 1,
      eligibleRowCount: 1,
      tables: [{ rawRowCount: 1, preSkipRowCount: 2, formControlCount: 3 }],
      outsideTableFormControlCount: 0,
      iframeCount: 0,
      iframePaths: [],
      pagePath: 'https://www.sujain.co.kr/mypage/unit-items',
      lookupNonPlaceholderOptionCount: 0,
      lookupClicked: false,
      lookupBodyRowsAppeared: false,
    },
    secretPage: { tableCount: 9, tableHeaders: [['nope']], rawRowCount: 9, eligibleRowCount: 9 },
  };
  const sanitized = sanitizeLayoutDiagnostics(dirty);
  assert.deepEqual(sanitized, {
    payment: {
      tableCount: 1,
      tableHeaders: [['항목', '내용']],
      rawRowCount: 2,
      eligibleRowCount: 0,
      tables: [{ rawRowCount: 2, preSkipRowCount: 3, formControlCount: 0 }],
      outsideTableFormControlCount: 2,
      outsideTableFormControls: {
        visibleInput: 1,
        visibleSelect: 1,
        visibleTextarea: 0,
        hidden: 0,
        other: 0,
      },
      iframeCount: 1,
      iframePaths: ['https://www.sujain.co.kr/embed'],
      pagePath: 'https://www.sujain.co.kr/mypage/payment',
      lookupNonPlaceholderOptionCount: 0,
      lookupClicked: false,
      lookupBodyRowsAppeared: false,
    },
    'unit-items': {
      tableCount: 1,
      tableHeaders: [['품목', '금액'], []],
      rawRowCount: 1,
      eligibleRowCount: 1,
      tables: [{ rawRowCount: 1, preSkipRowCount: 2, formControlCount: 3 }],
      outsideTableFormControlCount: 0,
      outsideTableFormControls: {
        visibleInput: 0,
        visibleSelect: 0,
        visibleTextarea: 0,
        hidden: 0,
        other: 0,
      },
      iframeCount: 0,
      iframePaths: [],
      pagePath: 'https://www.sujain.co.kr/mypage/unit-items',
      lookupNonPlaceholderOptionCount: 0,
      lookupClicked: false,
      lookupBodyRowsAppeared: false,
    },
  });
  const text = JSON.stringify(sanitized);
  assert.equal(text.includes('합성 회원'), false);
  assert.equal(text.includes('000-0000-0000'), false);
  assert.equal(text.includes('secretPage'), false);
  assert.equal(text.includes('SECRET_TOKEN'), false);
  assert.equal(text.includes('SECRET_IFRAME'), false);
  assert.equal(text.includes('?session='), false);
  assert.equal(text.includes('secretType'), false);
  assert.equal(text.includes('password'), false);

  const page = sanitizePageLayoutDiagnostic({
    sourcePage: 'payment',
    tableCount: 1,
    tableHeaders: [['항목', '금액']],
    rawRowCount: 1,
    eligibleRowCount: 0,
    tables: [{ rawRowCount: 1, preSkipRowCount: 1, formControlCount: 0 }],
    outsideTableFormControlCount: 0,
    iframeCount: 0,
    iframePaths: [],
    pagePath: null,
    lookupNonPlaceholderOptionCount: 0,
    lookupClicked: false,
    lookupBodyRowsAppeared: false,
    cells: ['합성 항목 A', '500,000'],
  });
  assert.equal(Object.hasOwn(page, 'cells'), false);
  assert.deepEqual(page.outsideTableFormControls, {
    visibleInput: 0,
    visibleSelect: 0,
    visibleTextarea: 0,
    hidden: 0,
    other: 0,
  });
  assert.equal(JSON.stringify(page).includes('합성 항목 A'), false);

  const fragment = formatLayoutWarnFragment(sanitized);
  assert.match(
    fragment,
    /^layout=payment:t=1;h=\[항목\|내용\];raw=2;eligible=0;tables=\[r=2,p=3,i=0\];out=2\[vi=1,vs=1,vt=0,h=0,o=0\];lookup=np=0;click=0;rows=0;ifr=1;path=https:\/\/www\.sujain\.co\.kr\/mypage\/payment\|/,
  );
  assert.match(
    fragment,
    /unit-items:t=1;h=\[품목\|금액\],\[\];raw=1;eligible=1;tables=\[r=1,p=2,i=3\];out=0\[vi=0,vs=0,vt=0,h=0,o=0\];lookup=np=0;click=0;rows=0;ifr=0;path=https:\/\/www\.sujain\.co\.kr\/mypage\/unit-items/,
  );
  assert.equal(fragment.includes('합성 회원'), false);
  assert.equal(fragment.includes('SECRET_TOKEN'), false);
});
