/**
 * 실제 정적 export(`apps/web/out`)의 `/play/app/?key=backyard`를 격리 API fixture로 띄워
 * 말풍선·입질·획득 카드 화면을 찍는다. 운영 API로는 아무것도 보내지 않는다(`**\/v1/**` 전부 가로챔).
 *
 *   pnpm --filter web build:mobile && node scripts/preview-backyard/route.mjs [출력디렉터리]
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/out');
const out = resolve(process.argv[2] || '/tmp/backyard-preview/route');
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    let file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + sep)) throw Error('경로 밖');
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => problems.push('pageerror: ' + error.message));
  page.on('console', entry => { if (entry.type() === 'error') problems.push('console: ' + entry.text()); });
  const dto = {};
  const user = { id: 'preview-user', email: 'preview@example.invalid', name: '미리보기', displayName: '미리보기' };
  await page.route('**/v1/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let body = { items: [], count: 0, unreadCount: 0 };
    if (path === '/v1/card-sms-events') body = [];
    else if (path === '/v1/auth/refresh') body = { user, tokens: { accessToken: 'isolated-preview-token' } };
    else if (path === '/v1/auth/me') body = { user, memberships: [{ householdId: 'preview-household', householdName: '미리보기 가구', role: 'owner' }] };
    else if (path === '/v1/play/backyard') body = { items: Object.entries(dto).map(([stateKey, state]) => ({ stateKey, state })) };
    else if (path.startsWith('/v1/play/backyard/') && req.method() === 'PUT') { const key = path.split('/').at(-1); dto[key] = req.postDataJSON().state; body = { stateKey: key, state: dto[key] }; }
    await route.fulfill({ status: 200, json: body, headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' } });
  });
  const game = page.locator('[data-backyard-game]');
  const ready = () => game.and(page.locator('[data-ready="true"]')).waitFor();
  const ack = () => page.locator('[data-save]').filter({ hasText: '저장됨' }).waitFor({ state: 'attached' });
  const actors = async () => JSON.parse(await game.getAttribute('data-actors'));
  /** 위치만 저장 fixture로 고정한다. */
  async function position(x, y, direction = 6) {
    dto.rpg_player = { v: 2, mapVersion: 1, x: Math.round(x / 2), y: Math.round(y / 2), direction, outfit: 0, t: 0 };
    await page.reload(); await ready(); await ack();
  }
  const shot = name => page.screenshot({ path: join(out, name + '.png') });

  await page.goto(base + '/play/app/?key=backyard');
  await ready(); await ack();
  await page.waitForTimeout(600);
  await shot('01-입장');

  // ── 말풍선 ──────────────────────────────────────────────────────────────
  const spawn = await actors();
  let talked = false;
  for (const actor of spawn) {
    for (const [dx, dy, direction] of [[-26, 0, 0], [26, 0, 4], [0, 24, 6], [0, -24, 2]]) {
      await position(actor.x + dx, actor.y + dy, direction);
      if (!/말 걸기/.test(await page.locator('[data-action]').textContent())) continue;
      await page.locator('[data-action]').click();
      await page.locator('[data-dialogue][data-open="true"]').waitFor();
      await page.waitForTimeout(700);
      await shot(`02-말풍선-타이핑중-${actor.id}`);
      await page.locator('[data-choices]:not([hidden])').waitFor();
      await page.waitForTimeout(300);
      await shot(`03-말풍선-완료-${actor.id}`);
      const text = await page.locator('[data-dialogue-text]').textContent();
      console.log(`${actor.id} 대사: ${text}`);
      // 말풍선 탭 → 다음 문장
      await page.locator('[data-dialogue]').click();
      await page.locator('[data-choices][hidden]').waitFor({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      await shot(`04-말풍선-다음-${actor.id}`);
      await page.locator('[data-choices]:not([hidden])').waitFor();
      await page.locator('[data-close-dialogue]').click();
      await page.waitForTimeout(300);
      talked = true; break;
    }
    if (talked) break;
  }
  if (!talked) problems.push('주민 대화를 열지 못했다');

  // ── 낚시 입질 ───────────────────────────────────────────────────────────
  await position(624 - 30, 304, 0);
  const label = await page.locator('[data-action]').textContent();
  if (/낚시/.test(label)) {
    await page.locator('[data-action]').click();
    await page.waitForTimeout(900);
    await shot('05-낚시-대기');
    await page.locator('[data-action][data-phase="bite"]').waitFor({ timeout: 8000 });
    await page.waitForTimeout(120);
    await shot('06-낚시-입질');
    await page.locator('[data-action]').click();
    await page.locator('[data-card]').waitFor({ timeout: 5000 });
    await page.waitForTimeout(350);
    await shot('07-획득-카드');
  } else problems.push('낚시점 라벨이 아니다: ' + label);

  // ── 가로 ────────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(500);
  await shot('08-가로');
} finally {
  await browser.close(); server.close();
}
if (problems.length) { console.error('문제:\n' + problems.join('\n')); process.exit(1); }
console.log('저장 위치: ' + out);
