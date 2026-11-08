import { SUJAIN_ORIGINS, SUJAIN_PATHS } from './urls.mjs';

export const ERRORS = new Set([
  'credentials_invalid',
  'authentication_required',
  'network_error',
  'unsupported_layout',
  'runtime_unavailable',
  'operation_unknown',
]);

export class SujainReadError extends Error {
  constructor(code) {
    super('Sujain read did not complete');
    this.code = ERRORS.has(code) ? code : 'operation_unknown';
  }
}

/** Allowlisted runner stage tokens only — never URLs or page path text. */
export const RUNNER_STAGES = new Set([
  'stdin',
  'validate',
  'import',
  'launch',
  'context',
  'login',
  'scrape_payment',
  'scrape_unit_items',
]);

/**
 * Letters-only, length-capped error.name token.
 * Never message, stack, URL, or page text.
 */
export function sanitizeRunnerErrorName(error) {
  const raw = error && typeof error === 'object' && typeof error.name === 'string'
    ? error.name
    : '';
  const letters = raw.replace(/[^A-Za-z]/gu, '').slice(0, 40);
  return letters.length > 0 ? letters : null;
}

/** Allowlisted stage token or null. */
export function sanitizeRunnerStage(stage) {
  return typeof stage === 'string' && RUNNER_STAGES.has(stage) ? stage : null;
}

const LAYOUT_PAGES = new Set(['payment', 'unit-items']);
const LAYOUT_HEADER_MAX = 100;
const LAYOUT_TABLE_MAX = 20;
const LAYOUT_HEADER_CELLS_MAX = 20;
const LAYOUT_PATH_MAX = 200;
const LAYOUT_IFRAME_PATHS_MAX = 20;

/**
 * Header cell text only — never data-cell values.
 * Drops URL/query-like strings that could carry credentials or PII.
 */
