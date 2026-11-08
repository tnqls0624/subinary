import assert from 'node:assert/strict';
import test from 'node:test';
import { captureSujainTables } from '../table-capture.mjs';
import { isEligibleSujainCapturedRow } from '../collect.mjs';
import { formatLayoutWarnFragment, sanitizePageLayoutDiagnostic } from '../policy.mjs';

const EMPTY_OUTSIDE = {
  visibleInput: 0,
  visibleSelect: 0,
  visibleTextarea: 0,
  hidden: 0,
  other: 0,
};

/** Minimal DOM duck-types for Node — mirrors the td/input shapes capture reads. */
function control(tagName, attrs = {}) {
  const el = {
    tagName,
    id: attrs.id ?? '',
    name: attrs.name ?? '',
    type: attrs.type ?? (tagName === 'INPUT' ? 'text' : undefined),
    value: attrs.value ?? '',
    hidden: attrs.hidden === true,
    style: attrs.style ?? {},
    options: attrs.options,
    selectedIndex: attrs.selectedIndex ?? 0,
    parentElement: null,
    getAttribute(key) {
      if (key === 'type') return attrs.type ?? (tagName === 'INPUT' ? 'text' : null);
      if (key === 'id') return attrs.id ?? null;
      if (key === 'name') return attrs.name ?? null;
      if (key === 'hidden') return attrs.hidden === true ? '' : null;
      if (Object.hasOwn(attrs, key)) return attrs[key];
      return null;
    },
    closest(sel) {
      if (sel !== 'table') return null;
      let node = this.parentElement;
      while (node) {
        if (String(node.tagName || '').toLowerCase() === 'table') return node;
        node = node.parentElement;
      }
      return null;
    },
  };
  return el;
}

function cell(children, textContent = '') {
  const controls = Array.isArray(children) ? children : [];
  return {
    textContent,
    querySelectorAll(sel) {
      if (!/input|select|textarea/i.test(sel)) return [];
      return controls;
    },
  };
}

function row(cells) {
  return {
    querySelectorAll(sel) {
      if (sel === 'th, td') return cells;
      return [];
    },
  };
}

function table({ headers = [], bodyRows = [], extraControls = [] }) {
  const headerCells = headers.map((text) => ({ textContent: text }));
  const headerRow = {
    querySelectorAll(sel) {
      if (sel === 'th, td') return headerCells.map((h) => cell([], h.textContent));
      return [];
    },
  };
  const formControls = [];
  for (const bodyRow of bodyRows) {
    for (const c of bodyRow.querySelectorAll('th, td')) {
      formControls.push(...c.querySelectorAll('input, select, textarea'));
    }
  }
  formControls.push(...extraControls);

  const tableEl = {
    tagName: 'TABLE',
    querySelectorAll(sel) {
      if (sel === 'thead th, tr:first-child th') return headerCells;
      if (sel === 'tbody tr, tr') return [headerRow, ...bodyRows];
      if (sel === 'input, select, textarea') return formControls;
      return [];
    },
  };
  for (const el of formControls) {
    el.parentElement = tableEl;
  }
  return tableEl;
}

function iframe(src) {
  return {
    tagName: 'IFRAME',
    src,
    getAttribute(key) {
      return key === 'src' ? src : null;
    },
  };
}

function doc(tables, { outsideControls = [], iframes = [] } = {}) {
  return {
    querySelectorAll(sel) {
      if (sel === 'table') return tables;
      if (sel === 'input, select, textarea') {
        const inside = [];
        for (const t of tables) {
          inside.push(...t.querySelectorAll('input, select, textarea'));
        }
        return [...inside, ...outsideControls];
      }
      if (sel === 'iframe') return iframes;
      return [];
    },
  };
}

test('회차/약정금액 table with amounts in inputs is captured and eligible', () => {
  const paymentHeaders = ['회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금'];
  const paymentTable = table({
    headers: paymentHeaders,
    bodyRows: [
      row([
        cell([control('INPUT', { value: '1' })]),
        cell([control('INPUT', { value: '2026-06-01' })]),
        cell([control('INPUT', { value: '10000000' })]),
        cell([control('INPUT', { value: '2026-06-02' })]),
        cell([control('INPUT', { value: '9000000' })]),
        cell([control('INPUT', { value: '0' })]),
        cell([control('INPUT', { value: '0' })]),
        cell([control('INPUT', { value: '9000000' })]),
      ]),
    ],
  });
  const captured = captureSujainTables('payment', doc([paymentTable]));
  assert.equal(captured.tableCount, 1);
  assert.deepEqual(captured.tableHeaders[0], paymentHeaders);
  assert.equal(captured.rows.length, 1);
  // header row + 1 body row = preSkip 2; raw keeps the body row only.
  assert.deepEqual(captured.tables, [{ rawRowCount: 1, preSkipRowCount: 2, formControlCount: 8 }]);
  assert.equal(captured.outsideTableFormControlCount, 0);
  assert.deepEqual(captured.outsideTableFormControls, EMPTY_OUTSIDE);
  assert.equal(captured.iframeCount, 0);
  assert.deepEqual(captured.iframePaths, []);
  assert.equal(isEligibleSujainCapturedRow(captured.rows[0]), true);
  assert.equal(captured.rows[0].cells[2], '10000000');
  assert.equal(captured.rows[0].cells[0], '1');
});

