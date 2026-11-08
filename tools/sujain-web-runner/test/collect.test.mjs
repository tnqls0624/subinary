import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPageLayoutDiagnostic,
  isEligibleSujainCapturedRow,
  normalizeTableEvaluateResult,
  readSujainPages,
} from '../collect.mjs';
import {
  applyOutsideTableLookup,
  discoverOutsideTableLookup,
} from '../payment-lookup.mjs';
import { formatLayoutWarnFragment, SujainReadError } from '../policy.mjs';

/**
 * Fake Playwright page shaped like https://www.sujain.co.kr/login:
 * form#frm, input#id[name=userid], input#pw[name=userpwd], a.btnLogin (not type=submit).
 *
 * afterClick modes:
 * - navigate: leave /login without a dialog (legacy happy path)
 * - alert: failure/extra-auth dialog without leaving login
 * - success-alert: official success — land on /login/result + alert, then /index after dismiss
 */
function officialLoginPage({
  hasLoginControl = true,
  afterClick = 'navigate',
  alertMessage = '아이디 또는 비밀번호가 일치하지 않습니다.',
  hasCaptchaOrExtraAuthText = false,
  paymentRows = [{ cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' }],
  // Default a synthetic unit-items row so happy-path tests do not burn the full
  // table-wait budget on an intentionally empty options page.
  unitItemsRows = [{ cells: ['synthetic-option', '100'], headers: ['품목', '금액'], sourcePage: 'unit-items' }],
} = {}) {
  const actions = [];
  let url = 'https://www.sujain.co.kr/login';
  let dialogHandler = null;
  const filled = { id: '', pw: '' };

  function matches(selector, name) {
    const parts = selector.split(',').map((part) => part.trim());
    return parts.some((part) => part === name);
  }

  /** Official page has an <a.btnLogin>, not button/input type=submit. */
  function loginControlCount(selector) {
    if (!hasLoginControl) return 0;
    const parts = selector.split(',').map((part) => part.trim());
    // Only a.btnLogin (optionally scoped under form#frm) matches the live control.
    return parts.some((part) => /^((form#frm|form\[id=["']frm["']\])\s+)?a\.btnLogin\b/.test(part)
      || part === 'a.btnLogin'
      || part.endsWith('a.btnLogin')) ? 1 : 0;
  }

  function emitDialog(message, { afterDismissUrl = null } = {}) {
    const dialog = {
      message: () => message,
      async dismiss() {
        actions.push(['dialog-dismiss']);
        if (afterDismissUrl) {
          setTimeout(() => {
            url = afterDismissUrl;
          }, 0);
        }
      },
      async accept() {
        actions.push(['dialog-accept']);
        if (afterDismissUrl) {
          setTimeout(() => {
            url = afterDismissUrl;
          }, 0);
        }
      },
    };
    if (dialogHandler) dialogHandler(dialog);
  }

  function locator(selector, parent = null) {
    const full = parent ? `${parent} >> ${selector}` : selector;
    const self = {
      first() {
        return locator(selector, parent);
      },
      locator(child) {
        return locator(child, selector);
      },
      async count() {
        if (matches(selector, 'form#frm') || selector === 'form#frm') return 1;
        if (
          /#id\b|name="userid"|input\[name="userid"\]/.test(selector)
          || (selector.includes('#id') && !/#id[a-z]/i.test(selector))
        ) {
          return 1;
        }
        // Broad legacy type=text queries still resolve on this fixture (id field exists),
        // but scoped #id / userid is what production should prefer.
        if (/type="text"|name\*="id"|id\*="id"|name\*="user"/.test(selector)) return 1;
        if (/#pw\b|name="userpwd"|type="password"/.test(selector)) return 1;
        if (/btnLogin|type="submit"|type='submit'|has-text\("로그인"\)/.test(selector)) {
          return loginControlCount(selector);
        }
        if (/캡차|자동입력|추가|2단계|본인/.test(selector)) return hasCaptchaOrExtraAuthText ? 1 : 0;
        if (/실패|오류|틀렸|일치하지/.test(selector)) {
          return afterClick === 'alert' && /실패|오류|틀렸|일치하지|아이디|비밀번호/u.test(alertMessage) ? 1 : 0;
        }
        return 0;
      },
      async fill(value, _options) {
        actions.push(['fill', full, value]);
        if (/#id|userid|type="text"|name\*="id"|id\*="id"|name\*="user"/.test(selector)) {
          filled.id = value;
        }
        if (/#pw|userpwd|type="password"/.test(selector)) {
          filled.pw = value;
        }
      },
      async click(_options) {
        actions.push(['click', full]);
        if (loginControlCount(selector) === 0) return;
        actions.push(['login-control-activated', full]);
        if (afterClick === 'navigate') {
          // Simulate ajax success → document.frm.submit() leaving /login.
          setTimeout(() => {
            url = 'https://www.sujain.co.kr/';
          }, 0);
        } else if (afterClick === 'success-alert') {
          // Official path: form submit → /login/result, then success alert; 확인 → /index.
          url = 'https://www.sujain.co.kr/login/result';
          setTimeout(() => {
            emitDialog(alertMessage, { afterDismissUrl: 'https://www.sujain.co.kr/index' });
          }, 0);
        } else if (afterClick === 'alert') {
          emitDialog(alertMessage);
        }
      },
    };
    return self;
  }

  const page = {
    async goto(target) {
      actions.push(['goto', target]);
      url = target;
    },
    url: () => url,
    locator,
    async waitForLoadState(state, _options) {
      actions.push(['waitForLoadState', state]);
    },
    async waitForTimeout(ms) {
      actions.push(['waitForTimeout', ms]);
      await new Promise((resolve) => setTimeout(resolve, Math.min(Number(ms) || 0, 5)));
    },
    waitForEvent(event, _options) {
      actions.push(['waitForEvent', event]);
      if (event !== 'dialog') return Promise.reject(new Error('unsupported event'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('dialog timeout')), 30);
        dialogHandler = (dialog) => {
          clearTimeout(timer);
          resolve(dialog);
        };
      });
    },
    waitForURL(predicate, _options) {
      actions.push(['waitForURL']);
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          done = true;
          reject(new Error('url timeout'));
        }, 30);
        const check = () => {
          if (done) return;
          const href = url;
          const ok = typeof predicate === 'function'
            ? predicate(new URL(href))
            : String(href).includes(String(predicate));
          if (ok) {
            done = true;
            clearTimeout(timer);
            resolve();
          } else {
            setTimeout(check, 1);
          }
        };
        check();
      });
    },
    async evaluate(fn, sourcePage) {
      actions.push(['evaluate', sourcePage]);
      if (sourcePage === 'payment') return paymentRows;
      if (sourcePage === 'unit-items') return unitItemsRows;
      return [];
    },
  };

  return { actions, page, filled };
}

