import { SujainReadError, isLoginUrl } from './policy.mjs';
import { SUJAIN_URLS } from './urls.mjs';

function text(value) {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

async function tableRows(page, sourcePage) {
  return page.evaluate((pageKind) => {
    const out = [];
    for (const table of Array.from(document.querySelectorAll('table')).slice(0, 20)) {
      const headerCells = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
        .map((cell) => (cell.textContent ?? '').replace(/\s+/gu, ' ').trim())
        .filter(Boolean);
      const bodyRows = Array.from(table.querySelectorAll('tbody tr, tr')).slice(0, 50);
      for (const row of bodyRows) {
        const cells = Array.from(row.querySelectorAll('th, td'))
          .map((cell) => (cell.textContent ?? '').replace(/\s+/gu, ' ').trim());
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
}

async function fillLogin(page, credentials) {
  const user = page.locator('input[type="text"], input[name*="id" i], input[id*="id" i], input[name*="user" i]').first();
  const pass = page.locator('input[type="password"]').first();
  if (await user.count() === 0 || await pass.count() === 0) throw new SujainReadError('unsupported_layout');
  await user.fill(credentials.loginId, { timeout: 5_000 });
  await pass.fill(credentials.password, { timeout: 5_000 });
  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("로그인")').first();
  if (await submit.count() === 0) throw new SujainReadError('unsupported_layout');
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => null),
    submit.click({ timeout: 5_000 }),
  ]);
}

/**
 * 공식 로그인 뒤 분양대금조회·세대 내 설치 품목을 한 번에 읽는다.
 * 2FA·캡차는 우회하지 않고 authentication_required로 돌린다.
 */
export async function readSujainPages(page, job) {
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
    rows: rows.filter((row) => row.cells.length > 0 || text((row.headers ?? []).join(''))).slice(0, 100),
  };
}
