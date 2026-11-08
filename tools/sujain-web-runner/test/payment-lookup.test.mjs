import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOutsideTableLookup,
  discoverOutsideTableLookup,
  emptyLookupDiagnostic,
  isPlaceholderOptionValue,
} from '../payment-lookup.mjs';

function option(value, label) {
  return {
    value,
    textContent: label,
    label,
    getAttribute(key) {
      if (key === 'value') return value;
      return null;
    },
  };
}

function inquireButton(text = '조회') {
  return {
    tagName: 'BUTTON',
    textContent: text,
    type: 'button',
    clickCalls: 0,
    click() {
      this.clickCalls += 1;
    },
    parentElement: null,
    nextElementSibling: null,
    querySelectorAll() {
      return [];
    },
  };
}

function selectEl({ options, hidden = false }) {
  const el = {
    tagName: 'SELECT',
    options,
    selectedIndex: 0,
    value: options[0]?.value ?? '',
    hidden,
    style: {},
    parentElement: null,
    nextElementSibling: null,
    parentNode: null,
    getAttribute(key) {
      if (key === 'hidden') return hidden ? '' : null;
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
    querySelectorAll(sel) {
      if (sel === 'option') return options;
      return [];
    },
    dispatchEvent() {
      return true;
    },
  };
  return el;
}

function wrapLookupRow(select, inquire) {
  const children = [select, inquire];
  select.nextElementSibling = inquire;
  inquire.parentElement = null;
  const row = {
    tagName: 'DIV',
    children,
    querySelectorAll(sel) {
      if (!/a|button|input/i.test(sel)) return [];
      return children.filter((el) => /^(A|BUTTON|INPUT)$/u.test(String(el.tagName || '')));
    },
  };
  select.parentElement = row;
  inquire.parentElement = row;
  return row;
}

function docFrom({ selects = [], tables = [], extra = [] }) {
  const allSelects = [...selects];
  const allControls = [...selects, ...extra];
  return {
    querySelectorAll(sel) {
      if (sel === 'select') return allSelects;
      if (sel === 'table') return tables;
      if (sel === 'a, button, input') {
        return allControls.filter((el) => /^(A|BUTTON|INPUT)$/u.test(String(el.tagName || '')));
      }
      return [];
    },
  };
}

test('placeholder detection uses empty-value patterns only, never label words', () => {
  assert.equal(isPlaceholderOptionValue(''), true);
  assert.equal(isPlaceholderOptionValue('   '), true);
  assert.equal(isPlaceholderOptionValue(null), true);
  assert.equal(isPlaceholderOptionValue(undefined), true);
  // Synthetic non-empty values are real options even if a human might call them placeholders.
  assert.equal(isPlaceholderOptionValue('0'), false);
  assert.equal(isPlaceholderOptionValue('synthetic-unit-a'), false);
  assert.equal(isPlaceholderOptionValue('선택'), false);
});

test('discover finds outside-table select + adjacent 조회 with non-placeholder indices only', () => {
  const select = selectEl({
    options: [
      option('', 'SYNTHETIC_PLACEHOLDER_LABEL_DO_NOT_LEAK'),
      option('synth-a', 'SYNTHETIC_OPTION_LABEL_ALPHA'),
      option('synth-b', 'SYNTHETIC_OPTION_LABEL_BETA'),
    ],
  });
  const inquire = inquireButton('조회');
  wrapLookupRow(select, inquire);
  const discovery = discoverOutsideTableLookup(docFrom({ selects: [select] }));
  assert.equal(discovery.inquireFound, true);
  assert.equal(discovery.selectOrdinal, 0);
  assert.deepEqual(discovery.nonPlaceholderOptionIndices, [1, 2]);
  const serialized = JSON.stringify(discovery);
  for (const leak of [
    'SYNTHETIC_PLACEHOLDER_LABEL_DO_NOT_LEAK',
    'SYNTHETIC_OPTION_LABEL_ALPHA',
    'SYNTHETIC_OPTION_LABEL_BETA',
    'synth-a',
    'synth-b',
  ]) {
    assert.equal(serialized.includes(leak), false, `discovery leaked ${leak}`);
  }
});

test('discover ignores in-table selects and non-inquire action buttons', () => {
  const tableSelect = selectEl({
    options: [option('in-table', 'SYNTHETIC_IN_TABLE')],
  });
  const table = { tagName: 'TABLE', parentElement: null };
  tableSelect.parentElement = table;

  const outside = selectEl({
    options: [option('', ''), option('real', 'SYNTHETIC_REAL')],
  });
  const payBtn = inquireButton('납부하기');
  wrapLookupRow(outside, payBtn);

  const discovery = discoverOutsideTableLookup(docFrom({
    selects: [tableSelect, outside],
    tables: [table],
  }));
  assert.equal(discovery.inquireFound, false);
  assert.deepEqual(discovery.nonPlaceholderOptionIndices, []);
});

test('apply selects a non-placeholder index and clicks adjacent 조회 without returning values', () => {
  const select = selectEl({
    options: [
      option('', 'SYNTHETIC_PLACEHOLDER_LABEL_DO_NOT_LEAK'),
      option('synth-a', 'SYNTHETIC_OPTION_LABEL_ALPHA'),
    ],
  });
  const inquire = inquireButton('조회');
  wrapLookupRow(select, inquire);
  const result = applyOutsideTableLookup(docFrom({ selects: [select] }), {
    selectOrdinal: 0,
    optionIndex: 1,
  });
  assert.deepEqual(result, { selected: true, clicked: true });
  assert.equal(select.selectedIndex, 1);
  assert.equal(inquire.clickCalls, 1);
  assert.equal(JSON.stringify(result).includes('synth-a'), false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_OPTION_LABEL_ALPHA'), false);
});

test('apply refuses placeholder option index and does not click 조회', () => {
  const select = selectEl({
    options: [
      option('', 'SYNTHETIC_PLACEHOLDER_LABEL_DO_NOT_LEAK'),
      option('synth-a', 'SYNTHETIC_OPTION_LABEL_ALPHA'),
    ],
  });
  const inquire = inquireButton('조회');
  wrapLookupRow(select, inquire);
  const result = applyOutsideTableLookup(docFrom({ selects: [select] }), {
    selectOrdinal: 0,
    optionIndex: 0,
  });
  assert.deepEqual(result, { selected: false, clicked: false });
  assert.equal(inquire.clickCalls, 0);
});

test('emptyLookupDiagnostic is counts-only with safe defaults', () => {
  assert.deepEqual(emptyLookupDiagnostic(), {
    lookupNonPlaceholderOptionCount: 0,
    lookupClicked: false,
    lookupBodyRowsAppeared: false,
  });
});