const job = () => ({
  provider: 'sujain',
  credentials: { loginId: 'synthetic-id', password: 'Synthetic!123' },
});

test('official login fixture (a.btnLogin, #id, #pw, form#frm) starts login without unsupported_layout', async () => {
  const f = officialLoginPage({ afterClick: 'navigate' });
  const result = await readSujainPages(f.page, job());
  assert.equal(f.actions.some((row) => row[0] === 'login-control-activated'), true);
  assert.equal(
    f.actions.some((row) => row[0] === 'click' && String(row[1]).includes('btnLogin')),
    true,
  );
  assert.equal(f.filled.id, 'synthetic-id');
  assert.equal(f.filled.pw, 'Synthetic!123');
  assert.ok(result.rows.length >= 1);
  assert.equal(f.actions.some((row) => row[0] === 'waitForURL'), true);
  assert.equal(f.actions.some((row) => row[0] === 'waitForEvent' && row[1] === 'dialog'), true);
});

test('missing login control still throws unsupported_layout before any submit', async () => {
  const f = officialLoginPage({ hasLoginControl: false });
  await assert.rejects(
    () => readSujainPages(f.page, job()),
    (error) => error instanceof SujainReadError && error.code === 'unsupported_layout',
  );
  assert.equal(f.actions.some((row) => row[0] === 'login-control-activated'), false);
  assert.equal(f.actions.some((row) => row[0] === 'click'), false);
});

test('failure alert after ajax login maps to credentials_invalid', async () => {
  const f = officialLoginPage({
    afterClick: 'alert',
    alertMessage: '아이디 또는 비밀번호가 일치하지 않습니다.',
  });
  await assert.rejects(
    () => readSujainPages(f.page, job()),
    (error) => error instanceof SujainReadError && error.code === 'credentials_invalid',
  );
  assert.equal(f.actions.some((row) => row[0] === 'login-control-activated'), true);
  assert.equal(f.actions.some((row) => row[0] === 'dialog-dismiss'), true);
  assert.equal(f.actions.some((row) => row[0] === 'goto' && String(row[1]).includes('payment')), false);
});

test('official success alert on /login/result is not authentication_required', async () => {
  const f = officialLoginPage({
    afterClick: 'success-alert',
    alertMessage: '정상적으로 로그인 되었습니다.',
  });
  const result = await readSujainPages(f.page, job());
  assert.equal(f.actions.some((row) => row[0] === 'login-control-activated'), true);
  assert.equal(f.actions.some((row) => row[0] === 'dialog-dismiss'), true);
  assert.ok(result.rows.length >= 1);
  assert.equal(
    f.actions.some((row) => row[0] === 'goto' && String(row[1]).includes('payment')),
    true,
  );
});

test('extra-auth dialog after login click stays authentication_required', async () => {
  const f = officialLoginPage({
    afterClick: 'alert',
    alertMessage: '추가 인증이 필요합니다. 본인인증을 진행해 주세요.',
  });
  await assert.rejects(
    () => readSujainPages(f.page, job()),
    (error) => error instanceof SujainReadError && error.code === 'authentication_required',
  );
  assert.equal(f.actions.some((row) => row[0] === 'dialog-dismiss'), true);
  assert.equal(f.actions.some((row) => row[0] === 'goto' && String(row[1]).includes('payment')), false);
});

test('captcha or 본인인증 page text after login stays authentication_required', async () => {
  const f = officialLoginPage({
    afterClick: 'navigate',
    hasCaptchaOrExtraAuthText: true,
  });
  await assert.rejects(
    () => readSujainPages(f.page, job()),
    (error) => error instanceof SujainReadError && error.code === 'authentication_required',
  );
  assert.equal(f.actions.some((row) => row[0] === 'goto' && String(row[1]).includes('payment')), false);
});

test('scoped selectors prefer #id/#pw over later type=text fields', async () => {
  const f = officialLoginPage({ afterClick: 'navigate' });
  await readSujainPages(f.page, job());
  const fills = f.actions.filter((row) => row[0] === 'fill');
  assert.ok(fills.length >= 2);
  assert.match(String(fills[0][1]), /#id|userid/);
  assert.match(String(fills[1][1]), /#pw|userpwd/);
});

test('long synthetic cell and header strings are truncated to API schema caps', async () => {
  const longCell = `synthetic-cell-${'x'.repeat(250)}`;
  const longHeader = `synthetic-header-${'y'.repeat(120)}`;
  assert.ok(longCell.length > 200);
  assert.ok(longHeader.length > 100);
  const f = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: [{
      cells: [longCell, '1,000'],
      headers: [longHeader, '금액'],
      sourcePage: 'payment',
    }],
  });
  const result = await readSujainPages(f.page, job());
  const payment = result.rows.find((row) => row.sourcePage === 'payment');
  assert.ok(payment);
  assert.equal(payment.cells[0].length, 200);
  assert.equal(payment.headers[0].length, 100);
  assert.equal(payment.cells[1], '1,000');
  assert.equal(payment.headers[1], '금액');
});

