import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROUTE_PROBES } from './fake-playwright-core.mjs';

/**
 * run.mjs 결과 JSON 의 키 집합·순서·값 고정(docs/architecture/housing-brand-adapters.md 0단계).
 * run.mjs 는 import 하자마자 stdin 을 읽고 결과를 쓰는 진입 스크립트라 함수로 부를 수 없다.
 * 그래서 API(sujain-browser.ts)처럼 자식 프로세스로 띄우고, playwright-core 만 모듈 해석 훅
 * (fake-playwright-hooks.mjs)으로 가짜(fake-playwright-core.mjs)로 바꾼다. collect·policy·table-capture
 * 는 진짜 코드를 그대로 지나므로 run.mjs 를 키트로 줄여도(4단계) 이 파일은 고치지 않고 통과해야 한다.
 * 실제 브라우저·네트워크·수자인 사이트에 접속하지 않는다. 값은 모두 합성이다.
 */
const RUN = fileURLToPath(new URL('../run.mjs', import.meta.url));
const RUNNER_DIR = fileURLToPath(new URL('..', import.meta.url));
const HOOKS = new URL('./fake-playwright-hooks.mjs', import.meta.url).href;
const REGISTER_HOOKS = `data:text/javascript,${encodeURIComponent(
  `import { register } from 'node:module'; register(${JSON.stringify(HOOKS)});`,
)}`;
const LOGIN_ID = 'synthetic-id';
const PASSWORD = 'x'.repeat(16);
const JOB = JSON.stringify({ provider: 'sujain', credentials: { loginId: LOGIN_ID, password: PASSWORD } });
/** 실패 JSON 의 키는 늘 이 순서의 부분열이다(API responseSchema 와 경고 로그가 이 모양을 읽는다). */
const FAILURE_KEY_ORDER = ['ok', 'error', 'reason', 'errorName', 'stage', 'layout'];
const HEADERS = ['회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금'];
const SANDBOX = typeof process.getuid !== 'function' || process.getuid() !== 0;

function runRunner({ scenario = 'success', stdin = JOB, executable = '/synthetic/chromium' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', REGISTER_HOOKS, RUN], {
      cwd: RUNNER_DIR,
      // API 가 넘기는 env 와 같은 모양 + 표 대기 0(가짜 page 는 바로 그려진다) + 장면 선택.
      env: {
        PATH: '/usr/bin:/bin',
        TZ: 'Asia/Seoul',
        SUJAIN_WEB_BROWSER_EXECUTABLE: executable,
        SUJAIN_TABLE_WAIT_MS: '0',
        FAKE_PLAYWRIGHT_SCENARIO: scenario,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('runner did not exit'));
    }, 15_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const trace = stderr.split('\n')
        .filter((line) => line.startsWith('FAKE_PLAYWRIGHT '))
        .map((line) => JSON.parse(line.slice('FAKE_PLAYWRIGHT '.length)));
      resolve({ code, stdout, trace });
    });
    // 러너가 stdin 을 끝까지 읽지 않고 멈추는 경로(8192바이트 초과)에서 EPIPE 를 삼킨다.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

function assertNoCredentials(stdout) {
  assert.equal(stdout.includes(LOGIN_ID), false);
  assert.equal(stdout.includes(PASSWORD), false);
}

const pay = (cells) => ({ cells, headers: HEADERS, sourcePage: 'payment', section: 'payment' });
const opt = (itemLabel, cells) => ({ cells, headers: HEADERS, sourcePage: 'payment', section: 'option', itemLabel });

