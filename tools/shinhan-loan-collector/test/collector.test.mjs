import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { collectShinhanLoans } from '../collector.js';
import { isSanitizedCapture, serializeSelectedCapture } from '../export.js';
import { fixtureDocument, pageHtml, tableHtml } from './synthetic-dom.mjs';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const collect = (html = pageHtml(), options) => collectShinhanLoans({ rootDocument: fixtureDocument(html, options) });
const expectError = async (html, error, options) => assert.deepEqual(await collect(html, options), { ok: false, error });
const rowPage = (overrides = {}, tableOptions = {}) => pageHtml({ body: tableHtml({
  rows: [[overrides.product ?? '합성 중도금 대출', overrides.account ?? '123-456-789012', overrides.amount ?? '12,345 원', overrides.maturity ?? '2030.02.28']],
  ...tableOptions,
}) });

test('synthetic HTML extraction selects exact current balance and returns only sanitized candidates', async () => {
  const html = await readFile(new URL('./fixtures/loan-account-list.html', import.meta.url), 'utf8');
  const result = await collect(html);
  assert.equal(result.ok, true);
  assert.equal(result.captures.length, 2);
  assert.deepEqual(result.captures.map((capture) => [capture.loanType, capture.accountLast4, capture.outstandingPrincipalKrw, capture.maturityDate]), [
    ['interim', '9012', '12345678', '2030-02-28'], ['jeonse', '1098', '0', null],
  ]);
  result.captures.forEach((capture) => {
    assert.equal(isSanitizedCapture(capture), true);
    assert.equal(capture.bankAsOfDate, null);
    assert.equal(capture.pageKind, 'loan_account_list');
  });
  const exported = serializeSelectedCapture(result.captures[1]);
  assert.equal(JSON.parse(exported).outstandingPrincipalKrw, '0');
  const serialized = JSON.stringify(result);
  for (const secret of ['123-456-789012', '123456789012', '987-654-321098', '합성', '가상동', '99,999,999', '<table']) assert.equal(serialized.includes(secret), false);
});

test('script injection function survives serialization without imports or closure state', async () => {
  const isolated = vm.runInNewContext(`(${collectShinhanLoans.toString()})`, { URL, TextEncoder, crypto: webcrypto });
  const result = await isolated({ rootDocument: fixtureDocument(pageHtml()) });
  assert.equal(result.ok, true);
  assert.equal(isSanitizedCapture(result.captures[0]), true);
});

test('stable SHA-256 account fingerprints use domain separation and normalized full account', async () => {
  const hyphenated = (await collect(rowPage())).captures[0];
  const normalized = (await collect(rowPage({ account: '123456789012' }))).captures[0];
  const sameLast4 = (await collect(rowPage({ account: '999999999012' }))).captures[0];
  const expected = createHash('sha256').update(['fma:shinhan:loan-account:v1', 'https://bank.shinhan.com', '123456789012'].join('\0')).digest('hex');
  assert.equal(hyphenated.accountFingerprint, expected);
  assert.equal(hyphenated.accountFingerprint, normalized.accountFingerprint);
  assert.notEqual(hyphenated.accountFingerprint, sameLast4.accountFingerprint);
  assert.equal(hyphenated.accountLast4, sameLast4.accountLast4);
});

test('only exact HTTPS bank origin and the top-level document are accepted', async () => {
  for (const url of ['http://bank.shinhan.com/', 'https://bank.shinhan.com.evil.invalid/', 'https://shinhan.com/', 'https://bank.shinhan.com:444/', 'https://user:pass@bank.shinhan.com/']) {
    await expectError(pageHtml(), 'WRONG_ORIGIN', { url });
  }
  await expectError(pageHtml(), 'UNSUPPORTED_FRAME', { topLevel: false });
  await expectError(pageHtml({ body: '<iframe src="https://bank.shinhan.com/loan"></iframe>' }), 'NO_SUPPORTED_TABLE');
});

