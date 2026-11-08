import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  chromiumSandboxEnabled,
  createCloser,
  installSignalCleanup,
  isAbsoluteExecutable,
  launchHeadless,
  openIsolatedContext,
} from '../kit/launch.mjs';

/**
 * 러너 키트 launch(docs/architecture/housing-brand-adapters.md 4단계). 가짜 chromium·browser 만 쓴다.
 */
function fakeChromium() {
  const calls = [];
  return {
    calls,
    chromium: {
      async launch(options) {
        calls.push(options);
        return { synthetic: 'browser' };
      },
    },
  };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('chromiumSandboxEnabled: getuid=0 (root container) turns the sandbox off, otherwise it stays on', () => {
  assert.equal(chromiumSandboxEnabled(() => 0), false);
  assert.equal(chromiumSandboxEnabled(() => 501), true);
  // getuid 가 없는 플랫폼이면 켠 채로 둔다.
  assert.equal(chromiumSandboxEnabled(null), true);
});

test('launchHeadless passes the fixed launch options and only PATH·TZ to Chromium', async () => {
  const { calls, chromium } = fakeChromium();
  const browser = await launchHeadless({
    chromium,
    executablePath: '/synthetic/chromium',
    chromiumSandbox: chromiumSandboxEnabled(() => 0),
    sourceEnv: { PATH: '/synthetic/bin', SYNTHETIC_RUNNER_SETTING: 'not-for-chromium', HOME: '/synthetic/home' },
  });
  assert.deepEqual(browser, { synthetic: 'browser' });
  assert.deepEqual(calls, [{
    executablePath: '/synthetic/chromium',
    headless: true,
    chromiumSandbox: false,
    timeout: 20_000,
    env: { PATH: '/synthetic/bin', TZ: 'Asia/Seoul' },
  }]);
  assert.deepEqual(Object.keys(calls[0]), ['executablePath', 'headless', 'chromiumSandbox', 'timeout', 'env']);
});

test('launchHeadless falls back to /usr/bin:/bin without PATH and honours timeoutMs/timezone', async () => {
  const { calls, chromium } = fakeChromium();
  await launchHeadless({
    chromium,
    executablePath: '/synthetic/chromium',
    chromiumSandbox: true,
    timeoutMs: 1234,
    timezone: 'UTC',
    sourceEnv: {},
  });
  assert.deepEqual(calls[0].env, { PATH: '/usr/bin:/bin', TZ: 'UTC' });
  assert.equal(calls[0].timeout, 1234);
  assert.equal(calls[0].chromiumSandbox, true);
});

test('launchHeadless refuses a relative executable, a missing sandbox decision, or no chromium before launching', async () => {
  const { calls, chromium } = fakeChromium();
  const attempts = [
    { chromium, executablePath: 'synthetic/chromium', chromiumSandbox: true },
    { chromium, executablePath: undefined, chromiumSandbox: true },
    { chromium, executablePath: '/synthetic/chromium' },
    { chromium, executablePath: '/synthetic/chromium', chromiumSandbox: 'yes' },
    { chromium: {}, executablePath: '/synthetic/chromium', chromiumSandbox: true },
  ];
  for (const attempt of attempts) {
    await assert.rejects(launchHeadless(attempt), TypeError);
  }
  assert.equal(calls.length, 0);
});

test('launchHeadless lets a launch failure through unchanged (the entry file maps it to its own reason)', async () => {
  const failure = new Error('synthetic launch failure');
  await assert.rejects(
    launchHeadless({
      chromium: { launch: async () => { throw failure; } },
      executablePath: '/synthetic/chromium',
      chromiumSandbox: true,
    }),
    (error) => error === failure,
  );
});

test('isAbsoluteExecutable accepts absolute string paths only', () => {
  assert.equal(isAbsoluteExecutable('/synthetic/chromium'), true);
  assert.equal(isAbsoluteExecutable('synthetic/chromium'), false);
  assert.equal(isAbsoluteExecutable(''), false);
  assert.equal(isAbsoluteExecutable(undefined), false);
});

test('openIsolatedContext blocks downloads and service workers', async () => {
  const seen = [];
  const context = await openIsolatedContext({
    async newContext(options) {
      seen.push(options);
      return { synthetic: 'context' };
    },
  });
  assert.deepEqual(context, { synthetic: 'context' });
  assert.deepEqual(seen, [{ acceptDownloads: false, serviceWorkers: 'block' }]);
});

test('createCloser closes in the given order once, reads targets at close time, and swallows close errors', async () => {
  const closed = [];
  let context;
  let browser;
  const close = createCloser([() => context, () => browser]);
  context = { async close() { closed.push('context'); throw new Error('synthetic close failure'); } };
  browser = { async close() { closed.push('browser'); } };
  await close();
  await close();
  assert.deepEqual(closed, ['context', 'browser']);
});

test('createCloser skips targets that were never created', async () => {
  const closed = [];
  const browser = { async close() { closed.push('browser'); } };
  await createCloser([() => undefined, () => browser])();
  assert.deepEqual(closed, ['browser']);
});

test('createCloser ignores a second call while the first is still closing', async () => {
  const closed = [];
  let release;
  const context = {
    close() {
      closed.push('context');
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const close = createCloser([() => context]);
  const first = close();
  await close();
  release();
  await first;
  assert.deepEqual(closed, ['context']);
});

test('installSignalCleanup closes then exits 0 on SIGTERM and SIGINT, and the returned function removes it', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const proc = new EventEmitter();
    const events = [];
    proc.exit = (code) => events.push(`exit:${code}`);
    let release;
    const close = () => {
      events.push('close');
      return new Promise((resolve) => { release = resolve; });
    };
    const remove = installSignalCleanup(close, proc);
    proc.emit(signal);
    // 닫기는 바로 시작하고, 끝내기는 닫기가 끝난 뒤다.
    assert.deepEqual(events, ['close']);
    release();
    await nextTurn();
    assert.deepEqual(events, ['close', 'exit:0']);
    remove();
    assert.equal(proc.listenerCount('SIGTERM'), 0);
    assert.equal(proc.listenerCount('SIGINT'), 0);
  }
});

test('installSignalCleanup still exits 0 when close rejects', async () => {
  const proc = new EventEmitter();
  const exits = [];
  proc.exit = (code) => exits.push(code);
  installSignalCleanup(async () => { throw new Error('synthetic close failure'); }, proc);
  proc.emit('SIGTERM');
  await nextTurn();
  assert.deepEqual(exits, [0]);
});
