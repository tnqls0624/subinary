import assert from 'node:assert/strict';
import test from 'node:test';
import { makeOriginAllowlist, routeAllowlist } from '../kit/allowlist.mjs';

/**
 * 러너 키트 allowlist(docs/architecture/housing-brand-adapters.md 4단계). 합성 호스트만 쓴다.
 */
const allowed = makeOriginAllowlist(['https://synthetic-a.example', 'https://synthetic-b.example']);

test('allows exact origins only (scheme, host, and port must all match)', () => {
  assert.equal(allowed('https://synthetic-a.example/path?q=1'), true);
  assert.equal(allowed('https://synthetic-b.example/'), true);
  assert.equal(allowed('http://synthetic-a.example/'), false);
  assert.equal(allowed('https://synthetic-a.example:8443/'), false);
  assert.equal(allowed('https://sub.synthetic-a.example/'), false);
  assert.equal(allowed('https://other.example/synthetic-a.example'), false);
});

test('rejects URLs carrying a username or password even on an allowed origin', () => {
  assert.equal(allowed('https://synthetic@synthetic-a.example/'), false);
  assert.equal(allowed('https://:x@synthetic-a.example/'), false);
});

test('rejects values that do not parse as URLs', () => {
  for (const value of ['', 'not a url', undefined, null, 42, {}]) {
    assert.equal(allowed(value), false);
  }
});

test('allowlist entries must be bare origins — a trailing slash or path is a setup error', () => {
  for (const bad of ['https://synthetic-a.example/', 'https://synthetic-a.example/login', 'synthetic-a.example', 'https://synthetic@synthetic-a.example', '', 42]) {
    assert.throws(() => makeOriginAllowlist([bad]), TypeError);
  }
});

test('the allowlist is copied when it is made', () => {
  const source = new Set(['https://synthetic-a.example']);
  const check = makeOriginAllowlist(source);
  source.add('https://synthetic-c.example');
  assert.equal(check('https://synthetic-c.example/'), false);
});

test('routeAllowlist routes every request and aborts anything outside the allowlist', async () => {
  const probes = ['https://synthetic-a.example/x', 'https://synthetic@synthetic-a.example/', 'https://other.example/'];
  const decisions = {};
  let pattern;
  const context = {
    async route(routePattern, handler) {
      pattern = routePattern;
      for (const url of probes) {
        await handler({
          request: () => ({ url: () => url }),
          continue: async () => { decisions[url] = 'continue'; },
          abort: async () => { decisions[url] = 'abort'; },
        });
      }
    },
  };
  await routeAllowlist(context, allowed);
  assert.equal(pattern, '**/*');
  assert.deepEqual(decisions, {
    'https://synthetic-a.example/x': 'continue',
    'https://synthetic@synthetic-a.example/': 'abort',
    'https://other.example/': 'abort',
  });
});

test('routeAllowlist refuses a non-function predicate before touching the context', async () => {
  let routed = false;
  await assert.rejects(routeAllowlist({ async route() { routed = true; } }, new Set()), TypeError);
  assert.equal(routed, false);
});
