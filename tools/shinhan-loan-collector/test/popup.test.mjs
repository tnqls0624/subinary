import assert from 'node:assert/strict';
import { test } from 'node:test';

class Element {
  constructor() {
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.children = [];
    this.listeners = new Map();
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  async dispatch(type) { await this.listeners.get(type)?.(); }
  replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; }
  append(child) { this.children.push(child); }
}

test('popup requires capture, one explicit selection, confirmation and export before one local file', async () => {
  const original = Object.fromEntries(['document', 'chrome', 'Option', 'setTimeout'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalCreateUrl = URL.createObjectURL;
  const originalRevokeUrl = URL.revokeObjectURL;
  const elements = new Map(['capture', 'export', 'status', 'review', 'loan', 'confirmed', 'details', 'identity', 'principal', 'maturity', 'captured-at'].map((id) => [id, new Element()]));
  elements.get('export').disabled = true;
  const counters = { query: 0, injection: 0, download: 0 };
  const blobs = [];
  const links = [];
  const revoked = [];
  const base = {
    formatVersion: 1, provider: 'shinhan', source: 'browser_assisted', origin: 'https://bank.shinhan.com',
    pageKind: 'loan_account_list', capturedAt: '2026-11-01T00:00:00.000Z', accountFingerprint: 'a'.repeat(64),
    accountLast4: '9012', loanType: 'interim', outstandingPrincipalKrw: '9007199254740993', maturityDate: '2030-02-28', bankAsOfDate: null,
  };
  const second = { ...base, accountFingerprint: 'b'.repeat(64), accountLast4: '1098', loanType: 'jeonse', outstandingPrincipalKrw: '0', maturityDate: null };
  let nextResult = { ok: true, captures: [base, second] };
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      getElementById: (id) => elements.get(id),
      createElement: (tag) => {
        assert.equal(tag, 'a');
        const link = { click: () => { counters.download += 1; } };
        links.push(link);
        return link;
      },
    } });
    Object.defineProperty(globalThis, 'Option', { configurable: true, value: class { constructor(text, value) { this.text = text; this.value = value; } } });
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
      tabs: { query: async (query) => { counters.query += 1; assert.deepEqual(query, { active: true, currentWindow: true }); return [{ id: 7 }]; } },
      scripting: { executeScript: async (request) => {
        counters.injection += 1;
        assert.deepEqual(request.target, { tabId: 7 });
        assert.equal(request.func.name, 'collectShinhanLoans');
        return [{ frameId: 0, result: nextResult }];
      } },
    } });
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback) => { callback(); return 1; } });
    URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:synthetic-local-file'; };
    URL.revokeObjectURL = (url) => { revoked.push(url); };
    await import('../popup.js');
    assert.deepEqual(counters, { query: 0, injection: 0, download: 0 });

    await elements.get('capture').dispatch('click');
    assert.deepEqual(counters, { query: 1, injection: 1, download: 0 });
    assert.equal(elements.get('loan').children.length, 3);
    assert.equal(elements.get('loan').value, '');
    assert.equal(elements.get('export').disabled, true);
    elements.get('confirmed').checked = true;
    await elements.get('confirmed').dispatch('change');
    await elements.get('export').dispatch('click');
    assert.equal(counters.download, 0);

    elements.get('loan').value = '1';
    await elements.get('loan').dispatch('change');
    assert.equal(elements.get('confirmed').checked, false);
    assert.equal(elements.get('principal').textContent, '0원');
    await elements.get('export').dispatch('click');
    assert.equal(counters.download, 0);
    elements.get('confirmed').checked = true;
    await elements.get('confirmed').dispatch('change');
    assert.equal(elements.get('export').disabled, false);
    await elements.get('export').dispatch('click');
    assert.equal(counters.download, 1);
    assert.deepEqual(JSON.parse(await blobs[0].text()), second);
    assert.equal(links[0].download, 'shinhan-loan-capture.json');
    assert.deepEqual(revoked, ['blob:synthetic-local-file']);

    nextResult = { ok: false, error: 'SECRET_RAW_PAGE_OR_ERROR' };
    await elements.get('capture').dispatch('click');
    assert.equal(elements.get('review').hidden, true);
    assert.equal(elements.get('confirmed').checked, false);
    assert.equal(elements.get('export').disabled, true);
    assert.equal(elements.get('status').textContent.includes('SECRET_RAW_PAGE_OR_ERROR'), false);
    await elements.get('export').dispatch('click');
    assert.equal(counters.download, 1);
  } finally {
    URL.createObjectURL = originalCreateUrl;
    URL.revokeObjectURL = originalRevokeUrl;
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
