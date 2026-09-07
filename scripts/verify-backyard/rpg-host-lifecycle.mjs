/** 정적 export의 실제 쿼리 페이지를 격리 API fixture와 함께 검증한다. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/out');
const evidence = resolve('docs/evidence/rpg-closeout');
await mkdir(evidence, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  try {
    let file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + sep)) throw Error('검증 경로 밖');
    if ((await stat(file)).isDirectory()) file = resolve(file, req.headers.rsc === '1' ? 'index.txt' : 'index.html');
    res.setHeader('Content-Type', req.headers.rsc === '1' ? 'text/x-component' : mime[extname(file)] || 'application/octet-stream');
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
  let failGet = false, failPut = false;
  const user = { id: 'verify-user', email: 'verify@example.invalid', name: '검증', displayName: '검증' };
  // 모든 API 요청을 격리한다. 운영 서버로 전달하지 않는다.
  await page.route('**/v1/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    results.requests.push({ method: req.method(), path });
    let body = { items: [], count: 0, unreadCount: 0 };
    let status = 200;
    if (path === '/v1/card-sms-events') body = [];
    else if (path === '/v1/auth/refresh') body = { user, tokens: { accessToken: 'isolated-verification-token' } };
    else if (path === '/v1/auth/me') body = { user, memberships: [{ householdId: 'verify-household', householdName: '검증 가구', name: '검증 가구', role: 'owner' }, {householdId:'verify-second',householdName:'다른 검증 가구',name:'다른 검증 가구',role:'owner'}] };
    else if (path === '/v1/play/backyard') { body = { items: Object.entries(dto).map(([stateKey,state])=>({stateKey,state})) }; if (failGet) status = 503; }
    else if (path.startsWith('/v1/play/backyard/') && req.method() === 'PUT') { const key=path.split('/').at(-1); if(failPut){status=503;body={message:'의도한 저장 실패'};}else{dto[key]=req.postDataJSON().state; body={stateKey:key,state:dto[key]};} }
    await route.fulfill({ status, json: body, headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' } });
  });
  const instrumentation=await readFile(resolve('scripts/verify-backyard/rpg-lifecycle.js'),'utf8');
  const engine=await readFile(resolve(root,'miniapps/backyard/rpg-engine.js'),'utf8');
  await page.route('**/rpg-engine.js',route=>route.fulfill({contentType:'text/javascript',body:instrumentation+';window.__documentId=crypto.randomUUID();'+engine}));
  const frame=()=>page.frames().find(f=>f.url().includes('/miniapps/backyard/index.html'));
  const ready=()=>page.frameLocator('iframe').locator('#world[data-ready=true]').waitFor();
  const snapshot=()=>frame().evaluate(()=>({documentId:window.__documentId,counts:window.__life.counts(),totals:window.__life.totals()}));
  const detached=[];
  page.on('framedetached',f=>{if(f.url().includes('/miniapps/backyard/'))detached.push(f.url());});
  await page.addInitScript(()=>{
    if(window.parent!==window)return;
    const add=window.addEventListener,remove=window.removeEventListener,handlers=new Set();
    window.addEventListener=function(type,handler,options){if(type==='message')handlers.add(handler);return add.call(this,type,handler,options);};
    window.removeEventListener=function(type,handler,options){if(type==='message')handlers.delete(handler);return remove.call(this,type,handler,options);};
    window.__hostMessageCount=()=>handlers.size;
  });
  await page.goto(base+'/play/');
  await page.locator('a[href*="key=backyard"]').waitFor();
  const hostBaseline=await page.evaluate(()=>window.__hostMessageCount());
  const parentId=await page.evaluate(()=>window.__parentIdentity=crypto.randomUUID());
  results.cycles=[];
  for(let cycle=1;cycle<=20;cycle++){
    failPut=false;
    await page.locator('a[href*="key=backyard"]').click();await ready();
    assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
    const current=frame(),active=await snapshot();
    assert.equal(active.totals.createdGames,1);assert.equal(active.counts.games,1);assert.equal(active.counts.scenes,3);
    if(cycle===1){
      await page.setViewportSize({width:430,height:300});
      await page.getByText('세로로 돌려서 계속하기').waitFor();
      const paused=await snapshot();
      await page.setViewportSize({width:430,height:900});await ready();
      const resumed=await snapshot();
      assert.equal(paused.documentId,active.documentId);assert.equal(resumed.documentId,active.documentId);
      assert.equal(resumed.totals.createdGames,1);
      results.viewport={active,paused,resumed};
    }
    failPut=true;
    // 회차마다 새 종의 수량을 올려 실패 재시도 timer가 존재하도록 한다.
    await current.evaluate(()=>{
      const original=window.MiniApp.state.set;
      window.MiniApp.state.set=async()=>{throw {code:'host_error'};};
      window.__life.failSave();
      window.MiniApp.state.set=original;
    });
    await current.waitForFunction(()=>window.__life.retryPending());
    const pending=await snapshot();assert(pending.counts.timers>=1);
    await page.goBack();await page.locator('a[href*="key=backyard"]').waitFor();
    assert(current.isDetached());assert.equal(await page.locator('iframe').count(),0);
    assert.equal(await page.evaluate(()=>window.__parentIdentity),parentId);
    const hostListeners=await page.evaluate(()=>window.__hostMessageCount());assert.equal(hostListeners,hostBaseline);
    results.cycles.push({cycle,active,pending,hostListeners,detached:current.isDetached(),remainingGameFrames:page.frames().filter(f=>f.url().includes('/miniapps/backyard/')).length});
  }
  assert.equal(new Set(results.cycles.map(c=>c.active.documentId)).size,20);
  assert.equal(detached.length,20);
  results.realExit={hostMessageListenersBaseline:hostBaseline,hostMessageListenersFinal:await page.evaluate(()=>window.__hostMessageCount()),entries:20,detachedDocuments:20,remainingGameFrames:0,liveDocumentResources:{games:0,scenes:0,listeners:0,pointerListeners:0,raf:0,timers:0,observers:0}};
  failPut=false;failGet=true;
  await page.locator('a[href*="key=backyard"]').click();
  await page.frameLocator('iframe').locator('#failure').waitFor({state:'visible'});
  const failedFrame=frame(),failed=await snapshot();assert.equal(failed.totals.createdGames,0);
  failGet=false;await failedFrame.locator('#retry').click();await ready();
  const retried=await snapshot();assert.notEqual(retried.documentId,failed.documentId);assert.equal(retried.totals.createdGames,1);
  results.loadRetry={failed,retried,newDocument:true};
  const beforeKey=frame(),keySnapshot=await snapshot();
  await page.evaluate(()=>history.pushState(null,'','/play/app/?key=not-registered'));
  await page.getByText('없는 미니앱이에요').waitFor();assert(beforeKey.isDetached());
  await page.evaluate(()=>history.pushState(null,'','/play/app/?key=backyard'));await ready();
  const afterKey=await snapshot();assert.notEqual(afterKey.documentId,keySnapshot.documentId);
  results.appKeyChange={before:keySnapshot,after:afterKey,newDocument:true};
  const beforeHousehold=frame(),householdSnapshot=await snapshot();
  await page.getByRole('button',{name:'검증 가구',exact:true}).click();
  await page.getByRole('menuitem').filter({hasText:'다른 검증 가구'}).click();
  await page.waitForFunction(()=>document.querySelector('iframe')!==null);
  await page.waitForTimeout(200);await ready();
  const afterHousehold=await snapshot();assert(beforeHousehold.isDetached());assert.notEqual(afterHousehold.documentId,householdSnapshot.documentId);
  assert.equal(afterHousehold.totals.createdGames,1);
  results.householdChange={before:householdSnapshot,after:afterHousehold,newDocument:true};
  results.normalErrors=results.errors.filter(message=>!message.includes('503'));
  assert.deepEqual(results.normalErrors,[]);
  console.log(JSON.stringify(results,null,2));
} finally {
  await writeFile(resolve(evidence,'host-lifecycle.json'),JSON.stringify(results,null,2)+'\n');
  await browser.close();await new Promise(done=>server.close(done));
}
