/**
 * output-shape.test.mjs 전용 가짜 playwright-core(chromium 만). 실제 브라우저·네트워크를 쓰지 않는다.
 * 장면은 FAKE_PLAYWRIGHT_SCENARIO 로 고른다:
 * - success: 로그인 → 분양대금조회에서 세대 고르고 조회 → 합성 표 3개(fake-dom)
 * - credentials_invalid: 로그인 클릭 뒤 실패 알림
 * - timeout: 로그인 폼을 찾다가 TimeoutError(untyped 오류 경로)
 * - unit_not_registered: 단지 select 에 고를 세대가 없음
 * - launch_fail: chromium.launch 실패
 * 받은 launch/newContext 옵션·route 판정·close 순서만 stderr 에 'FAKE_PLAYWRIGHT {json}' 한 줄씩 남긴다.
 * 타이머는 모두 짧고 풀리면 지워서 자식 프로세스가 스스로 끝나게 한다.
 */
import { sujainPaymentDocument } from './fake-dom.mjs';

const scenario = process.env.FAKE_PLAYWRIGHT_SCENARIO ?? 'success';
const trace = (event, detail = {}) => {
  process.stderr.write(`FAKE_PLAYWRIGHT ${JSON.stringify({ event, ...detail })}\n`);
};

/** route 허용 목록 판정을 볼 주소(값 없는 합성 경로만). */
export const ROUTE_PROBES = [
  'https://www.sujain.co.kr/mypage/payment',
  'https://m.sujain.co.kr/',
  'http://www.sujain.co.kr/',
  'https://synthetic.example/',
  'https://synthetic@www.sujain.co.kr/',
];

const PAYMENT_ROWS = [
  ['계약금1차', '2023-05-20', '10,000,000', '2023-05-20', '10,000,000', '0', '0', '10,000,000'],
  ['중도금1차', '2024-01-25', '32,340,000', '', '0', '0', '0', '0'],
  ['잔금', '2027-02-26', '96,999,000', '', '0', '0', '0', '0'],
  ['계', '', '139,339,000', '', '10,000,000', '0', '0', '10,000,000'],
];
const OPTION_TABLES = [
  {
    itemLabel: '합성 현관 중문, [합성조명]-거실(2개소)',
    rows: [
      ['계약금', '2023-05-20', '1,230,000', '2023-05-20', '1,230,000', '0', '0', '1,230,000'],
      ['잔금', '2027-02-26', '7,380,000', '', '0', '0', '0', '0'],
      ['계', '', '8,610,000', '', '1,230,000', '0', '0', '1,230,000'],
    ],
  },
  {
    itemLabel: '합성 시스템에어컨(3대)',
    rows: [
      ['계약금', '2023-05-20', '450,000', '2023-05-21', '450,000', '0', '0', '450,000'],
      ['계', '', '450,000', '', '450,000', '0', '0', '450,000'],
    ],
  },
];

function timeoutError() {
  const error = new Error('synthetic timeout');
  error.name = 'TimeoutError';
  return error;
}

function createPage() {
  let url = 'about:blank';
  let searched = false;
  let dialogWaiter = null;
  const unitOptions = scenario === 'unit_not_registered' ? [] : ['synthetic-unit-1'];
  const doc = () => sujainPaymentDocument({ searched, paymentRows: PAYMENT_ROWS, options: OPTION_TABLES, unitOptions });
  const unitSelect = () => doc().descendants().find((element) => element.tagName === 'SELECT' && element.id === 'preInsp');

  function locator(selector) {
    const self = {
      first: () => self,
      locator: (child) => locator(child),
      async count() {
        if (selector === 'form#frm') {
          if (scenario === 'timeout') throw timeoutError();
          return 1;
        }
        if (selector.startsWith('#id') || selector.startsWith('#pw')) return 1;
        if (selector.includes('a.btnLogin') || selector.includes('searchPayment')) return 1;
        return 0;
      },
      async fill() {},
      async waitFor() {},
      async evaluate(fn) {
        return fn(unitSelect());
      },
      async selectOption() {},
      async click() {
        if (selector.includes('searchPayment')) {
          searched = true;
          return;
        }
        if (!selector.includes('a.btnLogin')) return;
        if (scenario === 'credentials_invalid') {
          setTimeout(() => dialogWaiter?.({
            message: () => '아이디 또는 비밀번호가 일치하지 않습니다.',
            dismiss: async () => {},
          }), 0);
        } else {
          setTimeout(() => { url = 'https://www.sujain.co.kr/'; }, 0);
        }
      },
    };
    return self;
  }

  return {
    async goto(target) { url = target; },
    url: () => url,
    locator,
    on() {},
    off() {},
    setDefaultTimeout(ms) { trace('setDefaultTimeout', { ms }); },
    async waitForLoadState() {},
    async waitForTimeout() {},
    waitForEvent() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { dialogWaiter = null; reject(timeoutError()); }, 50);
        dialogWaiter = (dialog) => { clearTimeout(timer); dialogWaiter = null; resolve(dialog); };
      });
    },
    waitForURL(predicate) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          if (predicate(new URL(url))) { resolve(); return; }
          if (Date.now() - started > 50) { reject(timeoutError()); return; }
          setTimeout(check, 1);
        };
        check();
      });
    },
    async evaluate(fn, arg) {
      // 실제 Playwright 는 arg 만 넘긴다. captureSujainTables 의 두 번째 인자(doc)는 Node 테스트용이다.
      return fn(arg, doc());
    },
  };
}

export const chromium = {
  async launch(options) {
    trace('launch', { options });
    if (scenario === 'launch_fail') throw new Error('synthetic launch failure');
    return {
      async newContext(contextOptions) {
        trace('newContext', { options: contextOptions });
        return {
          async route(pattern, handler) {
            const decisions = {};
            for (const probe of ROUTE_PROBES) {
              await handler({
                request: () => ({ url: () => probe }),
                continue: async () => { decisions[probe] = 'continue'; },
                abort: async () => { decisions[probe] = 'abort'; },
              });
            }
            trace('route', { pattern, decisions });
          },
          async newPage() { return createPage(); },
          async close() { trace('close', { target: 'context' }); },
        };
      },
      async close() { trace('close', { target: 'browser' }); },
    };
  },
};