test('records scrape_payment stage before table evaluate without leaking page text', async () => {
  const diagnostics = { stage: 'context' };
  const f = officialLoginPage({ afterClick: 'navigate' });
  const originalEvaluate = f.page.evaluate.bind(f.page);
  f.page.evaluate = async (fn, sourcePage) => {
    assert.equal(diagnostics.stage, 'scrape_payment');
    if (sourcePage === 'payment') {
      const err = new Error('Execution context was destroyed synthetic page text');
      err.name = 'Error';
      throw err;
    }
    return originalEvaluate(fn, sourcePage);
  };
  await assert.rejects(
    () => readSujainPages(f.page, job(), diagnostics),
    (error) => error instanceof Error
      && error.name === 'Error'
      && !String(error.message).includes('수자인')
      && diagnostics.stage === 'scrape_payment',
  );
});

test('records login stage while fillLogin runs', async () => {
  const diagnostics = { stage: 'context' };
  const f = officialLoginPage({ hasLoginControl: false });
  await assert.rejects(
    () => readSujainPages(f.page, job(), diagnostics),
    (error) => error instanceof SujainReadError && error.code === 'unsupported_layout',
  );
  assert.equal(diagnostics.stage, 'login');
});

test('unit-items evaluate survives one destroyed execution context after goto', async () => {
  // Production after #30: scrape_unit_items + errorName=Error while payment rows already
  // reached evaluate. Playwright throws a plain Error when a follow-up navigation
  // destroys the document mid-evaluate; retry after the next document settles.
  const unitRows = [{
    cells: ['synthetic-option', '500'],
    headers: ['품목', '금액'],
    sourcePage: 'unit-items',
  }];
  const f = officialLoginPage({ afterClick: 'navigate', unitItemsRows: unitRows });
  let unitEvalAttempts = 0;
  const originalEvaluate = f.page.evaluate.bind(f.page);
  f.page.evaluate = async (fn, sourcePage) => {
    if (sourcePage === 'unit-items') {
      unitEvalAttempts += 1;
      if (unitEvalAttempts === 1) {
        const err = new Error('Execution context was destroyed, most likely because of a navigation.');
        err.name = 'Error';
        throw err;
      }
    }
    return originalEvaluate(fn, sourcePage);
  };

  const diagnostics = { stage: 'context' };
  const result = await readSujainPages(f.page, job(), diagnostics);
  assert.equal(unitEvalAttempts, 2);
  assert.equal(diagnostics.stage, 'scrape_unit_items');
  assert.ok(result.rows.some((row) => row.sourcePage === 'payment'));
  assert.ok(result.rows.some((row) => row.sourcePage === 'unit-items' && row.cells[0] === 'synthetic-option'));
  assert.equal(
    f.actions.some((row) => row[0] === 'waitForLoadState'),
    true,
  );
  assert.equal(
    f.actions.some((row) => row[0] === 'goto' && String(row[1]).includes('unit-items')),
    true,
  );
});