export function sanitizeLayoutHeaderText(value) {
  if (typeof value !== 'string') return null;
  const clipped = value.replace(/\s+/gu, ' ').trim().slice(0, LAYOUT_HEADER_MAX);
  if (!clipped) return null;
  if (/https?:\/\//iu.test(clipped) || /[?&=]/u.test(clipped)) return null;
  return clipped;
}

/**
 * Final scrape URL or iframe src → origin+pathname (or pathname).
 * Strips search and hash so session tokens cannot leak. Never credentials.
 */
export function sanitizeLayoutPagePath(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(raw) || raw.startsWith('//')) {
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
      if (url.username || url.password) return null;
      const out = `${url.origin}${url.pathname}`.slice(0, LAYOUT_PATH_MAX);
      return out || null;
    }
    const path = raw.split(/[?#]/u)[0].slice(0, LAYOUT_PATH_MAX);
    if (!path || /[\x00-\x1f]/u.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

function sanitizeNonNegInt(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.trunc(n), max);
}

function sanitizeIframePaths(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value.slice(0, LAYOUT_IFRAME_PATHS_MAX)) {
    const path = sanitizeLayoutPagePath(entry);
    if (path) out.push(path);
  }
  return out;
}

/**
 * Per-table counts only — never input values, names, or amounts.
 * preSkipRowCount = tr candidates before empty-cell / header-only skips.
 */
function sanitizeTableLayoutStats(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value.slice(0, LAYOUT_TABLE_MAX)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    out.push({
      rawRowCount: sanitizeNonNegInt(entry.rawRowCount, 1000),
      preSkipRowCount: sanitizeNonNegInt(entry.preSkipRowCount, 1000),
      formControlCount: sanitizeNonNegInt(entry.formControlCount, 1000),
    });
  }
  return out;
}

/**
 * Outside-table control buckets (counts only). Never types beyond the five
 * allowlisted keys, never names/ids/values. Missing/partial objects default to 0.
 */
export function sanitizeOutsideTableFormControls(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  return {
    visibleInput: sanitizeNonNegInt(source?.visibleInput, 1000),
    visibleSelect: sanitizeNonNegInt(source?.visibleSelect, 1000),
    visibleTextarea: sanitizeNonNegInt(source?.visibleTextarea, 1000),
    hidden: sanitizeNonNegInt(source?.hidden, 1000),
    other: sanitizeNonNegInt(source?.other, 1000),
  };
}

function sanitizeLookupFlag(value) {
  return value === true;
}

/**
 * One scrape page: tableCount + header texts + raw/eligible row counts +
 * per-table raw/pre-skip/form-control counts + outside-table input count +
 * outside-table visibility/kind breakdown + iframe count/paths + sanitized
 * page path + payment-lookup counts/flags. Never includes cell values,
 * form-control values, option labels, query strings, or arbitrary extra keys.
 */
export function sanitizePageLayoutDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourcePage = LAYOUT_PAGES.has(value.sourcePage) ? value.sourcePage : null;
  if (!sourcePage) return null;

  const tableHeaders = [];
  if (Array.isArray(value.tableHeaders)) {
    for (const headers of value.tableHeaders.slice(0, LAYOUT_TABLE_MAX)) {
      if (!Array.isArray(headers)) continue;
      const cleaned = [];
      for (const header of headers.slice(0, LAYOUT_HEADER_CELLS_MAX)) {
        const text = sanitizeLayoutHeaderText(header);
        if (text) cleaned.push(text);
      }
      tableHeaders.push(cleaned);
    }
  }

  return {
    sourcePage,
    tableCount: sanitizeNonNegInt(value.tableCount, 100),
    tableHeaders,
    rawRowCount: sanitizeNonNegInt(value.rawRowCount, 1000),
    eligibleRowCount: sanitizeNonNegInt(value.eligibleRowCount, 1000),
    tables: sanitizeTableLayoutStats(value.tables),
    outsideTableFormControlCount: sanitizeNonNegInt(value.outsideTableFormControlCount, 1000),
    outsideTableFormControls: sanitizeOutsideTableFormControls(value.outsideTableFormControls),
    iframeCount: sanitizeNonNegInt(value.iframeCount, 100),
    iframePaths: sanitizeIframePaths(value.iframePaths),
    pagePath: sanitizeLayoutPagePath(value.pagePath),
    lookupNonPlaceholderOptionCount: sanitizeNonNegInt(value.lookupNonPlaceholderOptionCount, 20),
    lookupClicked: sanitizeLookupFlag(value.lookupClicked),
    lookupBodyRowsAppeared: sanitizeLookupFlag(value.lookupBodyRowsAppeared),
  };
}

/**
 * `{ payment?: PageLayout, 'unit-items'?: PageLayout }` with allowlisted keys only.
 */
