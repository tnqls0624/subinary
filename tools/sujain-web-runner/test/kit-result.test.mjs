import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFailurePayload, sanitizeErrorName, writeResult } from '../kit/result.mjs';

/**
 * 러너 키트 result(docs/architecture/housing-brand-adapters.md 4단계). 브랜드 코드 대신 합성 코드를 쓴다.
 */
const CODES = new Set(['synthetic_code', 'runtime_unavailable', 'operation_unknown']);
const syntheticClassify = () => ({ reason: 'synthetic_exception', errorName: 'SyntheticError' });

test('sanitizeErrorName keeps letters only, caps at 40, and never reads the message', () => {
  const named = new Error('synthetic secret page text');
  named.name = 'Synthetic Error_123!';
  assert.equal(sanitizeErrorName(named), 'SyntheticError');
  assert.equal(sanitizeErrorName({ name: `X${'a'.repeat(80)}` })?.length, 40);
  assert.equal(sanitizeErrorName({ name: '123!@#' }), null);
  assert.equal(sanitizeErrorName(null), null);
  assert.equal(sanitizeErrorName('string-throw'), null);
});

test('a code outside allowedCodes becomes operation_unknown', () => {
  assert.deepEqual(buildFailurePayload({ code: 'not_allowed', allowedCodes: CODES }), { ok: false, error: 'operation_unknown' });
  assert.deepEqual(buildFailurePayload({ code: undefined, allowedCodes: CODES }), { ok: false, error: 'operation_unknown' });
  assert.deepEqual(buildFailurePayload({ code: 'synthetic_code' }), { ok: false, error: 'operation_unknown' });
  assert.deepEqual(buildFailurePayload({ code: 'synthetic_code', allowedCodes: CODES }), { ok: false, error: 'synthetic_code' });
});

test('failureReason is attached only for runtime_unavailable, and then classify is not consulted', () => {
  let classified = 0;
  const classify = () => {
    classified += 1;
    return syntheticClassify();
  };
  assert.deepEqual(
    buildFailurePayload({ code: 'runtime_unavailable', allowedCodes: CODES, failureReason: 'synthetic_launch_failed', classify }),
    { ok: false, error: 'runtime_unavailable', reason: 'synthetic_launch_failed' },
  );
  assert.equal(classified, 0);
  assert.deepEqual(
    buildFailurePayload({ code: 'synthetic_code', allowedCodes: CODES, failureReason: 'synthetic_launch_failed', classify }),
    { ok: false, error: 'synthetic_code', reason: 'synthetic_exception', errorName: 'SyntheticError' },
  );
  assert.equal(classified, 1);
});

test('classify gets the thrown error; errorName is attached only when present; null attaches nothing', () => {
  const thrown = new Error('synthetic');
  let received;
  buildFailurePayload({ error: thrown, code: 'operation_unknown', allowedCodes: CODES, classify: (error) => { received = error; return null; } });
  assert.equal(received, thrown);
  assert.deepEqual(
    buildFailurePayload({ code: 'operation_unknown', allowedCodes: CODES, classify: () => ({ reason: 'synthetic_exception', errorName: null }) }),
    { ok: false, error: 'operation_unknown', reason: 'synthetic_exception' },
  );
  assert.deepEqual(
    buildFailurePayload({ code: 'operation_unknown', allowedCodes: CODES, classify: () => null }),
    { ok: false, error: 'operation_unknown' },
  );
});

test('keys keep the order ok, error, reason, errorName, stage; a null stage is left out', () => {
  const full = buildFailurePayload({ code: 'operation_unknown', allowedCodes: CODES, stage: 'synthetic_stage', classify: syntheticClassify });
  assert.equal(
    JSON.stringify(full),
    '{"ok":false,"error":"operation_unknown","reason":"synthetic_exception","errorName":"SyntheticError","stage":"synthetic_stage"}',
  );
  const noStage = buildFailurePayload({ code: 'synthetic_code', allowedCodes: CODES, stage: null });
  assert.equal(JSON.stringify(noStage), '{"ok":false,"error":"synthetic_code"}');
});

test('writeResult writes exactly one compact JSON string', () => {
  const writes = [];
  writeResult({ ok: true, rows: [{ cells: ['합성 값', ''] }] }, { write: (text) => writes.push(text) });
  assert.deepEqual(writes, ['{"ok":true,"rows":[{"cells":["합성 값",""]}]}']);
});