test('history, rate pages, unknown titles, and historical columns fail closed', async () => {
  const history = await readFile(new URL('./fixtures/transaction-history.html', import.meta.url), 'utf8');
  await expectError(history, 'UNSUPPORTED_PAGE');
  await expectError(pageHtml({ heading: '대출금리 조회' }), 'UNSUPPORTED_PAGE');
  await expectError(pageHtml({ title: '알 수 없는 화면' }), 'UNSUPPORTED_PAGE');
  await expectError(pageHtml({ title: '인터넷뱅킹 메인 | 신한은행 개인뱅킹', heading: '다른 조회 화면' }), 'UNSUPPORTED_PAGE');
  await expectError(pageHtml({ body: tableHtml({ headers: ['상품', '계좌번호', '대출잔액', '만기일', '거래일자'], rows: [['중도금', '123456789012', '1 원', '-', '2020.01.01']] }) }), 'UNSUPPORTED_PAGE');
});

test('missing, duplicate, and lookalike semantic columns cannot substitute principal', async () => {
  for (const misleading of ['대출한도', '대출실행금액', '대출잔액상세', '지난대출잔액']) {
    await expectError(rowPage({}, { headers: ['상품', '계좌번호', misleading, '만기일'] }), 'NO_SUPPORTED_TABLE');
  }
  await expectError(rowPage({}, { headers: ['상품', '계좌번호', '대출잔액', '대출만기일'] }), 'AMBIGUOUS_COLUMNS');
  await expectError(pageHtml({ body: tableHtml({ headers: ['상품', '계좌번호', '대출잔액', '대출잔액(원)', '만기일'] }) }), 'AMBIGUOUS_COLUMNS');
  await expectError(pageHtml({ body: tableHtml({ headers: ['계좌번호', '계좌번호', '대출잔액', '만기일'] }) }), 'AMBIGUOUS_COLUMNS');
});

test('multiple candidate tables, repeated headers, spans and hidden cells are rejected', async () => {
  await expectError(pageHtml({ body: tableHtml() + tableHtml() }), 'AMBIGUOUS_TABLE');
  const repeatedHeader = tableHtml().replace('</tbody>', '<tr><th>상품</th><th>계좌번호</th><th>대출잔액</th><th>만기일</th></tr></tbody>');
  await expectError(pageHtml({ body: repeatedHeader }), 'AMBIGUOUS_COLUMNS');
  await expectError(pageHtml({ body: tableHtml().replace('<th>계좌번호', '<th colspan="2">계좌번호') }), 'UNSUPPORTED_LAYOUT');
  await expectError(pageHtml({ body: tableHtml().replace('<td>123-456-789012', '<td hidden>123-456-789012') }), 'UNSUPPORTED_LAYOUT');
});

test('hidden tables and rows are never used as balances', async () => {
  const hidden = tableHtml({ tableAttributes: 'style="display:none"' });
  assert.equal((await collect(pageHtml({ body: tableHtml() + hidden }))).captures.length, 1);
  const rows = tableHtml().replace('</tbody>', '<tr hidden><td>중도금</td><td>invalid</td><td>broken</td><td>broken</td></tr></tbody>');
  assert.equal((await collect(pageHtml({ body: rows }))).captures.length, 1);
  await expectError(pageHtml({ body: '<div aria-hidden="true">' + tableHtml() + '</div>' }), 'NO_SUPPORTED_TABLE');
});

test('KRW evidence is required in the value, exact header, caption or immediately adjacent unit label', async () => {
  await expectError(rowPage({ amount: '12345' }), 'MISSING_KRW_UNIT');
  await expectError(rowPage({ amount: 'USD 12345' }), 'INVALID_AMOUNT');
  for (const amount of ['₩12,345', 'KRW 12345', '12,345 원']) assert.equal((await collect(rowPage({ amount }))).captures[0].outstandingPrincipalKrw, '12345');
  assert.equal((await collect(rowPage({ amount: '12345' }, { headers: ['상품', '계좌번호', '대출잔액 (원)', '만기일'] }))).ok, true);
  assert.equal((await collect(rowPage({ amount: '12345' }, { caption: '대출계좌명세 (단위: 원)' }))).ok, true);
  assert.equal((await collect(pageHtml({ body: '<p>(단위: 원)</p>' + tableHtml({ rows: [['중도금', '123456789012', '12345', '-']] }) }))).ok, true);
  await expectError(rowPage({ amount: '12345' }, { caption: '단위: USD' }), 'MISSING_KRW_UNIT');
});

