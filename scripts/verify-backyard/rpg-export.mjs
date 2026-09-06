/** 정적 export의 실제 쿼리 페이지를 격리 API fixture와 함께 검증한다. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/out');
const evidence = resolve('docs/evidence/rpg-s1');
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
  await page.addInitScript(() => {
    let phaser;
    Object.defineProperty(window, 'Phaser', { configurable: true, get: () => phaser, set(value) {
      phaser = value;
      const Game = value.Game;
      value.Game = class extends Game { constructor(config) { super(config); window.__rpgGame = this; } };
    }});
  });
  await page.goto(base + '/play/app/?key=backyard');
  const frame = () => page.frames().find(candidate => candidate.url().includes('/miniapps/backyard/index.html'));
  await page.frameLocator('iframe').locator('#world[data-ready="true"]').waitFor();
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  const snapshot = () => frame().evaluate(() => {
    const scene = window.__rpgGame.scene.getScene('World');
    const body = scene.physics.world.bodies.values().next().value;
    const camera = scene.cameras.main;
    return {x:body.gameObject.x,y:body.gameObject.y,vx:body.velocity.x,vy:body.velocity.y,
      camera:{x:camera.scrollX,y:camera.scrollY,width:camera.width,height:camera.height},
      body:{x:body.x,y:body.y,width:body.width,height:body.height},texture:body.gameObject.texture.key};
  });
  await frame().evaluate(()=>{
    window.__cameraViolations=[];
    window.__rpgGame.events.on('poststep',()=>{
      const camera=window.__rpgGame.scene.getScene('World').cameras.main;
      if(camera.scrollX < -0.01 || camera.scrollY < -0.01 || camera.scrollX+camera.width>1024.01 || camera.scrollY+camera.height>768.01)
        window.__cameraViolations.push({x:camera.scrollX,y:camera.scrollY});
    });
  });
  const walk = async (keys,ms) => {
    for(const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    for(const key of keys) await page.keyboard.up(key);
    await page.waitForTimeout(50);
    return snapshot();
  };
  await frame().locator('#pad').focus();
  results.start = await snapshot();
  await page.screenshot({path:resolve(evidence,'start.png')});
  results.walk=[];
  const startTime=Date.now();
  for(const [keys,ms] of [[['ArrowRight'],3000],[['ArrowUp'],3000],[['ArrowRight'],900]]) results.walk.push(await walk(keys,ms));
  await page.screenshot({path:resolve(evidence,'pond.png')});
  results.pond=await snapshot();
  assert(results.pond.camera.x+results.pond.camera.width>640);
  assert(results.pond.camera.x>300 || results.pond.camera.y+results.pond.camera.height<436);
  for(const [keys,ms] of [[['ArrowUp'],4000],[['ArrowLeft'],5000],[['ArrowDown'],5000],[['ArrowLeft'],5000],[['ArrowDown'],6000],[['ArrowRight'],10000],[['ArrowUp'],8000],[['ArrowLeft'],11000]]) results.walk.push(await walk(keys,ms));
  results.walkElapsedMs=Date.now()-startTime;
  assert(results.walkElapsedMs>=60000);
  results.cameraViolations=await frame().evaluate(()=>window.__cameraViolations);
  assert.equal(results.cameraViolations.length,0);
  await page.screenshot({path:resolve(evidence,'walk-end.png')});
  const reset = async (x,y) => { await frame().evaluate(({x,y})=>{
    const scene=window.__rpgGame.scene.getScene('World');const body=scene.physics.world.bodies.values().next().value;
    body.reset(x,y);body.setVelocity(0,0);scene.cameras.main.centerOn(x,y);
  },{x,y});await page.waitForTimeout(100); };
  await reset(320,640);const straightStart=await snapshot();const straight=await walk(['ArrowRight'],3000);
  await reset(320,640);const diagonalStart=await snapshot();const diagonal=await walk(['ArrowRight','ArrowUp'],3000);
  results.distances={straight:Math.hypot(straight.x-straightStart.x,straight.y-straightStart.y),diagonal:Math.hypot(diagonal.x-diagonalStart.x,diagonal.y-diagonalStart.y)};
  results.distanceDifferencePercent=Math.abs(results.distances.straight-results.distances.diagonal)/results.distances.straight*100;
  assert(results.distanceDifferencePercent<=5);
  await reset(600,300);results.water=await walk(['ArrowRight'],1000);assert(results.water.x<=633.01);
  await reset(112,310);results.tree=await walk(['ArrowUp'],1000);assert(results.tree.y>=285.99);
  await reset(600,470);results.corner=await walk(['ArrowRight','ArrowUp'],1200);
  assert(await frame().evaluate(()=>{const b=window.__rpgGame.scene.getScene('World').physics.world.bodies.values().next().value;return BackyardRpgRules.canStand(b.gameObject.x,b.gameObject.y);}));
  await reset(320,640);
  const box=await frame().locator('#pad').boundingBox();
  await page.mouse.move(box.x+40,box.y+40);await page.mouse.down();await page.mouse.move(box.x+75,box.y+40);await page.waitForTimeout(200);
  await frame().locator('#pad').evaluate(element=>element.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
  const cancelled=await snapshot();await page.waitForTimeout(500);const later=await snapshot();
  results.cancelDrift=Math.hypot(later.x-cancelled.x,later.y-cancelled.y);assert(results.cancelDrift<=1);await page.mouse.up();
  for(const viewport of [{width:320,height:568},{width:360,height:780},{width:430,height:900}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(150);
    const bounds=await page.locator('iframe').boundingBox();
    results.widths.push({viewport,bounds});
    assert(bounds.y+bounds.height<=viewport.height-81-16+1);
    await page.screenshot({path:resolve(evidence,`layout-${viewport.width}.png`)});
  }
  await frame().locator('#pad').focus();
  await page.keyboard.down('ArrowRight');await page.waitForTimeout(150);
  await frame().evaluate(()=>window.dispatchEvent(new Event('blur')));
  const blurred=await snapshot();await page.waitForTimeout(200);const afterBlur=await snapshot();
  results.blurDrift=Math.hypot(afterBlur.x-blurred.x,afterBlur.y-blurred.y);assert(results.blurDrift<=1);await page.keyboard.up('ArrowRight');
  results.playRequests=results.requests.filter(item=>item.path.includes('/play/'));
  assert.equal(results.playRequests.length,0);
  assert.equal(results.errors.length,0,JSON.stringify(results.errors));
  results.checks.push('실제 호스트 60초 이상 산책','월드 경계 노출 0','직선/대각 3초 거리 차이 ≤5%','pointercancel 후 이동 ≤1px','물·나무·물 모서리 충돌','저장 API 요청 0');
  await page.route('**/vendor/phaser.min.js',route=>route.abort());
  const normalErrors=results.errors.length;
  await page.reload();await page.frameLocator('iframe').locator('#failure:not([hidden])').waitFor();
  results.expectedBootFailureErrors=results.errors.splice(normalErrors);
  assert.equal(results.requests.filter(item=>item.path.includes('/play/')).length,0);
  results.checks.push('blur 즉시 정지','엔진 로드 실패 HTML 오류·저장 요청 0');
  await writeFile(resolve(evidence,'export-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} catch(error) {await writeFile(resolve(evidence,'export-failure.json'),JSON.stringify(results,null,2));throw error;} finally {await browser.close();await new Promise(done=>server.close(done));}