test('unit-items destroyed-context retry that lands on login is authentication_required', async () => {
  const f = officialLoginPage({ afterClick: 'navigate' });
  let unitEvalAttempts = 0;
  f.page.evaluate = async (_fn, sourcePage) => {
    if (sourcePage !== 'unit-items') {
      return [{ cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' }];
    }
    unitEvalAttempts += 1;
    const err = new Error('Execution context was destroyed, most likely because of a navigation.');
    err.name = 'Error';
    // Simulate the follow-up navigation bouncing the session back to login.
    f.page.url = () => 'https://www.sujain.co.kr/login';
    throw err;
  };
  // After the destroyed-context wait, url() already reports login.
  const originalWait = f.page.waitForLoadState.bind(f.page);
  f.page.waitForLoadState = async (state, options) => {
    await originalWait(state, options);
  };

  await assert.rejects(
    () => readSujainPages(f.page, job()),
    (error) => error instanceof SujainReadError && error.code === 'authentication_required',
  );
  assert.equal(unitEvalAttempts, 1);
});

test('non-navigation evaluate Error on unit-items still propagates as runner_exception shape', async () => {
  const f = officialLoginPage({ afterClick: 'navigate' });
  f.page.evaluate = async (_fn, sourcePage) => {
    if (sourcePage === 'payment') {
      return [{ cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' }];
    }
    const err = new Error('synthetic unrelated evaluate failure');
    err.name = 'Error';
    throw err;
  };
  await assert.rejects(
    () => readSujainPages(f.page, job()),
    (error) => error instanceof Error
      && error.name === 'Error'
      && String(error.message) === 'synthetic unrelated evaluate failure',
  );
});

test('unit-items destroyed-context retry is only once — second destroy still fails', async () => {
  const f = officialLoginPage({ afterClick: 'navigate' });
  let unitEvalAttempts = 0;
  f.page.evaluate = async (_fn, sourcePage) => {
    if (sourcePage === 'payment') {
      return [{ cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' }];
    }
    unitEvalAttempts += 1;
    const err = new Error('Execution context was destroyed, most likely because of a navigation.');
    err.name = 'Error';
    throw err;
  };
  await assert.rejects(
    () => readSujainPages(f.page, job()),
    (error) => error instanceof Error
      && error.name === 'Error'
      && /Execution context was destroyed/u.test(String(error.message)),
  );
  assert.equal(unitEvalAttempts, 2);
});

test('waits when first evaluate is empty then returns rows after AJAX-like fill', async () => {
  // After #31, load + one evaluate can succeed with 0 data rows while the table is
  // still empty; production then stored last_preview.items=[] and looked like
  // «바꿀 항목이 없어요.» Re-evaluate until a non-empty data cell appears.
  const filledPayment = [{
    cells: ['계약금', '1,000'],
    headers: ['구분', '금액'],
    sourcePage: 'payment',
  }];
  const filledUnit = [{
    cells: ['synthetic-option', '500'],
    headers: ['품목', '금액'],
    sourcePage: 'unit-items',
  }];
  const f = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: [],
    unitItemsRows: [],
  });
  let paymentEvals = 0;
  f.page.evaluate = async (_fn, sourcePage) => {
    if (sourcePage === 'payment') {
      paymentEvals += 1;
      return paymentEvals >= 3 ? filledPayment : [];
    }
    return filledUnit;
  };

  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '2000';
  let result;
  try {
    result = await readSujainPages(f.page, job());
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }
  assert.ok(paymentEvals >= 3);
  assert.ok(result.rows.some((row) => row.cells[0] === '계약금'));
  assert.equal(
    f.actions.some((row) => row[0] === 'waitForTimeout' || row[0] === 'waitForLoadState'),
    true,
  );
});

test('destroyed-context then empty then data still yields rows', async () => {
  const unitRows = [{
    cells: ['synthetic-option', '500'],
    headers: ['품목', '금액'],
    sourcePage: 'unit-items',
  }];
  const f = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: [{ cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' }],
    unitItemsRows: [],
  });
  let unitEvalAttempts = 0;
  f.page.evaluate = async (_fn, sourcePage) => {
    if (sourcePage === 'payment') {
      return [{ cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' }];
    }
    unitEvalAttempts += 1;
    if (unitEvalAttempts === 1) {
      const err = new Error('Execution context was destroyed, most likely because of a navigation.');
      err.name = 'Error';
      throw err;
    }
    // Post-destroy document is briefly empty (AJAX not yet painted).
    if (unitEvalAttempts === 2) return [];
    return unitRows;
  };

  const result = await readSujainPages(f.page, job());
  assert.ok(unitEvalAttempts >= 3);
  assert.ok(result.rows.some((row) => row.sourcePage === 'unit-items' && row.cells[0] === 'synthetic-option'));
});

test('both pages still empty after waiting is unsupported_layout, not silent empty success', async () => {
  const f = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: [],
    unitItemsRows: [],
  });
  // Force short wait budget via env so the test does not sleep the full production timeout.
  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '50';
  try {
    await assert.rejects(
      () => readSujainPages(f.page, job()),
      (error) => error instanceof SujainReadError && error.code === 'unsupported_layout',
    );
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }
  assert.equal(
    f.actions.some((row) => row[0] === 'goto' && String(row[1]).includes('unit-items')),
    true,
  );
});

test('member-profile/contact captured rows are not eligible payment or option tables', () => {
  assert.equal(
    isEligibleSujainCapturedRow({
      headers: ['항목', '내용'],
      cells: ['이름', '합성 회원'],
      sourcePage: 'unit-items',
    }),
    false,
  );
  assert.equal(
    isEligibleSujainCapturedRow({
      headers: ['품목', '금액'],
      cells: ['합성 항목 A', '500,000'],
      sourcePage: 'unit-items',
    }),
    true,
  );
  assert.equal(
    isEligibleSujainCapturedRow({
      headers: ['구분', '금액'],
      cells: ['계약금', '1,000'],
      sourcePage: 'payment',
    }),
    true,
  );
});

test('contact-only tables on both pages are unsupported_layout, not scrape success', async () => {
  const contactPayment = [
    { cells: ['이름', '합성 회원'], headers: ['항목', '내용'], sourcePage: 'payment' },
    { cells: ['휴대전화', '000-0000-0000'], headers: ['항목', '내용'], sourcePage: 'payment' },
  ];
  const contactUnit = [
    { cells: ['주소', '합성 주소'], headers: ['항목', '내용'], sourcePage: 'unit-items' },
    { cells: ['이메일', 'synthetic@example.com'], headers: ['항목', '내용'], sourcePage: 'unit-items' },
  ];
  const f = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: contactPayment,
    unitItemsRows: contactUnit,
  });
  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '50';
  try {
    await assert.rejects(
      () => readSujainPages(f.page, job()),
      (error) => error instanceof SujainReadError && error.code === 'unsupported_layout',
    );
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }
});

test('unsupported_layout diagnostics include table counts and header texts only', async () => {
  const contactPayment = [
    { cells: ['이름', '합성 회원'], headers: ['항목', '내용'], sourcePage: 'payment' },
    { cells: ['휴대전화', '000-0000-0000'], headers: ['항목', '내용'], sourcePage: 'payment' },
  ];
  const contactUnit = [
    { cells: ['주소', '합성 주소'], headers: ['항목', '내용'], sourcePage: 'unit-items' },
    { cells: ['이메일', 'synthetic@example.com'], headers: ['항목', '내용'], sourcePage: 'unit-items' },
  ];
  const f = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: contactPayment,
    unitItemsRows: contactUnit,
  });
  const diagnostics = { stage: 'context', layout: {} };
  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '50';
  try {
    await assert.rejects(
      () => readSujainPages(f.page, job(), diagnostics),
      (error) => error instanceof SujainReadError && error.code === 'unsupported_layout',
    );
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }

  assert.equal(diagnostics.stage, 'scrape_unit_items');
  assert.equal(diagnostics.layout.payment.tableCount, 1);
  assert.deepEqual(diagnostics.layout.payment.tableHeaders, [['항목', '내용']]);
  assert.equal(diagnostics.layout.payment.rawRowCount, 2);
  assert.equal(diagnostics.layout.payment.eligibleRowCount, 0);
  assert.deepEqual(diagnostics.layout.payment.tables, [
    { rawRowCount: 2, preSkipRowCount: 0, formControlCount: 0 },
  ]);
  assert.equal(diagnostics.layout.payment.outsideTableFormControlCount, 0);
  assert.deepEqual(diagnostics.layout.payment.outsideTableFormControls, {
    visibleInput: 0,
    visibleSelect: 0,
    visibleTextarea: 0,
    hidden: 0,
    other: 0,
  });
  assert.equal(diagnostics.layout.payment.iframeCount, 0);
  assert.equal(diagnostics.layout.payment.pagePath, 'https://www.sujain.co.kr/mypage/payment');
  assert.equal(diagnostics.layout.payment.lookupNonPlaceholderOptionCount, 0);
  assert.equal(diagnostics.layout.payment.lookupClicked, false);
  assert.equal(diagnostics.layout.payment.lookupBodyRowsAppeared, false);
  assert.equal(diagnostics.layout['unit-items'].tableCount, 1);
  assert.deepEqual(diagnostics.layout['unit-items'].tableHeaders, [['항목', '내용']]);
  assert.equal(diagnostics.layout['unit-items'].rawRowCount, 2);
  assert.equal(diagnostics.layout['unit-items'].eligibleRowCount, 0);
  assert.deepEqual(diagnostics.layout['unit-items'].tables, [
    { rawRowCount: 2, preSkipRowCount: 0, formControlCount: 0 },
  ]);
  assert.equal(
    diagnostics.layout['unit-items'].pagePath,
    'https://www.sujain.co.kr/mypage/unit-items',
  );

  const serialized = JSON.stringify(diagnostics.layout);
  const warnFragment = formatLayoutWarnFragment(diagnostics.layout);
  for (const leak of [
    '합성 회원',
    '000-0000-0000',
    '합성 주소',
    'synthetic@example.com',
    '이름',
    '휴대전화',
    '주소',
    '이메일',
  ]) {
    assert.equal(serialized.includes(leak), false, `layout JSON leaked ${leak}`);
    assert.equal(warnFragment.includes(leak), false, `warn fragment leaked ${leak}`);
  }
  assert.match(
    warnFragment,
    /layout=payment:t=1;h=\[항목\|내용\];raw=2;eligible=0;tables=\[r=2,p=0,i=0\];out=0\[vi=0,vs=0,vt=0,h=0,o=0\];lookup=np=0;click=0;rows=0;ifr=0;path=https:\/\/www\.sujain\.co\.kr\/mypage\/payment/,
  );
  assert.match(
    warnFragment,
    /unit-items:t=1;h=\[항목\|내용\];raw=2;eligible=0;tables=\[r=2,p=0,i=0\];out=0\[vi=0,vs=0,vt=0,h=0,o=0\];lookup=np=0;click=0;rows=0;ifr=0;path=https:\/\/www\.sujain\.co\.kr\/mypage\/unit-items/,
  );
  // Layout diagnostic object never carries a cells key.
  assert.equal(Object.hasOwn(diagnostics.layout.payment, 'cells'), false);
  assert.equal(Object.hasOwn(diagnostics.layout['unit-items'], 'cells'), false);
});

