/**
 * Self-contained because chrome.scripting serializes this function without its module scope.
 * rootDocument is an offline fixture seam; production calls this with no arguments.
 * Never returns page text, account numbers, product names, URLs, or exception messages.
 */
export async function collectShinhanLoans({ rootDocument = globalThis.document } = {}) {
  const failure = (error) => ({ ok: false, error });
  const fail = (safeCode) => { throw Object.assign(new Error('Unsupported loan page'), { safeCode }); };
  const fullMatch = (pattern, value) => pattern.exec(value)?.[0] === value;
  const compact = (value) => value.replace(/\s+/gu, '');
  const readText = (element) => String(element.innerText ?? '').trim();
  const origin = 'https://bank.shinhan.com';
  const safeCodes = new Set([
    'WRONG_ORIGIN', 'UNSUPPORTED_FRAME', 'UNSUPPORTED_PAGE', 'NO_SUPPORTED_TABLE',
    'AMBIGUOUS_TABLE', 'AMBIGUOUS_COLUMNS', 'UNSUPPORTED_LAYOUT', 'INVALID_ACCOUNT',
    'INVALID_AMOUNT', 'MISSING_KRW_UNIT', 'INVALID_MATURITY', 'AMBIGUOUS_LOAN_TYPE',
    'DUPLICATE_ACCOUNT', 'NO_ELIGIBLE_LOAN', 'CRYPTO_UNAVAILABLE',
  ]);

  try {
    const document = rootDocument;
    const pageUrl = new URL(document.location.href);
    if (pageUrl.origin !== origin || pageUrl.username || pageUrl.password) fail('WRONG_ORIGIN');
    const view = document.defaultView;
    if (!view || view.top !== view.self) fail('UNSUPPORTED_FRAME');
    if (!new Set([
      '대출계좌명세 | 신한은행 개인뱅킹',
      '인터넷뱅킹 메인 | 신한은행 개인뱅킹',
    ]).has(document.title.trim())) fail('UNSUPPORTED_PAGE');

    const visible = (element) => {
      if (!element || element.getClientRects().length === 0) return false;
      for (let current = element; current; current = current.parentElement) {
        if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false;
        const style = view.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
      }
      return true;
    };
    // Main-page titles alone do not distinguish subviews. Require a visible account-list heading.
    let hasAccountListHeading = false;
    for (const heading of document.querySelectorAll('h1, h2, h3, [role="heading"], caption')) {
      if (!visible(heading)) continue;
      const headingText = compact(readText(heading));
      if (/거래내역|거래명세|상환내역|금리조회|대출금리|금리안내/u.test(headingText)) fail('UNSUPPORTED_PAGE');
      if (headingText === '대출계좌명세') hasAccountListHeading = true;
    }
    if (document.title.trim() === '인터넷뱅킹 메인 | 신한은행 개인뱅킹' && !hasAccountListHeading) fail('UNSUPPORTED_PAGE');

    const aliases = {
      계좌번호: 'account',
      대출잔액: 'principal',
      '대출잔액(원)': 'principal',
      '대출잔액(KRW)': 'principal',
      만기일: 'maturity',
    };
    const cellsOf = (row) => Array.from(row.querySelectorAll('th, td')).filter((cell) => cell.closest('tr') === row);
    const rowsOf = (table) => Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table && visible(row));
    const headerLabels = (row) => cellsOf(row).filter(visible).map((cell) => compact(readText(cell)));
    const candidates = [];
    for (const table of document.querySelectorAll('table')) {
      if (!visible(table)) continue;
      const rows = rowsOf(table);
      const headers = rows.filter((row) => cellsOf(row).some((cell) => cell.tagName === 'TH')
        && headerLabels(row).some((label) => aliases[label] === 'principal'));
      if (headers.length > 0) candidates.push({ table, rows, headers });
    }
    if (candidates.length === 0) fail('NO_SUPPORTED_TABLE');
    if (candidates.length !== 1) fail('AMBIGUOUS_TABLE');
    const { table, rows, headers } = candidates[0];
    if (headers.length !== 1) fail('AMBIGUOUS_COLUMNS');
    const header = headers[0];
    const headerCells = cellsOf(header);
    const simpleCells = (cells) => cells.every((cell) => visible(cell)
      && [null, '1'].includes(cell.getAttribute('colspan'))
      && [null, '1'].includes(cell.getAttribute('rowspan')));
    if (!simpleCells(headerCells) || headerCells.some((cell) => cell.tagName !== 'TH')) fail('UNSUPPORTED_LAYOUT');
    const labels = headerCells.map((cell) => compact(readText(cell)));
    const indices = {};
    for (const field of ['account', 'principal', 'maturity']) {
      const matching = labels.map((label, index) => aliases[label] === field ? index : -1).filter((index) => index >= 0);
      if (matching.length !== 1) fail('AMBIGUOUS_COLUMNS');
      indices[field] = matching[0];
    }
    if (labels.some((label) => new Set(['거래일자', '거래일', '거래일시', '거래금액', '입금액', '출금액', '상환일', '상환금액', '적요']).has(label))) fail('UNSUPPORTED_PAGE');
    const exactUnitLabel = (element) => element && visible(element)
      && fullMatch(/^(?:대출계좌명세)?\(?단위[:：]원\)?$/u, compact(readText(element)));
    const tableHasKrw = ['대출잔액(원)', '대출잔액(KRW)'].includes(labels[indices.principal])
      || Boolean(exactUnitLabel(table.caption)) || Boolean(exactUnitLabel(table.previousElementSibling));

    const parseAmount = (value) => {
      const match = /^(?:(₩|KRW)\s*)?((?:0|[1-9][0-9]*)|(?:[1-9][0-9]{0,2}(?:,[0-9]{3})+))(?:\s*(원))?$/u.exec(value);
      if (!match || match[0] !== value) fail('INVALID_AMOUNT');
      if (!tableHasKrw && !match[1] && !match[3]) fail('MISSING_KRW_UNIT');
      const amount = match[2].replace(/,/gu, '');
      if (!fullMatch(/^(0|[1-9][0-9]{0,19})$/u, amount)) fail('INVALID_AMOUNT');
      return amount;
    };
    const parseMaturity = (value) => {
      if (['-', '없음', '해당없음'].includes(value)) return null;
      const match = /^([0-9]{4})([-./])([0-9]{2})\2([0-9]{2})$/u.exec(value);
      if (!match || match[0] !== value) fail('INVALID_MATURITY');
      const [, yearString, , monthString, dayString] = match;
      const year = Number(yearString), month = Number(monthString), day = Number(dayString);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('INVALID_MATURITY');
      return `${yearString}-${monthString}-${dayString}`;
    };

    const captures = [];
    const accounts = new Set();
    const capturedAt = new Date().toISOString();
    const headerIndex = rows.indexOf(header);
    // Additional headings/body rows before the canonical header are not a supported layout.
    if (headerIndex !== 0) fail('UNSUPPORTED_LAYOUT');
    for (const row of rows.slice(headerIndex + 1)) {
      const cells = cellsOf(row);
      if (cells.length !== headerCells.length || !simpleCells(cells)) fail('UNSUPPORTED_LAYOUT');
      const rowText = readText(row);
      const interim = rowText.includes('중도금'), jeonse = rowText.includes('전세');
      if (!interim && !jeonse) continue;
      if (interim && jeonse) fail('AMBIGUOUS_LOAN_TYPE');
      const rawAccount = readText(cells[indices.account]);
      if (!fullMatch(/^[0-9]+(?:-[0-9]+)*$/u, rawAccount)) fail('INVALID_ACCOUNT');
      const account = rawAccount.replace(/-/gu, '');
      if (!fullMatch(/^[0-9]{10,20}$/u, account)) fail('INVALID_ACCOUNT');
      if (accounts.has(account)) fail('DUPLICATE_ACCOUNT');
      accounts.add(account);
      const outstandingPrincipalKrw = parseAmount(readText(cells[indices.principal]));
      const maturityDate = parseMaturity(readText(cells[indices.maturity]));
      if (!globalThis.crypto?.subtle) fail('CRYPTO_UNAVAILABLE');
      // Pseudonymous stable matching key, not encryption or anonymization.
      const digestInput = new TextEncoder().encode(`fma:shinhan:loan-account:v1\u0000${origin}\u0000${account}`);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
      const accountFingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      captures.push({
        formatVersion: 1, provider: 'shinhan', source: 'browser_assisted', origin,
        pageKind: 'loan_account_list', capturedAt, accountFingerprint, accountLast4: account.slice(-4),
        loanType: interim ? 'interim' : 'jeonse', outstandingPrincipalKrw, maturityDate, bankAsOfDate: null,
      });
    }
    if (captures.length === 0) fail('NO_ELIGIBLE_LOAN');
    return { ok: true, captures };
  } catch (error) {
    return failure(safeCodes.has(error?.safeCode) ? error.safeCode : 'UNSUPPORTED_PAGE');
  }
}
