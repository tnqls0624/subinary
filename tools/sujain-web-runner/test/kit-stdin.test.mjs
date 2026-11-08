import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readJobJson } from '../kit/stdin.mjs';

/**
 * 러너 키트 stdin(docs/architecture/housing-brand-adapters.md 4단계). 브랜드 값 없이 합성 값만 쓴다.
 */
class SyntheticReadError extends Error {
  constructor(code) {
    super('synthetic read did not complete');
    this.code = code;
  }
}
const onError = (code) => new SyntheticReadError(code);
const SECRET = 'SYNTHETIC_SECRET';
const streamOf = (...chunks) => Readable.from(chunks.map((chunk) => Buffer.from(chunk, 'utf8')));
/** 정확히 size 바이트인 JSON 객체 하나. */
const jsonOfBytes = (size) => {
  const head = '{"pad":"';
  const tail = '"}';
  return `${head}${'p'.repeat(size - head.length - tail.length)}${tail}`;
};
const isOperationUnknown = (error) => error instanceof SyntheticReadError && error.code === 'operation_unknown';

test('reads one JSON value across chunks and returns what validate returns', async () => {
  const seen = [];
  const job = await readJobJson(streamOf('{"provider":"synthetic",', '"credentials":{"loginId":"a","password":"b"}}'), {
    onError,
    validate: (value) => {
      seen.push(value);
      return { ...value, checked: true };
    },
  });
  assert.deepEqual(job, { provider: 'synthetic', credentials: { loginId: 'a', password: 'b' }, checked: true });
  assert.equal(seen.length, 1);
});

test('over 8192 bytes (default maxBytes) → onError(operation_unknown) while reading, before onReadComplete', async () => {
  let completed = 0;
  await assert.rejects(
    readJobJson(streamOf('x'.repeat(5000), 'x'.repeat(5000)), { onError, onReadComplete: () => { completed += 1; } }),
    isOperationUnknown,
  );
  assert.equal(completed, 0);
});

test('exactly maxBytes is read; one more byte is rejected; maxBytes is configurable', async () => {
  const job = await readJobJson(streamOf(jsonOfBytes(8192)), { onError });
  assert.equal(JSON.stringify(job).length, 8192);
  await assert.rejects(readJobJson(streamOf(jsonOfBytes(8193)), { onError }), isOperationUnknown);
  await assert.rejects(readJobJson(streamOf('{"a":1}'), { onError, maxBytes: 4 }), isOperationUnknown);
});

test('broken or empty JSON → onError(operation_unknown) after onReadComplete', async () => {
  for (const input of ['{', '']) {
    let completed = 0;
    await assert.rejects(
      readJobJson(streamOf(input), { onError, onReadComplete: () => { completed += 1; } }),
      isOperationUnknown,
    );
    assert.equal(completed, 1);
  }
});

test('validate rejection is replaced by onError(operation_unknown) and never carries input text', async () => {
  await assert.rejects(
    readJobJson(streamOf(JSON.stringify({ password: SECRET })), {
      onError,
      validate: () => { throw new Error(`rejected ${SECRET}`); },
    }),
    (error) => isOperationUnknown(error)
      && !String(error).includes(SECRET)
      && !JSON.stringify(error).includes(SECRET),
  );
});

test('without onError a plain Error carrying only the code is thrown', async () => {
  await assert.rejects(
    readJobJson(streamOf(`{"password":"${SECRET}"`)),
    (error) => error instanceof Error
      && error.code === 'operation_unknown'
      && !String(error).includes(SECRET),
  );
});