test('이름* contact table with synthetic text cells remains ineligible', () => {
  const contactTable = table({
    headers: ['이름*'],
    bodyRows: [
      row([cell([], '합성 회원')]),
      row([cell([], '000-0000-0000')]),
      row([cell([], '합성 주소')]),
      row([cell([], 'synthetic@example.com')]),
    ],
  });
  const captured = captureSujainTables('payment', doc([contactTable]));
  assert.equal(captured.rows.length, 4);
  assert.equal(captured.rows.every((rowItem) => !isEligibleSujainCapturedRow(rowItem)), true);
  assert.deepEqual(captured.tables, [{ rawRowCount: 4, preSkipRowCount: 5, formControlCount: 0 }]);
});

test('layout diagnostics include per-table counts and never cell or input values', () => {
  const paymentHeaders = ['회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금'];
  const paymentTable = table({
    headers: paymentHeaders,
    bodyRows: [
      row(paymentHeaders.map(() => cell([control('INPUT', { value: 'SYNTHETIC_SECRET_AMOUNT' })]))),
    ],
  });
  const contactTable = table({
    headers: ['이름*'],
    bodyRows: [
      row([cell([], '합성 회원')]),
      row([cell([], '000-0000-0000')]),
      row([cell([], '합성 주소')]),
      row([cell([], 'synthetic@example.com')]),
    ],
  });
  const captured = captureSujainTables('payment', doc([paymentTable, contactTable]));
  const layout = sanitizePageLayoutDiagnostic({
    sourcePage: 'payment',
    tableCount: captured.tableCount,
    tableHeaders: captured.tableHeaders,
    rawRowCount: captured.rows.length,
    eligibleRowCount: captured.rows.filter(isEligibleSujainCapturedRow).length,
    tables: captured.tables,
    outsideTableFormControlCount: captured.outsideTableFormControlCount,
    outsideTableFormControls: captured.outsideTableFormControls,
    iframeCount: captured.iframeCount,
    iframePaths: captured.iframePaths,
    pagePath: 'https://www.sujain.co.kr/mypage/payment?session=SECRET_TOKEN#top',
    lookupNonPlaceholderOptionCount: 0,
    lookupClicked: false,
    lookupBodyRowsAppeared: false,
    cells: captured.rows.flatMap((r) => r.cells),
  });
  assert.ok(layout);
  assert.deepEqual(layout.tables, [
    { rawRowCount: 1, preSkipRowCount: 2, formControlCount: 8 },
    { rawRowCount: 4, preSkipRowCount: 5, formControlCount: 0 },
  ]);
  assert.deepEqual(layout.outsideTableFormControls, EMPTY_OUTSIDE);
  assert.equal(layout.pagePath, 'https://www.sujain.co.kr/mypage/payment');
  const text = JSON.stringify(layout);
  const fragment = formatLayoutWarnFragment({ payment: layout });
  for (const leak of [
    'SYNTHETIC_SECRET_AMOUNT',
    '합성 회원',
    '000-0000-0000',
    '합성 주소',
    'synthetic@example.com',
    'SECRET_TOKEN',
    '?session=',
  ]) {
    assert.equal(text.includes(leak), false, `layout JSON leaked ${leak}`);
    assert.equal(fragment.includes(leak), false, `warn fragment leaked ${leak}`);
  }
  assert.match(
    fragment,
    /payment:t=2;h=\[회차\|약정일자\|약정금액\|납부일자\|납부원금\|연체료\|할인료\|실납부금\],\[이름\*\];raw=5;eligible=1;tables=\[r=1,p=2,i=8\],\[r=4,p=5,i=0\];out=0\[vi=0,vs=0,vt=0,h=0,o=0\];lookup=np=0;click=0;rows=0;ifr=0;path=https:\/\/www\.sujain\.co\.kr\/mypage\/payment/,
  );
});