export function sanitizeLayoutDiagnostics(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return null;
  const out = {};
  for (const page of LAYOUT_PAGES) {
    if (!Object.hasOwn(layout, page)) continue;
    const pageValue = layout[page];
    const sanitized = sanitizePageLayoutDiagnostic(
      pageValue && typeof pageValue === 'object'
        ? { ...pageValue, sourcePage: page }
        : null,
    );
    if (!sanitized) continue;
    out[page] = {
      tableCount: sanitized.tableCount,
      tableHeaders: sanitized.tableHeaders,
      rawRowCount: sanitized.rawRowCount,
      eligibleRowCount: sanitized.eligibleRowCount,
      tables: sanitized.tables,
      outsideTableFormControlCount: sanitized.outsideTableFormControlCount,
      outsideTableFormControls: sanitized.outsideTableFormControls,
      iframeCount: sanitized.iframeCount,
      iframePaths: sanitized.iframePaths,
      pagePath: sanitized.pagePath,
      lookupNonPlaceholderOptionCount: sanitized.lookupNonPlaceholderOptionCount,
      lookupClicked: sanitized.lookupClicked,
      lookupBodyRowsAppeared: sanitized.lookupBodyRowsAppeared,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Compact outside-table breakdown for warn lines.
 * Example: out=12[vi=2,vs=1,vt=0,h=5,o=4]
 */
export function formatOutsideTableFormControlsFragment(count, breakdown) {
  const b = sanitizeOutsideTableFormControls(breakdown);
  return `out=${sanitizeNonNegInt(count, 1000)}[vi=${b.visibleInput},vs=${b.visibleSelect},vt=${b.visibleTextarea},h=${b.hidden},o=${b.other}]`;
}

/**
 * Compact warn-line fragment. Header texts + counts + sanitized path only —
 * never cell values, form values, or query strings.
 * Example: layout=payment:t=1;h=[항목|내용];raw=2;eligible=0;tables=[r=2,p=3,i=0];out=0[vi=0,vs=0,vt=0,h=0,o=0];lookup=np=0;click=0;rows=0;ifr=0;path=https://www.sujain.co.kr/mypage/payment|unit-items:…
 */
export function formatLayoutWarnFragment(layout) {
  const sanitized = sanitizeLayoutDiagnostics(layout);
  if (!sanitized) return '';
  const parts = [];
  for (const page of ['payment', 'unit-items']) {
    const entry = sanitized[page];
    if (!entry) continue;
    const headerText = entry.tableHeaders
      .map((cols) => `[${cols.join('|')}]`)
      .join(',');
    const tableText = entry.tables
      .map((stats) => `[r=${stats.rawRowCount},p=${stats.preSkipRowCount},i=${stats.formControlCount}]`)
      .join(',');
    const pathText = entry.pagePath || '-';
    const outText = formatOutsideTableFormControlsFragment(
      entry.outsideTableFormControlCount,
      entry.outsideTableFormControls,
    );
    const lookupText = `lookup=np=${entry.lookupNonPlaceholderOptionCount};click=${entry.lookupClicked ? 1 : 0};rows=${entry.lookupBodyRowsAppeared ? 1 : 0}`;
    parts.push(
      `${page}:t=${entry.tableCount};h=${headerText || '[]'};raw=${entry.rawRowCount};eligible=${entry.eligibleRowCount};tables=${tableText || '[]'};${outText};${lookupText};ifr=${entry.iframeCount};path=${pathText}`,
    );
  }
  if (parts.length === 0) return '';
  // Cap total fragment length so a noisy page cannot flood logs.
  return `layout=${parts.join('|')}`.slice(0, 800);
}

/**
 * Allowlisted reason (+ optional errorName) for non-SujainReadError throws.
 * Uses sanitized error.name only — never message, stack, URL, or page text.
 */
export function classifyUntypedRunnerError(error) {
  if (error instanceof SujainReadError) return null;
  const errorName = sanitizeRunnerErrorName(error);
  if (errorName === 'TimeoutError') {
    return { reason: 'playwright_timeout', errorName };
  }
  return { reason: 'runner_exception', errorName };
}

/**
 * Chromium refuses `--no-sandbox` only when it is missing as root.
 * Production API containers run as uid 0 with no USER directive, so keep the
 * Playwright sandbox on for non-root and turn it off only for root/Docker.
 */
export function chromiumSandboxEnabled(getuid = process.getuid) {
  return typeof getuid !== 'function' || getuid() !== 0;
}

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const full = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

export function validateJob(value) {
  if (!exact(value, ['provider', 'credentials']) || value.provider !== 'sujain'
    || !exact(value.credentials, ['loginId', 'password'])
    || !full(/^[A-Za-z0-9._@-]{1,64}$/u, value.credentials.loginId)
    || !full(/^[\x21-\x7e]{1,64}$/u, value.credentials.password)) {
    throw new SujainReadError('operation_unknown');
  }
  return value;
}

/** www.sujain.co.kr · m.sujain.co.kr 만 허용. 호반·공개 분양 소개 호스트는 막는다. */
export function allowedRequest(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return SUJAIN_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

export function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return SUJAIN_ORIGINS.has(url.origin) && (url.pathname === SUJAIN_PATHS.login || url.pathname.startsWith('/login'));
  } catch {
    return false;
  }
}

export { SUJAIN_PATHS };