test('decimal strings preserve 20-digit precision; zero differs from blank and malformed values', async () => {
  const maximum = '99999999999999999999';
  assert.equal((await collect(rowPage({ amount: `${maximum} 원` }))).captures[0].outstandingPrincipalKrw, maximum);
  assert.equal((await collect(rowPage({ amount: '0 원' }))).captures[0].outstandingPrincipalKrw, '0');
  for (const amount of ['', ' ', '-', '00 원', '01 원', '-1 원', '+1 원', '1.5 원', '1e3 원', '10,00 원', '1,00,000 원', '100000000000000000000 원', '1\n000 원']) {
    await expectError(rowPage({ amount }), 'INVALID_AMOUNT');
  }
});

test('maturity dates must exist in the calendar and only explicit absence maps to null', async () => {
  for (const value of ['2000-02-29', '2028.02.29', '2030/12/31']) {
    assert.equal((await collect(rowPage({ maturity: value }))).captures[0].maturityDate, value.replace(/[./]/gu, '-'));
  }
  for (const value of ['-', '없음', '해당없음']) assert.equal((await collect(rowPage({ maturity: value }))).captures[0].maturityDate, null);
  for (const maturity of ['', '1900.02.29', '2025.02.29', '2030.04.31', '0000.01.01', '2030.13.01', '2030.01.00', '2030-02.28', '2030.2.28', 'N/A']) {
    await expectError(rowPage({ maturity }), 'INVALID_MATURITY');
  }
});

test('masked or ambiguous account data and duplicate eligible accounts fail without raw errors', async () => {
  for (const account of ['123-***-789012', '1234', '123456789012345678901', '123-456-789012 (중도금)', '123456 789012']) {
    await expectError(rowPage({ account }), 'INVALID_ACCOUNT');
  }
  await expectError(pageHtml({ body: tableHtml({ rows: [['중도금', '123456789012', '1 원', '-'], ['전세', '123-456-789012', '2 원', '-']] }) }), 'DUPLICATE_ACCOUNT');
  const broken = { get location() { throw new Error('SECRET-ACCOUNT-123456789012'); } };
  assert.deepEqual(await collectShinhanLoans({ rootDocument: broken }), { ok: false, error: 'UNSUPPORTED_PAGE' });
});

test('type is derived per visible row without a mandatory product header or aggregation', async () => {
  assert.equal((await collect(rowPage({ product: '합성 전세 대출' }, { headers: ['구분', '계좌번호', '대출잔액', '만기일'] }))).captures[0].loanType, 'jeonse');
  await expectError(rowPage({ product: '중도금 전세' }), 'AMBIGUOUS_LOAN_TYPE');
  await expectError(rowPage({ product: '신용대출' }), 'NO_ELIGIBLE_LOAN');
});

test('export rejects extras, noncanonical fields and trailing-newline regex bypasses', async () => {
  const capture = (await collect()).captures[0];
  assert.throws(() => serializeSelectedCapture({ ...capture, fullAccount: '123456789012' }), /INVALID_CAPTURE/u);
  for (const field of ['accountFingerprint', 'accountLast4', 'outstandingPrincipalKrw', 'maturityDate', 'capturedAt', 'origin', 'loanType']) {
    assert.equal(isSanitizedCapture({ ...capture, [field]: `${capture[field]}\n` }), false, field);
  }
  for (const maturityDate of ['2025-02-29', '0000-01-01']) assert.equal(isSanitizedCapture({ ...capture, maturityDate }), false);
  for (const capturedAt of ['2025-02-29T00:00:00.000Z', '2030-01-01T25:00:00.000Z']) assert.equal(isSanitizedCapture({ ...capture, capturedAt }), false);
  assert.equal(isSanitizedCapture({ ...capture, bankAsOfDate: '2030-01-01' }), false);
  assert.throws(() => serializeSelectedCapture([capture]), /INVALID_CAPTURE/u);
});