test('password and hidden inputs are not used as cell text', () => {
  const mixed = table({
    headers: ['회차', '약정금액', '비밀'],
    bodyRows: [
      row([
        cell([control('INPUT', { type: 'text', value: '1' })]),
        cell([
          control('INPUT', { type: 'hidden', value: 'HIDDEN_SYNTHETIC' }),
          control('INPUT', { type: 'password', value: 'PASSWORD_SYNTHETIC' }),
          control('INPUT', { type: 'text', value: '5000000' }),
        ]),
        cell([
          control('INPUT', { id: 'pw', type: 'text', value: 'LOGIN_PW_SYNTHETIC' }),
          control('INPUT', { id: 'id', type: 'text', value: 'LOGIN_ID_SYNTHETIC' }),
        ]),
      ]),
    ],
  });
  const captured = captureSujainTables('payment', doc([mixed]));
  assert.equal(captured.rows.length, 1);
  assert.equal(captured.rows[0].cells[0], '1');
  assert.equal(captured.rows[0].cells[1], '5000000');
  assert.equal(captured.rows[0].cells[2], '');
  const joined = captured.rows[0].cells.join('|');
  assert.equal(joined.includes('HIDDEN_SYNTHETIC'), false);
  assert.equal(joined.includes('PASSWORD_SYNTHETIC'), false);
  assert.equal(joined.includes('LOGIN_PW_SYNTHETIC'), false);
  assert.equal(joined.includes('LOGIN_ID_SYNTHETIC'), false);
  // formControlCount counts all controls in the table, including skipped ones.
  assert.equal(captured.tables[0].formControlCount, 6);
});

test('visible textContent wins over nested input values', () => {
  const t = table({
    headers: ['약정금액'],
    bodyRows: [
      row([cell([control('INPUT', { value: '999' })], '12,000,000')]),
    ],
  });
  const captured = captureSujainTables('payment', doc([t]));
  assert.equal(captured.rows[0].cells[0], '12,000,000');
});

test('empty payment table with inputs still reports formControlCount for diagnostics', () => {
  // Hypothesis 2 visibility: headers + input counts with zero captured rows.
  const emptyBody = table({
    headers: ['회차', '약정금액'],
    bodyRows: [],
    extraControls: [
      control('INPUT', { value: 'should-not-matter' }),
      control('INPUT', { value: 'also-ignored-for-values' }),
    ],
  });
  // Attach extra controls onto the table's form-control query only (no body cells).
  const captured = captureSujainTables('payment', doc([emptyBody]));
  assert.equal(captured.rows.length, 0);
  assert.deepEqual(captured.tableHeaders[0], ['회차', '약정금액']);
  // header-only tr remains in preSkip; raw stays 0 after skips.
  assert.deepEqual(captured.tables, [{ rawRowCount: 0, preSkipRowCount: 1, formControlCount: 2 }]);
});

test('preSkipRowCount keeps empty-cell rows that rawRowCount drops', () => {
  const paymentTable = table({
    headers: ['회차', '약정금액'],
    bodyRows: [
      row([cell([], ''), cell([], '')]),
      row([cell([], ''), cell([], '')]),
    ],
  });
  const captured = captureSujainTables('payment', doc([paymentTable]));
  assert.equal(captured.rows.length, 0);
  // header + 2 empty body rows counted before skip; raw stays 0.
  assert.deepEqual(captured.tables, [{ rawRowCount: 0, preSkipRowCount: 3, formControlCount: 0 }]);
});

test('outside-table form controls and iframe paths are counted without values or query strings', () => {
  const paymentTable = table({
    headers: ['회차', '약정금액'],
    bodyRows: [],
  });
  const outside = [
    control('INPUT', { value: 'OUTSIDE_SHOULD_NOT_APPEAR' }),
    control('SELECT', { value: 'also-secret' }),
    control('TEXTAREA', { value: 'still-secret' }),
  ];
  const frames = [
    iframe('https://www.sujain.co.kr/embed/unit?token=SESSION_SECRET#frag'),
    iframe('/mypage/picker?x=1'),
  ];
  const captured = captureSujainTables(
    'payment',
    doc([paymentTable], { outsideControls: outside, iframes: frames }),
  );
  assert.equal(captured.outsideTableFormControlCount, 3);
  assert.deepEqual(captured.outsideTableFormControls, {
    visibleInput: 1,
    visibleSelect: 1,
    visibleTextarea: 1,
    hidden: 0,
    other: 0,
  });
  assert.equal(captured.iframeCount, 2);
  assert.deepEqual(captured.iframePaths, [
    'https://www.sujain.co.kr/embed/unit',
    '/mypage/picker',
  ]);
  const serialized = JSON.stringify(captured.iframePaths);
  assert.equal(serialized.includes('SESSION_SECRET'), false);
  assert.equal(serialized.includes('?'), false);
  assert.equal(serialized.includes('OUTSIDE_SHOULD_NOT_APPEAR'), false);
  // Capture rows never include outside control values.
  assert.equal(JSON.stringify(captured.rows).includes('OUTSIDE_SHOULD_NOT_APPEAR'), false);
});

