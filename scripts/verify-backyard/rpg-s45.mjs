/** 정적 export의 실제 쿼리 페이지를 격리 API fixture와 함께 검증한다. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/out');
const evidence = resolve('docs/evidence/rpg-s45');
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
  let dto = {};
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
    else if (path === '/v1/play/backyard') { body = { items: Object.entries(dto).map(([stateKey,state])=>({stateKey,state})) }; if (failGet) status = 503; }
    else if (path.startsWith('/v1/play/backyard/') && req.method() === 'PUT') { const key=path.split('/').at(-1); dto[key]=req.postDataJSON().state; body={stateKey:key,state:dto[key]}; }
    await route.fulfill({ status, json: body, headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' } });
  });
  await page.goto(base + '/play/app/?key=backyard');
  const frame = () => page.frames().find(candidate => candidate.url().includes('/miniapps/backyard/index.html'));
  const ready = () => page.frameLocator('iframe').locator('#world[data-ready=true]').waitFor();
  await ready();
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  assert.deepEqual(Object.keys(dto), ['rpg_world','rpg_collection','rpg_residents','rpg_player','rpg_meta']);
  results.checks.push('실제 export·opaque iframe에서 신규 4키 ACK→meta ACK→엔진 부팅');
  for (const width of [320,360,430]) {
    await page.setViewportSize({width,height:width===320?568:width===360?780:900});
    await page.locator('iframe').screenshot({path:resolve(evidence,'layout-'+width+'.png')});
  }
  dto.rpg_world.items=['0:p:8:19','1:w:4:20','2:c:5:20'];
  dto.rpg_player={v:2,mapVersion:1,x:140,y:296,direction:0,outfit:1,t:0};
  dto.rpg_collection.nodes=['pot-0:1234567890'];
  await page.reload(); await ready();
  await frame().locator('#action').click();
  await frame().locator('#editor').waitFor({state:'visible'});
  await frame().locator('#pad').focus();
  await page.keyboard.down('ArrowDown'); await page.waitForTimeout(70); await page.keyboard.up('ArrowDown');
  await frame().locator('#move').click();
  assert.match(await frame().locator('#feedback').textContent(), /새 자리를/);
  await frame().locator('#pad').focus();
  await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(700); await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('ArrowDown'); await page.waitForTimeout(430); await page.keyboard.up('ArrowDown');
  await frame().locator('#action').click();
  assert.match(await frame().locator('#feedback').textContent(), /앞에 놓았어요/);
  await frame().locator('#save').filter({hasText:'저장됨'}).waitFor();
  await page.waitForTimeout(1200);
  const saved=structuredClone(dto);
  assert.notEqual(saved.rpg_world.items.find(t=>t.startsWith('0:')), '0:p:8:19');
  assert.deepEqual(saved.rpg_collection.nodes,['pot-0:1234567890']);
  await page.locator('iframe').screenshot({path:resolve(evidence,'moved.png')});
  await page.reload(); await ready();
  assert.deepEqual(dto,saved);
  const restored=await frame().evaluate(()=>MiniApp.state.get('rpg_world'));
  assert.deepEqual(restored,saved.rpg_world);
  results.checks.push('실제 패드 키보드·꾸미기 이동→world ACK→재진입 일치 및 collection 시각 보존');
  const start=results.requests.length;
  failGet=true;await page.reload();
  await page.frameLocator('iframe').locator('#failure').waitFor({state:'visible'});
  await page.waitForTimeout(500);
  assert.equal(await frame().locator('#world').getAttribute('data-ready'),null);
  const failed=results.requests.slice(start).filter(r=>r.path.startsWith('/v1/play/backyard'));
  assert(failed.some(r=>r.method==='GET'));
  assert.equal(failed.filter(r=>r.method==='PUT').length,0);
  results.failedGetNetwork=failed;
  results.checks.push('초기 GET 503의 브라우저 네트워크 PUT=0·엔진 부팅 없음');
  await page.locator('iframe').screenshot({path:resolve(evidence,'get-failure.png')});
  results.saved=saved;
  results.normalErrors=results.errors.filter(message=>!message.includes('503'));
  assert.deepEqual(results.normalErrors,[]);
  console.log(JSON.stringify(results,null,2));
} finally {
  await writeFile(resolve(evidence,'browser-results.json'),JSON.stringify(results,null,2));
  await browser.close();
  await new Promise(done=>server.close(done));
}