test('success JSON is { ok, capturedAt, rows } with rows { cells, headers, sourcePage, section, itemLabel? }', async () => {
  const result = await runRunner();
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  // 한 줄 JSON 하나만 쓴다(공백·줄바꿈 없음).
  assert.equal(JSON.stringify(payload), result.stdout);
  assert.match(payload.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  const expected = {
    ok: true,
    capturedAt: payload.capturedAt,
    rows: [
      pay(['계약금1차', '2023-05-20', '10,000,000', '2023-05-20', '10,000,000', '0', '0', '10,000,000']),
      pay(['중도금1차', '2024-01-25', '32,340,000', '', '0', '0', '0', '0']),
      pay(['잔금', '2027-02-26', '96,999,000', '', '0', '0', '0', '0']),
      pay(['계', '', '139,339,000', '', '10,000,000', '0', '0', '10,000,000']),
      opt('합성 현관 중문, [합성조명]-거실(2개소)', ['계약금', '2023-05-20', '1,230,000', '2023-05-20', '1,230,000', '0', '0', '1,230,000']),
      opt('합성 현관 중문, [합성조명]-거실(2개소)', ['잔금', '2027-02-26', '7,380,000', '', '0', '0', '0', '0']),
      opt('합성 현관 중문, [합성조명]-거실(2개소)', ['계', '', '8,610,000', '', '1,230,000', '0', '0', '1,230,000']),
      opt('합성 시스템에어컨(3대)', ['계약금', '2023-05-20', '450,000', '2023-05-21', '450,000', '0', '0', '450,000']),
      opt('합성 시스템에어컨(3대)', ['계', '', '450,000', '', '450,000', '0', '0', '450,000']),
    ],
  };
  assert.deepEqual(payload, expected);
  assert.equal(result.stdout, JSON.stringify(expected));
  assertNoCredentials(result.stdout);

  // 프로세스 뼈대: launch·context 옵션, origin 허용 목록, 기본 시간 제한, 닫는 순서.
  const events = Object.fromEntries(result.trace.filter((entry) => entry.event !== 'close').map((entry) => [entry.event, entry]));
  assert.deepEqual(events.launch.options, {
    executablePath: '/synthetic/chromium',
    headless: true,
    chromiumSandbox: SANDBOX,
    timeout: 20_000,
    env: { PATH: '/usr/bin:/bin', TZ: 'Asia/Seoul' },
  });
  assert.deepEqual(events.newContext.options, { acceptDownloads: false, serviceWorkers: 'block' });
  assert.equal(events.route.pattern, '**/*');
  assert.deepEqual(Object.keys(events.route.decisions), ROUTE_PROBES);
  assert.deepEqual(events.route.decisions, {
    'https://www.sujain.co.kr/mypage/payment': 'continue',
    'https://m.sujain.co.kr/': 'continue',
    'http://www.sujain.co.kr/': 'abort',
    'https://synthetic.example/': 'abort',
    'https://synthetic@www.sujain.co.kr/': 'abort',
  });
  assert.equal(events.setDefaultTimeout.ms, 5000);
  assert.deepEqual(result.trace.filter((entry) => entry.event === 'close').map((entry) => entry.target), ['context', 'browser']);
});

const FAILURES = [
  {
    name: 'stdin over 8192 bytes',
    run: { stdin: 'x'.repeat(9000) },
    expected: { ok: false, error: 'operation_unknown', stage: 'stdin' },
  },
  {
    name: 'broken job JSON',
    run: { stdin: '{' },
    expected: { ok: false, error: 'operation_unknown', stage: 'validate' },
  },
  {
    name: 'job for another provider',
    run: { stdin: JSON.stringify({ provider: 'synthetic_brand', credentials: { loginId: LOGIN_ID, password: PASSWORD } }) },
    expected: { ok: false, error: 'operation_unknown', stage: 'validate' },
  },
  {
    name: 'playwright-core cannot be imported',
    run: { scenario: 'import_missing' },
    expected: { ok: false, error: 'runtime_unavailable', stage: 'import' },
  },
  {
    name: 'browser executable is not an absolute path',
    run: { executable: 'synthetic/chromium' },
    expected: { ok: false, error: 'runtime_unavailable', stage: 'import' },
  },
  {
    name: 'chromium launch fails',
    run: { scenario: 'launch_fail' },
    expected: { ok: false, error: 'runtime_unavailable', reason: 'chromium_launch_failed', stage: 'launch' },
  },
  {
    name: 'typed collect error (credentials_invalid)',
    run: { scenario: 'credentials_invalid' },
    expected: { ok: false, error: 'credentials_invalid', stage: 'login' },
  },
  {
    name: 'untyped Playwright TimeoutError',
    run: { scenario: 'timeout' },
    expected: { ok: false, error: 'operation_unknown', reason: 'playwright_timeout', errorName: 'TimeoutError', stage: 'login' },
  },
  {
    name: 'typed collect error with layout diagnostics (unit_not_registered)',
    run: { scenario: 'unit_not_registered' },
    expected: {
      ok: false,
      error: 'unit_not_registered',
      stage: 'scrape_payment',
      layout: {
        payment: {
          tableCount: 2,
          tableHeaders: [],
          rawRowCount: 0,
          eligibleRowCount: 0,
          tables: [],
          outsideTableFormControlCount: 1,
          outsideTableFormControls: { visibleInput: 0, visibleSelect: 1, visibleTextarea: 0, hidden: 0, other: 0 },
          iframeCount: 0,
          iframePaths: [],
          pagePath: 'https://www.sujain.co.kr/mypage/payment',
          searched: 0,
          units: 0,
        },
      },
    },
  },
];

for (const failure of FAILURES) {
  test(`failure JSON: ${failure.name}`, async () => {
    const result = await runRunner(failure.run);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, JSON.stringify(failure.expected));
    const keys = Object.keys(JSON.parse(result.stdout));
    assert.deepEqual(keys, FAILURE_KEY_ORDER.filter((key) => keys.includes(key)));
    assertNoCredentials(result.stdout);
    // 브라우저를 띄운 경로는 성공·실패와 관계없이 context → browser 순서로 닫는다.
    const launched = result.trace.some((entry) => entry.event === 'newContext');
    const closed = result.trace.filter((entry) => entry.event === 'close').map((entry) => entry.target);
    assert.deepEqual(closed, launched ? ['context', 'browser'] : []);
  });
}