test('outside-table breakdown splits visibility and kind without leaking attributes or values (synthetic)', () => {
  // Synthetic HTML only — not live sujain markup.
  const paymentTable = table({
    headers: ['회차', '약정금액'],
    bodyRows: [],
  });
  const outside = [
    control('INPUT', {
      type: 'text',
      name: 'unitPickerName_LEAK',
      id: 'unitPickerId_LEAK',
      value: 'UNIT_VALUE_LEAK',
      placeholder: 'PLACEHOLDER_LEAK',
      'aria-label': 'ARIA_LEAK',
      class: 'class-leak',
    }),
    control('INPUT', { type: 'number', value: '42_LEAK' }),
    control('SELECT', {
      name: 'selectName_LEAK',
      value: 'opt-secret',
      options: [{ textContent: 'OPTION_LABEL_LEAK', value: 'v1' }],
      selectedIndex: 0,
    }),
    control('TEXTAREA', { name: 'notes_LEAK', value: 'TEXTAREA_VALUE_LEAK' }),
    control('INPUT', { type: 'hidden', name: 'csrf_LEAK', value: 'HIDDEN_TOKEN_LEAK' }),
    control('INPUT', { type: 'text', hidden: true, value: 'ATTR_HIDDEN_LEAK' }),
    control('INPUT', { type: 'text', style: { display: 'none' }, value: 'DISPLAY_NONE_LEAK' }),
    control('INPUT', { type: 'text', style: { visibility: 'hidden' }, value: 'VIS_HIDDEN_LEAK' }),
    control('INPUT', { type: 'password', name: 'pw_LEAK', value: 'PASSWORD_LEAK' }),
    control('INPUT', { type: 'submit', value: 'SUBMIT_LEAK' }),
    control('INPUT', { type: 'checkbox', name: 'agree_LEAK', value: 'yes' }),
    control('INPUT', { type: 'file', name: 'upload_LEAK' }),
  ];
  const captured = captureSujainTables(
    'payment',
    doc([paymentTable], { outsideControls: outside }),
  );
  assert.equal(captured.outsideTableFormControlCount, 12);
  assert.deepEqual(captured.outsideTableFormControls, {
    visibleInput: 2,
    visibleSelect: 1,
    visibleTextarea: 1,
    hidden: 4,
    other: 4,
  });
  const sum = Object.values(captured.outsideTableFormControls).reduce((a, b) => a + b, 0);
  assert.equal(sum, captured.outsideTableFormControlCount);

  const layout = sanitizePageLayoutDiagnostic({
    sourcePage: 'payment',
    tableCount: captured.tableCount,
    tableHeaders: captured.tableHeaders,
    rawRowCount: 0,
    eligibleRowCount: 0,
    tables: captured.tables,
    outsideTableFormControlCount: captured.outsideTableFormControlCount,
    outsideTableFormControls: captured.outsideTableFormControls,
    iframeCount: 0,
    iframePaths: [],
    pagePath: 'https://www.sujain.co.kr/mypage/payment',
    lookupNonPlaceholderOptionCount: 0,
    lookupClicked: false,
    lookupBodyRowsAppeared: false,
  });
  assert.ok(layout);
  const text = JSON.stringify(layout);
  const fragment = formatLayoutWarnFragment({ payment: layout });
  assert.match(
    fragment,
    /out=12\[vi=2,vs=1,vt=1,h=4,o=4\]/,
  );
  for (const leak of [
    'UNIT_VALUE_LEAK',
    'unitPickerName_LEAK',
    'unitPickerId_LEAK',
    'PLACEHOLDER_LEAK',
    'ARIA_LEAK',
    'class-leak',
    '42_LEAK',
    'selectName_LEAK',
    'OPTION_LABEL_LEAK',
    'opt-secret',
    'notes_LEAK',
    'TEXTAREA_VALUE_LEAK',
    'csrf_LEAK',
    'HIDDEN_TOKEN_LEAK',
    'ATTR_HIDDEN_LEAK',
    'DISPLAY_NONE_LEAK',
    'VIS_HIDDEN_LEAK',
    'pw_LEAK',
    'PASSWORD_LEAK',
    'SUBMIT_LEAK',
    'agree_LEAK',
    'upload_LEAK',
    'password',
    'checkbox',
    'submit',
  ]) {
    assert.equal(text.includes(leak), false, `layout JSON leaked ${leak}`);
    assert.equal(fragment.includes(leak), false, `warn fragment leaked ${leak}`);
  }
  // Password is never treated as a visible data field.
  assert.equal(layout.outsideTableFormControls.visibleInput >= 0, true);
  assert.equal(layout.outsideTableFormControls.other >= 1, true);
});