test('layout diagnostic builder never copies cell values from a capture payload', () => {
  const diagnostic = buildPageLayoutDiagnostic({
    sourcePage: 'payment',
    tableCount: 1,
    tableHeaders: [['항목', '금액']],
    rawRowCount: 1,
    eligibleRowCount: 0,
    tables: [{ rawRowCount: 1, preSkipRowCount: 2, formControlCount: 4 }],
    outsideTableFormControlCount: 1,
    outsideTableFormControls: {
      visibleInput: 0,
      visibleSelect: 1,
      visibleTextarea: 0,
      hidden: 0,
      other: 0,
    },
    iframeCount: 0,
    iframePaths: [],
    pagePath: 'https://www.sujain.co.kr/mypage/payment?tok=SECRET',
    lookupNonPlaceholderOptionCount: 0,
    lookupClicked: false,
    lookupBodyRowsAppeared: false,
    cells: ['합성 회원', '000-0000-0000', '500,000'],
    rows: [{ cells: ['합성 회원', '500,000'], headers: ['항목', '금액'] }],
  });
  assert.ok(diagnostic);
  assert.equal(diagnostic.tableCount, 1);
  assert.deepEqual(diagnostic.tableHeaders, [['항목', '금액']]);
  assert.equal(diagnostic.rawRowCount, 1);
  assert.equal(diagnostic.eligibleRowCount, 0);
  assert.deepEqual(diagnostic.tables, [
    { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 4 },
  ]);
  assert.equal(diagnostic.outsideTableFormControlCount, 1);
  assert.deepEqual(diagnostic.outsideTableFormControls, {
    visibleInput: 0,
    visibleSelect: 1,
    visibleTextarea: 0,
    hidden: 0,
    other: 0,
  });
  assert.equal(diagnostic.pagePath, 'https://www.sujain.co.kr/mypage/payment');
  assert.equal(Object.hasOwn(diagnostic, 'cells'), false);
  assert.equal(Object.hasOwn(diagnostic, 'rows'), false);
  const text = JSON.stringify(diagnostic);
  assert.equal(text.includes('합성 회원'), false);
  assert.equal(text.includes('000-0000-0000'), false);
  assert.equal(text.includes('500,000'), false);
  assert.equal(text.includes('SECRET'), false);
});

