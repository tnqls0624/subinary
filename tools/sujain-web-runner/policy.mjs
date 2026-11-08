import { makeOriginAllowlist } from './kit/allowlist.mjs';
import { sanitizeErrorName as sanitizeRunnerErrorName } from './kit/result.mjs';
import { SUJAIN_ORIGINS, SUJAIN_PATHS } from './urls.mjs';

// 브랜드 무관 뼈대는 kit/ 로 옮겼다. 기존 import 경로(테스트 포함)를 지키려고 이름 그대로 다시 내보낸다.
export { chromiumSandboxEnabled } from './kit/launch.mjs';
export { sanitizeRunnerErrorName };

export const ERRORS = new Set([
  'credentials_invalid',
  'authentication_required',
  'network_error',
  'unsupported_layout',
  'runtime_unavailable',
  'operation_unknown',
  // 분양대금조회의 단지 select(#preInsp)에 자리표시 말고 고를 세대가 없다 = 'My 분양단지' 미등록.
  'unit_not_registered',
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
  // 세대 내 설치 품목(/mypage/unit-items)은 입주 뒤에만 열려 읽지 않는다. 이 러너는
  // scrape_unit_items 를 더 내보내지 않는다(API 허용 목록에는 옛 러너 호환으로 남아 있다).
  'scrape_payment',
]);

/** Allowlisted stage token or null. */
export function sanitizeRunnerStage(stage) {
  return typeof stage === 'string' && RUNNER_STAGES.has(stage) ? stage : null;
}

/** 분양대금조회 한 화면만 읽는다(옵션 대금도 같은 화면의 「별도 계약 품목」 표에 있다). */
const LAYOUT_PAGES = new Set(['payment']);
const LAYOUT_UNITS_MAX = 100;
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

/**
 * One scrape page: tableCount + header texts + raw/eligible row counts +
 * per-table raw/pre-skip/form-control counts + outside-table input count +
 * outside-table visibility/kind breakdown + iframe count/paths + sanitized
 * page path + searched(0/1, 조회 버튼을 눌렀는지) + units(단지 select 의 실제
 * option 개수). Never includes cell values, form-control values, option
 * values/text (단지 코드·동호수), query strings, or arbitrary extra keys.
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
    searched: value.searched === 1 || value.searched === true ? 1 : 0,
    units: sanitizeNonNegInt(value.units, LAYOUT_UNITS_MAX),
  };
}

/**
 * `{ payment?: PageLayout }` with allowlisted keys only.
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
      searched: sanitized.searched,
      units: sanitized.units,
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
 * Example: layout=payment:t=1;searched=1;units=1;h=[항목|내용];raw=2;eligible=0;tables=[r=2,p=3,i=0];out=0[vi=0,vs=0,vt=0,h=0,o=0];ifr=0;path=https://www.sujain.co.kr/mypage/payment
 */
export function formatLayoutWarnFragment(layout) {
  const sanitized = sanitizeLayoutDiagnostics(layout);
  if (!sanitized) return '';
  const parts = [];
  for (const page of LAYOUT_PAGES) {
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
    parts.push(
      `${page}:t=${entry.tableCount};searched=${entry.searched};units=${entry.units};h=${headerText || '[]'};raw=${entry.rawRowCount};eligible=${entry.eligibleRowCount};tables=${tableText || '[]'};${outText};ifr=${entry.iframeCount};path=${pathText}`,
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
export const allowedRequest = makeOriginAllowlist(SUJAIN_ORIGINS);

export function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return SUJAIN_ORIGINS.has(url.origin) && (url.pathname === SUJAIN_PATHS.login || url.pathname.startsWith('/login'));
  } catch {
    return false;
  }
}

export { SUJAIN_PATHS };
