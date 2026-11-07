import { SujainReadError, isLoginUrl } from './policy.mjs';
import { SUJAIN_URLS } from './urls.mjs';

/** Must match apps/api sujain-browser responseSchema string caps. */
export const SUJAIN_CELL_MAX = 200;
export const SUJAIN_HEADER_MAX = 100;

function text(value) {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

function clip(value, max) {
  const clipped = text(value);
  return clipped.length <= max ? clipped : clipped.slice(0, max);
}

/** Truncate cell/header strings to API schema caps so ok:true is not discarded. */
export function normalizeCapturedRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).map((row) => ({
    cells: (Array.isArray(row?.cells) ? row.cells : []).slice(0, 20).map((cell) => clip(cell, SUJAIN_CELL_MAX)),
    headers: (Array.isArray(row?.headers) ? row.headers : []).slice(0, 20).map((header) => clip(header, SUJAIN_HEADER_MAX)),
    sourcePage: row?.sourcePage === 'unit-items' ? 'unit-items' : 'payment',
  }));
}

/** Official ajax failure alerts — not the post-login success toast. */
function isCredentialFailureDialog(message) {
  return /실패|오류|틀렸|일치하지|아이디|비밀번호|잘못|없/u.test(message)
    && !isLoginSuccessDialog(message);
}

/**
 * Official /login/result alert after loginproc success.
 * Must not be treated as extra auth (authentication_required).
 */
function isLoginSuccessDialog(message) {
  return /정상적으로\s*로그인/u.test(message);
}

async function waitUntilLeftLogin(page, timeout = 15_000) {
  try {
    await page.waitForURL(
      (next) => {
        try {
          const href = typeof next === 'string' ? next : next.href;
          return !isLoginUrl(href);
        } catch {
          return false;
        }
      },
      { timeout },
    );
  } catch {
    throw new SujainReadError('authentication_required');
  }
}

async function tableRows(page, sourcePage) {
  const raw = await page.evaluate((pageKind) => {
    const cellMax = 200;
    const headerMax = 100;
    const clipText = (value, max) => {
      const clipped = (value ?? '').replace(/\s+/gu, ' ').trim();
      return clipped.length <= max ? clipped : clipped.slice(0, max);
    };
    const out = [];
    for (const table of Array.from(document.querySelectorAll('table')).slice(0, 20)) {
      const headerCells = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
        .map((cell) => clipText(cell.textContent, headerMax))
        .filter(Boolean);
      const bodyRows = Array.from(table.querySelectorAll('tbody tr, tr')).slice(0, 50);
      for (const row of bodyRows) {
        const cells = Array.from(row.querySelectorAll('th, td'))
          .map((cell) => clipText(cell.textContent, cellMax));
        if (cells.length === 0 || cells.every((cell) => !cell)) continue;
        // 헤더만 있는 줄은 건너뛴다.
        if (headerCells.length && cells.join('|') === headerCells.join('|')) continue;
        out.push({
          cells: cells.slice(0, 20),
          headers: headerCells.slice(0, 20),
          sourcePage: pageKind,
        });
      }
    }
    return out.slice(0, 100);
  }, sourcePage);
  return normalizeCapturedRows(raw);
}

/**
 * Official login uses form#frm + #id/#pw + a.btnLogin (ajax /login/loginproc then form submit).
 * Prefer the site's own click handler; do not POST loginproc or strip CSRF ourselves.
 */
async function fillLogin(page, credentials) {
  const form = page.locator('form#frm').first();
  const scope = (await form.count()) > 0 ? form : page;

  const user = scope.locator('#id, input[name="userid"]').first();
  const pass = scope.locator('#pw, input[name="userpwd"]').first();
  if (await user.count() === 0 || await pass.count() === 0) {
    throw new SujainReadError('unsupported_layout');
  }
  await user.fill(credentials.loginId, { timeout: 5_000 });
  await pass.fill(credentials.password, { timeout: 5_000 });

  const submit = page.locator(
    'form#frm a.btnLogin, a.btnLogin, button[type="submit"], input[type="submit"], button:has-text("로그인")',
  ).first();
  if (await submit.count() === 0) throw new SujainReadError('unsupported_layout');

  const dialogPromise = page.waitForEvent('dialog', { timeout: 15_000 })
    .then((dialog) => ({ kind: 'dialog', dialog }));
  const leftLoginPromise = page.waitForURL(
    (next) => {
      try {
        const href = typeof next === 'string' ? next : next.href;
        return !isLoginUrl(href);
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  ).then(() => ({ kind: 'navigated' }));
  // Loser rejection must not become an unhandled rejection after race settles.
  dialogPromise.catch(() => {});
  leftLoginPromise.catch(() => {});

  await submit.click({ timeout: 5_000 });

  const outcome = await Promise.race([dialogPromise, leftLoginPromise]).catch(() => null);

  if (outcome?.kind === 'dialog') {
    const message = text(outcome.dialog.message?.() ?? '');
    await outcome.dialog.dismiss().catch(() => null);
    if (isCredentialFailureDialog(message)) {
      throw new SujainReadError('credentials_invalid');
    }
    // Success alert on /login/result: dismiss, then wait past login URLs (/index etc.).
    if (isLoginSuccessDialog(message)) {
      await waitUntilLeftLogin(page);
      return;
    }
    // Real captcha / 2FA / extra-auth dialogs stay authentication_required.
    throw new SujainReadError('authentication_required');
  }
}

/**
 * 공식 로그인 뒤 분양대금조회·세대 내 설치 품목을 한 번에 읽는다.
 * 2FA·캡차는 우회하지 않고 authentication_required로 돌린다.
 * diagnostics.stage is an allowlisted token only (login / scrape_*), never URLs.
 */
export async function readSujainPages(page, job, diagnostics = null) {
  const setStage = (stage) => {
    if (diagnostics && typeof diagnostics === 'object') diagnostics.stage = stage;
  };

  setStage('login');
  try {
    await page.goto(SUJAIN_URLS.login, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } catch {
    throw new SujainReadError('network_error');
  }

  await fillLogin(page, job.credentials);

  const captcha = await page.locator('text=/캡차|자동입력|추가\\s*인증|2단계|본인\\s*인증/u').count();
  if (captcha > 0) throw new SujainReadError('authentication_required');

  const afterLogin = page.url();
  if (isLoginUrl(afterLogin)) {
    const failed = await page.locator('text=/실패|오류|틀렸|일치하지/u').count();
    throw new SujainReadError(failed > 0 ? 'credentials_invalid' : 'authentication_required');
  }

  const rows = [];
  for (const [url, sourcePage] of [
    [SUJAIN_URLS.payment, 'payment'],
    [SUJAIN_URLS.unitItems, 'unit-items'],
  ]) {
    setStage(sourcePage === 'payment' ? 'scrape_payment' : 'scrape_unit_items');
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      throw new SujainReadError('network_error');
    }
    if (isLoginUrl(page.url())) throw new SujainReadError('authentication_required');
    const pageRows = await tableRows(page, sourcePage);
    for (const row of pageRows) rows.push(row);
  }

  if (rows.length === 0) {
    // 표 칸 이름을 단정하지 못한 상태 — 빈 결과와 이유를 상위에서 남긴다.
    rows.push({
      cells: [],
      headers: [],
      sourcePage: 'payment',
    });
  }

  return {
    capturedAt: new Date().toISOString(),
    rows: normalizeCapturedRows(
      rows.filter((row) => row.cells.length > 0 || text((row.headers ?? []).join(''))),
    ),
  };
}