test('normalizeTableEvaluateResult accepts production object shape and array fixtures', () => {
  const fromObject = normalizeTableEvaluateResult({
    tableCount: 2,
    tableHeaders: [['항목', '내용'], ['구분', '금액']],
    tables: [
      { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 0 },
      { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 8 },
    ],
    outsideTableFormControlCount: 3,
    outsideTableFormControls: {
      visibleInput: 1,
      visibleSelect: 1,
      visibleTextarea: 0,
      hidden: 1,
      other: 0,
    },
    iframeCount: 1,
    iframePaths: ['https://www.sujain.co.kr/embed?token=SECRET'],
    rows: [
      { cells: ['이름', '합성 회원'], headers: ['항목', '내용'], sourcePage: 'payment' },
      { cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' },
    ],
  });
  assert.equal(fromObject.tableCount, 2);
  assert.deepEqual(fromObject.tableHeaders, [['항목', '내용'], ['구분', '금액']]);
  assert.deepEqual(fromObject.tables, [
    { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 0 },
    { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 8 },
  ]);
  assert.equal(fromObject.outsideTableFormControlCount, 3);
  assert.deepEqual(fromObject.outsideTableFormControls, {
    visibleInput: 1,
    visibleSelect: 1,
    visibleTextarea: 0,
    hidden: 1,
    other: 0,
  });
  assert.equal(fromObject.iframeCount, 1);
  assert.deepEqual(fromObject.iframePaths, ['https://www.sujain.co.kr/embed']);
  assert.equal(fromObject.rows.length, 2);

  const fromArray = normalizeTableEvaluateResult([
    { cells: ['이름', '합성 회원'], headers: ['항목', '내용'], sourcePage: 'payment' },
  ]);
  assert.equal(fromArray.tableCount, 1);
  assert.deepEqual(fromArray.tableHeaders, [['항목', '내용']]);
  assert.deepEqual(fromArray.tables, [
    { rawRowCount: 1, preSkipRowCount: 0, formControlCount: 0 },
  ]);
  assert.equal(fromArray.outsideTableFormControlCount, 0);
  assert.deepEqual(fromArray.outsideTableFormControls, {
    visibleInput: 0,
    visibleSelect: 0,
    visibleTextarea: 0,
    hidden: 0,
    other: 0,
  });
  assert.equal(fromArray.iframeCount, 0);
  assert.equal(fromArray.rows.length, 1);
});

test('input-backed payment rows from evaluate object are kept as eligible scrape rows', async () => {
  const paymentEvaluate = {
    tableCount: 2,
    tableHeaders: [
      ['회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금'],
      ['이름*'],
    ],
    tables: [
      { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 8 },
      { rawRowCount: 4, preSkipRowCount: 5, formControlCount: 0 },
    ],
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
    rows: [
      {
        cells: ['1', '2026-06-01', '10000000', '2026-06-02', '9000000', '0', '0', '9000000'],
        headers: ['회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금'],
        sourcePage: 'payment',
      },
      { cells: ['합성 회원'], headers: ['이름*'], sourcePage: 'payment' },
      { cells: ['000-0000-0000'], headers: ['이름*'], sourcePage: 'payment' },
      { cells: ['합성 주소'], headers: ['이름*'], sourcePage: 'payment' },
      { cells: ['synthetic@example.com'], headers: ['이름*'], sourcePage: 'payment' },
    ],
  };
  const f = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: paymentEvaluate,
    unitItemsRows: [
      { cells: ['합성 항목 A', '500'], headers: ['품목', '금액'], sourcePage: 'unit-items' },
    ],
  });
  const diagnostics = { stage: 'context', layout: {} };
  const result = await readSujainPages(f.page, job(), diagnostics);
  assert.ok(result.rows.some((row) => row.sourcePage === 'payment' && row.cells[2] === '10000000'));
  assert.equal(result.rows.some((row) => row.cells[0] === '합성 회원'), false);
  assert.equal(diagnostics.layout.payment.eligibleRowCount, 1);
  assert.deepEqual(diagnostics.layout.payment.tables, [
    { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 8 },
    { rawRowCount: 4, preSkipRowCount: 5, formControlCount: 0 },
  ]);
  assert.equal(diagnostics.layout.payment.pagePath, 'https://www.sujain.co.kr/mypage/payment');
  const warnFragment = formatLayoutWarnFragment(diagnostics.layout);
  assert.match(warnFragment, /tables=\[r=1,p=2,i=8\],\[r=4,p=5,i=0\]/);
  assert.match(warnFragment, /path=https:\/\/www\.sujain\.co\.kr\/mypage\/payment/);
  assert.equal(warnFragment.includes('10000000'), false);
  assert.equal(warnFragment.includes('합성 회원'), false);
});

test('contact rows do not hide a later eligible option table during the wait', async () => {
  const f = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: [{ cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' }],
    unitItemsRows: [],
  });
  let unitEvalAttempts = 0;
  f.page.evaluate = async (_fn, sourcePage) => {
    if (sourcePage === 'payment') {
      return [{ cells: ['계약금', '1,000'], headers: ['구분', '금액'], sourcePage: 'payment' }];
    }
    unitEvalAttempts += 1;
    if (unitEvalAttempts === 1) {
      return [
        { cells: ['이름', '합성 회원'], headers: ['항목', '내용'], sourcePage: 'unit-items' },
      ];
    }
    return [
      { cells: ['이름', '합성 회원'], headers: ['항목', '내용'], sourcePage: 'unit-items' },
      { cells: ['합성 항목 A', '500,000'], headers: ['품목', '금액'], sourcePage: 'unit-items' },
    ];
  };

  const result = await readSujainPages(f.page, job());
  assert.ok(unitEvalAttempts >= 2);
  assert.equal(
    result.rows.some((row) => row.sourcePage === 'unit-items' && row.cells[0] === '이름'),
    false,
  );
  assert.ok(
    result.rows.some((row) => row.sourcePage === 'unit-items' && row.cells[0] === '합성 항목 A'),
  );
});

/** Synthetic payment headers — mirrors official layout shape without real PII. */
const SYNTHETIC_PAYMENT_HEADERS = [
  '회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금',
];

