/** 정적 export의 실제 쿼리 페이지를 격리 API fixture와 함께 검증한다. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/out');
const evidence = resolve('docs/evidence/backyard-s6');
await mkdir(evidence, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  try {
    let file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + sep)) throw Error('검증 경로 밖');
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = { browser: browser.version(), widths: [], requests: [], errors: [], checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { results.errors.push(error.message); console.error(error.message); });
  page.on('console', entry => { if (entry.type() === 'error') results.errors.push(entry.text()); });
  let dto = null;
  let failGet = false;
  const user = { id: 'verify-user', email: 'verify@example.invalid', name: '검증', displayName: '검증' };
  // 모든 API 요청을 격리한다. 운영 서버로 전달하지 않는다.
  await page.route('**/v1/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    results.requests.push({ method: req.method(), path });
    let body = { items: [], count: 0, unreadCount: 0 };
    let status = 200;
    if (path === '/v1/card-sms-events') body = [];
    else if (path === '/v1/auth/refresh') body = { user, tokens: { accessToken: 'isolated-verification-token' } };
    else if (path === '/v1/auth/me') body = { user, memberships: [{ householdId: 'verify-household', householdName: '검증 가구', role: 'owner' }] };
    else if (path === '/v1/play/backyard') { body = { items: dto ? [{ stateKey: 'garden', state: dto }] : [] }; if (failGet) status = 503; }
    else if (path === '/v1/play/backyard/garden' && req.method() === 'PUT') { dto = req.postDataJSON().state; body = { stateKey: 'garden', state: dto }; }
    await route.fulfill({ status, json: body, headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' } });
  });
  await page.clock.setFixedTime(1_000_000);
  await page.goto(base + '/play/app/?key=backyard');
  console.log('페이지 진입', page.url());
  const frame = () => page.frames().find(candidate => candidate.url().includes('/miniapps/backyard/index.html'));
  await page.frameLocator('iframe').locator('#play').waitFor({ state: 'visible' });
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  results.checks.push('실제 export 쿼리 직진입 + allow-scripts + ready/GET 복원');
  for (const width of [320, 360, 430]) {
    await page.locator('iframe').evaluate((element, value) => { element.style.width = value + 'px'; element.style.maxWidth = 'none'; }, width);
    const bounds = await frame().evaluate(() => ['yard', 'hint', 'buy-p', 'buy-w', 'buy-c', 'move', 'cancel'].map(id => { const rect = document.getElementById(id).getBoundingClientRect(); return { id, x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, height: rect.height }; }));
    assert(bounds.every(rect => rect.x >= 0 && rect.right <= width && rect.y >= 0 && rect.bottom <= 470));
    assert(bounds.filter(rect => rect.id.startsWith('buy-') || ['move', 'cancel'].includes(rect.id)).every(rect => rect.height >= 44));
    results.widths.push({ width, bounds });
    await page.locator('iframe').screenshot({ path: resolve(evidence, `layout-${width}.png`) });
  }
  const tap = async index => frame().locator('#yard').click({ position: { x: index % 4 * 70 + 35, y: Math.floor(index / 4) * 70 + 35 } });
  for (const index of [0, 1, 2]) await tap(index);
  await frame().locator('#buy-p').click(); await tap(4);
  await frame().locator('#move').click(); await tap(4); await tap(5);
  await frame().locator('#move').click(); await tap(5); await tap(0);
  await frame().locator('#save').filter({ hasText: '저장됨' }).waitFor();
  const saved = structuredClone(dto);
  await page.reload(); await page.frameLocator('iframe').locator('#play').waitFor({ state: 'visible' });
  assert.deepEqual(dto, saved);
  const loaded = await frame().evaluate(async () => await MiniApp.state.get('garden'));
  assert.deepEqual(loaded, saved);
  results.checks.push('수확 3→구매→이동→swap→페이지 재진입 DTO 일치');

  // 성장 주기는 실제 rules와 app의 절대 시각을 사용한다.
  dto = { v: 1, t: 1000, s: 1, f: 0, n: 0, k: ['p', 'w', 'c'], p: ['p:0:11800', 'p:1:9100', 'w:2'] };
  await page.reload(); await page.frameLocator('iframe').locator('#play').waitFor({ state: 'visible' });
  await frame().locator('#move').click(); await tap(2); await tap(15);
  await frame().locator('#save').filter({ hasText: '저장됨' }).waitFor();
  assert(dto.p.includes('p:0:11800') && dto.p.includes('p:1:9100'));
  await page.clock.setFixedTime(9_099_000); await tap(1); assert.equal(dto.f, 0);
  await page.clock.setFixedTime(9_100_000); await tap(1); await frame().locator('#save').filter({ hasText: '저장됨' }).waitFor(); assert.equal(dto.f, 1);
  await page.clock.setFixedTime(11_799_000); await tap(0); assert.equal(dto.f, 1);
  await page.clock.setFixedTime(11_800_000);
  await page.locator('iframe').screenshot({ path: resolve(evidence, 'grown-10800.png') });
  await tap(0); await frame().locator('#save').filter({ hasText: '저장됨' }).waitFor(); assert.equal(dto.f, 2);
  const ready = dto.p.find(item => item.startsWith('p:0:'));
  await page.clock.setFixedTime(1_000_000_000);
  assert(dto.p.includes(ready)); await tap(0); await frame().locator('#save').filter({ hasText: '저장됨' }).waitFor(); assert.equal(dto.f, 3);
  results.checks.push('가짜 시각 8100/10800초 경계·익은 채 유지·우물 이동 시 readyAt 불변');

  dto = { v: 1, t: 1000, s: 1, f: 5, n: 0, k: ['p', 'w', 'c'], p: Array.from({ length: 16 }, (_, index) => index === 0 ? 'w:0' : index === 1 ? 'c:1' : `p:${index}:1000`) };
  await page.reload(); await page.frameLocator('iframe').locator('#complete').waitFor({ state: 'visible' });
  assert.equal(await frame().locator('#play').evaluate(element => element.inert), true);
  await page.locator('iframe').screenshot({ path: resolve(evidence, 'complete.png') });
  await frame().locator('#close-complete').click(); await frame().locator('#move').click(); await tap(0); await tap(1);
  await frame().locator('#save').filter({ hasText: '저장됨' }).waitFor();
  assert(dto.p.includes('w:1') && dto.p.includes('c:0'));
  assert.deepEqual(Object.keys(dto).sort(), ['f', 'k', 'n', 'p', 's', 't', 'v']);
  await page.locator('iframe').screenshot({ path: resolve(evidence, 'complete-swap.png') });
  results.checks.push('완료 대화상자·배경 inert·닫은 뒤 16칸 swap·완료 플래그 없음');
  assert.equal(results.errors.length, 0, JSON.stringify(results.errors));
  results.normalErrors = [...results.errors];
  results.checks.push('정상 통합 과정 JS/CORS/리소스 로드 오류 0');
  const before = results.requests.filter(item => item.method === 'PUT').length;
  failGet = true; await page.reload(); await page.frameLocator('iframe').locator('#retry').waitFor({ state: 'visible' });
  assert.equal(results.requests.filter(item => item.method === 'PUT').length, before);
  results.injectedFailureErrors = results.errors.slice(results.normalErrors.length);
  results.checks.push('초기 GET 503에서 PUT 0');
  results.lifecycle = await frame().evaluate(await readFile(resolve('scripts/verify-backyard/lifecycle.js'), 'utf8'));
  results.checks.push('실제 Chromium에서 20회 생성/해제 후 리스너·RAF·timer·observer 모두 0');
  await writeFile(resolve(evidence, 'export-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) { console.error(JSON.stringify(results, null, 2)); throw error; } finally { await browser.close(); await new Promise(done => server.close(done)); }