function syntheticPaymentRow(amountCell = '1000000') {
  return {
    cells: ['1', '2026-01-01', amountCell, '2026-01-02', amountCell, '0', '0', amountCell],
    headers: SYNTHETIC_PAYMENT_HEADERS,
    sourcePage: 'payment',
  };
}

function syntheticPaymentEvaluate(rows) {
  return {
    tableCount: 2,
    tableHeaders: [SYNTHETIC_PAYMENT_HEADERS, ['이름*']],
    tables: [
      { rawRowCount: rows.length, preSkipRowCount: rows.length + 1, formControlCount: 0 },
      { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 0 },
    ],
    outsideTableFormControlCount: 2,
    outsideTableFormControls: {
      visibleInput: 0,
      visibleSelect: 1,
      visibleTextarea: 0,
      hidden: 0,
      other: 1,
    },
    iframeCount: 0,
    iframePaths: [],
    rows: [
      ...rows,
      { cells: ['합성 회원'], headers: ['이름*'], sourcePage: 'payment' },
    ],
  };
}

/**
 * Login fixture with an outside-table select + adjacent 조회. Payment table
 * body rows appear only after a non-placeholder option is selected and 조회
 * is clicked. Option labels/values are synthetic secrets used only to assert
 * they never leak into diagnostics.
 */
function paymentLookupLoginPage({
  options = [
    { value: '', label: 'SYNTHETIC_PLACEHOLDER_LABEL_DO_NOT_LEAK' },
    { value: 'synth-unit-a', label: 'SYNTHETIC_OPTION_LABEL_ALPHA' },
  ],
  /** Map option value → payment body rows after that option + 조회. */
  rowsByValue = {
    'synth-unit-a': [syntheticPaymentRow('1000000')],
  },
  /** When true, goto(unit-items) lands on /mypage/payment. */
  unitItemsRedirectsToPayment = false,
  unitItemsRows = [{ cells: ['synthetic-option', '100'], headers: ['품목', '금액'], sourcePage: 'unit-items' }],
} = {}) {
  const base = officialLoginPage({
    afterClick: 'navigate',
    paymentRows: syntheticPaymentEvaluate([]),
    unitItemsRows,
  });

  let selectedIndex = 0;
  let lookupClicked = false;
  let lastAppliedValue = null;

  const optionNodes = options.map((opt) => ({
    value: opt.value,
    textContent: opt.label,
    label: opt.label,
    getAttribute(key) {
      return key === 'value' ? opt.value : null;
    },
  }));

  const inquire = {
    tagName: 'BUTTON',
    textContent: '조회',
    type: 'button',
    parentElement: null,
    nextElementSibling: null,
    clickCalls: 0,
    click() {
      this.clickCalls += 1;
      lookupClicked = true;
      // Read the select's current index — apply sets it before click.
      lastAppliedValue = optionNodes[select.selectedIndex]?.value ?? null;
    },
    querySelectorAll() {
      return [];
    },
  };

  const select = {
    tagName: 'SELECT',
    options: optionNodes,
    selectedIndex: 0,
    value: optionNodes[0]?.value ?? '',
    hidden: false,
    style: {},
    parentElement: null,
    nextElementSibling: inquire,
    parentNode: null,
    getAttribute(key) {
      return key === 'hidden' ? null : null;
    },
    closest() {
      return null;
    },
    querySelectorAll(sel) {
      return sel === 'option' ? optionNodes : [];
    },
    dispatchEvent() {
      return true;
    },
  };

  const row = {
    tagName: 'DIV',
    querySelectorAll(sel) {
      if (!/a|button|input/i.test(sel)) return [];
      return [inquire];
    },
  };
  select.parentElement = row;
  inquire.parentElement = row;

  const lookupDoc = {
    querySelectorAll(sel) {
      if (sel === 'select') return [select];
      if (sel === 'a, button, input') return [inquire];
      if (sel === 'table') return [];
      return [];
    },
  };

  const originalGoto = base.page.goto.bind(base.page);
  base.page.goto = async (target) => {
    await originalGoto(target);
    if (unitItemsRedirectsToPayment && String(target).includes('unit-items')) {
      // Simulate official redirect of unit-items → payment.
      base.page.url = () => 'https://www.sujain.co.kr/mypage/payment';
      base.actions.push(['redirect', 'https://www.sujain.co.kr/mypage/payment']);
    }
  };

  base.page.evaluate = async (fn, arg) => {
    base.actions.push(['evaluate', typeof arg === 'string' ? arg : (arg && typeof arg === 'object' ? 'object' : arg)]);
    if (fn === discoverOutsideTableLookup) {
      // Playwright: page.evaluate(fn) → fn() with page document. Pass lookupDoc
      // as the optional Node-test second/first doc the same way production uses
      // document when no arg is provided — invoke with no plan arg.
      const previous = globalThis.document;
      globalThis.document = lookupDoc;
      try {
        return discoverOutsideTableLookup();
      } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
      }
    }
    if (fn === applyOutsideTableLookup) {
      // Playwright: page.evaluate(fn, plan) → fn(plan). Optional doc is 2nd arg
      // for Node only (same pattern as captureSujainTables).
      const result = applyOutsideTableLookup(arg, lookupDoc);
      selectedIndex = select.selectedIndex;
      return result;
    }
    // capture / table evaluate
    const sourcePage = arg;
    if (sourcePage === 'payment' || (sourcePage === 'unit-items' && unitItemsRedirectsToPayment)) {
      if (lookupClicked && lastAppliedValue && rowsByValue[lastAppliedValue]) {
        return syntheticPaymentEvaluate(rowsByValue[lastAppliedValue]);
      }
      return syntheticPaymentEvaluate([]);
    }
    if (sourcePage === 'unit-items') return unitItemsRows;
    return [];
  };

  return {
    ...base,
    secrets: options.flatMap((opt) => [opt.value, opt.label]).filter(Boolean),
    getLookupState: () => ({ selectedIndex, lookupClicked, lastAppliedValue, inquireClicks: inquire.clickCalls }),
  };
}

test('non-first non-empty select option + 조회 fills payment table for existing capture', async () => {
  const f = paymentLookupLoginPage();
  const diagnostics = { stage: 'context', layout: {} };
  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '200';
  let result;
  try {
    result = await readSujainPages(f.page, job(), diagnostics);
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }

  assert.ok(result.rows.some((row) => row.sourcePage === 'payment' && row.cells[2] === '1000000'));
  assert.equal(result.rows.some((row) => row.cells[0] === '합성 회원'), false);
  assert.equal(diagnostics.layout.payment.lookupNonPlaceholderOptionCount, 1);
  assert.equal(diagnostics.layout.payment.lookupClicked, true);
  assert.equal(diagnostics.layout.payment.lookupBodyRowsAppeared, true);
  assert.equal(f.getLookupState().inquireClicks >= 1, true);
});

test('조회 without changing a placeholder-only select does not invent payment rows', async () => {
  const f = paymentLookupLoginPage({
    options: [
      { value: '', label: 'SYNTHETIC_PLACEHOLDER_LABEL_DO_NOT_LEAK' },
      { value: '   ', label: 'SYNTHETIC_WHITESPACE_PLACEHOLDER' },
    ],
    rowsByValue: {},
    unitItemsRows: [],
  });
  const diagnostics = { stage: 'context', layout: {} };
  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '50';
  try {
    await assert.rejects(
      () => readSujainPages(f.page, job(), diagnostics),
      (error) => error instanceof SujainReadError && error.code === 'unsupported_layout',
    );
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }
  assert.equal(f.getLookupState().inquireClicks, 0);
  assert.equal(diagnostics.layout.payment.lookupNonPlaceholderOptionCount, 0);
  assert.equal(diagnostics.layout.payment.lookupClicked, false);
  assert.equal(diagnostics.layout.payment.lookupBodyRowsAppeared, false);
});

test('option labels and values never appear in lookup diagnostics or warn fragment', async () => {
  const f = paymentLookupLoginPage({
    options: [
      { value: '', label: 'SYNTHETIC_PLACEHOLDER_LABEL_DO_NOT_LEAK' },
      { value: 'synth-secret-value', label: 'SYNTHETIC_OPTION_LABEL_SECRET' },
    ],
    rowsByValue: {
      'synth-secret-value': [syntheticPaymentRow('2000000')],
    },
  });
  const diagnostics = { stage: 'context', layout: {} };
  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '200';
  try {
    await readSujainPages(f.page, job(), diagnostics);
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }

  const serialized = JSON.stringify(diagnostics.layout);
  const warnFragment = formatLayoutWarnFragment(diagnostics.layout);
  const actionText = JSON.stringify(f.actions);
  for (const leak of f.secrets) {
    assert.equal(serialized.includes(leak), false, `layout leaked ${leak}`);
    assert.equal(warnFragment.includes(leak), false, `warn leaked ${leak}`);
    assert.equal(actionText.includes(leak), false, `actions leaked ${leak}`);
  }
  assert.match(warnFragment, /lookup=np=1;click=1;rows=1/);
});

test('multiple non-placeholder options are looked up and combined without double personal rows', async () => {
  const f = paymentLookupLoginPage({
    options: [
      { value: '', label: 'SYNTHETIC_PLACEHOLDER_LABEL_DO_NOT_LEAK' },
      { value: 'synth-a', label: 'SYNTHETIC_OPTION_LABEL_ALPHA' },
      { value: 'synth-b', label: 'SYNTHETIC_OPTION_LABEL_BETA' },
    ],
    rowsByValue: {
      'synth-a': [syntheticPaymentRow('1111111')],
      'synth-b': [syntheticPaymentRow('2222222')],
    },
  });
  const diagnostics = { stage: 'context', layout: {} };
  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '200';
  let result;
  try {
    result = await readSujainPages(f.page, job(), diagnostics);
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }

  const paymentAmounts = result.rows
    .filter((row) => row.sourcePage === 'payment')
    .map((row) => row.cells[2]);
  assert.deepEqual(paymentAmounts.sort(), ['1111111', '2222222']);
  assert.equal(diagnostics.layout.payment.lookupNonPlaceholderOptionCount, 2);
  assert.equal(diagnostics.layout.payment.lookupClicked, true);
  assert.equal(f.getLookupState().inquireClicks, 2);
});

test('unit-items redirecting to payment does not double-count after payment lookup', async () => {
  const f = paymentLookupLoginPage({
    unitItemsRedirectsToPayment: true,
    unitItemsRows: syntheticPaymentEvaluate([syntheticPaymentRow('1000000')]),
  });
  const diagnostics = { stage: 'context', layout: {} };
  const previous = process.env.SUJAIN_TABLE_WAIT_MS;
  process.env.SUJAIN_TABLE_WAIT_MS = '200';
  let result;
  try {
    result = await readSujainPages(f.page, job(), diagnostics);
  } finally {
    if (previous === undefined) delete process.env.SUJAIN_TABLE_WAIT_MS;
    else process.env.SUJAIN_TABLE_WAIT_MS = previous;
  }

  const paymentRows = result.rows.filter((row) => row.sourcePage === 'payment');
  assert.equal(paymentRows.length, 1);
  assert.equal(result.rows.filter((row) => row.sourcePage === 'unit-items').length, 0);
  assert.equal(diagnostics.layout.payment.lookupClicked, true);
  assert.ok(diagnostics.layout['unit-items']);
  assert.equal(diagnostics.layout['unit-items'].pagePath, 'https://www.sujain.co.kr/mypage/payment');
  assert.equal(diagnostics.layout['unit-items'].lookupClicked, false);
});
