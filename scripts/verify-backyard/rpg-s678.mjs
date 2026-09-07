/** 정적 export의 실제 쿼리 페이지를 격리 API fixture와 함께 검증한다. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/out');
const evidence = resolve('docs/evidence/rpg-s678');
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
    else if (path === '/v1/auth/me') body = { user, memberships: [{ householdId: 'verify-household', householdName: '검증 가구', role: 'owner' }] };
    else if (path === '/v1/play/backyard') { body = { items: Object.entries(dto).map(([stateKey,state])=>({stateKey,state})) }; if (failGet) status = 503; }
    else if (path.startsWith('/v1/play/backyard/') && req.method() === 'PUT') { const key=path.split('/').at(-1);if(failPut&&key==='rpg_collection'){status=503;body={error:'isolated-put-failure'};}else{dto[key]=req.postDataJSON().state;body={stateKey:key,state:dto[key]};} }
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
  // 위치만 고정하는 명시적 저장 fixture: 획득은 실제 화면 버튼을 누른다.
  async function position(x,y,direction=0){
    dto.rpg_player={v:2,mapVersion:1,x:x/2,y:y/2,direction,outfit:0,t:0};
    await page.reload();await ready();
  }
  async function ack(){await frame().locator('#save').filter({hasText:'저장됨'}).waitFor();}
  dto.rpg_world.items=['0:p:3:20','1:w:4:20','2:c:6:20'];
  await position(176,592);
  await frame().locator('#action').filter({hasText:'말 걸기'}).click();
  await frame().locator('#dialogue').waitFor({state:'visible'});await ack();
  const beforeChair=await frame().locator('#dialogue-text').textContent();
  await page.locator('iframe').screenshot({path:resolve(evidence,'chair-before.png')});
  await frame().locator('#close-dialogue').click();
  // 기존 꾸미기 UI로 의자 이동: 작업대→의자 앞→새 자리→확정.
  await position(280,592);
  await frame().locator('#action').click();
  await frame().locator('#editor').waitFor({state:'visible'});
  async function walk(key,ms){await frame().locator('#pad').focus();await page.keyboard.down(key);await page.waitForTimeout(ms);await page.keyboard.up(key);}
  async function axis(axis,target){
    await page.waitForTimeout(1200);
    for(let i=0;i<8;i++){
      const difference=target-dto.rpg_player[axis]*2;if(Math.abs(difference)<=3)return;
      const key=axis==='x'?(difference>0?'ArrowRight':'ArrowLeft'):(difference>0?'ArrowDown':'ArrowUp');
      await walk(key,Math.min(450,Math.max(40,Math.abs(difference)/96*1000)));
      await page.waitForTimeout(1200);
    }
    throw Error('이동 목표 미도달: '+JSON.stringify({axis,target,player:dto.rpg_player}));
  }
  await axis('x',208);await axis('y',624);
  await frame().locator('#move').click();
  assert.match(await frame().locator('#feedback').textContent(),/새 자리를/);
  await axis('x',176);await axis('y',688);await walk('ArrowRight',40);
  await frame().locator('#action').click();
  assert.match(await frame().locator('#feedback').textContent(),/앞에 놓았어요/);await ack();
  const movedChair=dto.rpg_world.items.find(t=>t.startsWith('2:'));
  assert.notEqual(movedChair,'2:c:6:20');
  await position(176,592);
  await frame().locator('#action').filter({hasText:'말 걸기'}).click();await ack();
  const afterChair=await frame().locator('#dialogue-text').textContent();
  assert.notEqual(beforeChair,afterChair);
  results.chair={before:beforeChair,after:afterChair,movedChair};
  await page.locator('iframe').screenshot({path:resolve(evidence,'chair-after.png')});
  results.checks.push('실제 꾸미기 UI 의자 이동→world PUT→가까운 모루의 새 대사');
  for(const [name,x,y,direction]of [['moru',176,592,0],['duri',464,144,6],['sodam',560,272,0]]){
    await position(x,y,direction);await page.locator('iframe').screenshot({path:resolve(evidence,name+'.png')});
  }
  const transcript=[];
  for(let resident=0;resident<3;resident++){
    const positions=[[176,592,0],[464,144,6],[560,272,0]];await position(...positions[resident]);
    await frame().locator('#action').filter({hasText:'말 걸기'}).click();await ack();
    for(let i=0;i<10;i++){
      const line=await frame().locator('#dialogue-text').textContent();assert(!/[{}]|undefined|null/.test(line));transcript.push(line);
      await frame().locator('#talk-next').click();await ack();
    }
  }
  results.transcript=transcript;results.checks.push('실제 주민 대화 30회 빈 슬롯 없음');
  const nodes=await frame().evaluate(()=>BackyardRpgLife.nodes);
  for(const node of nodes){
    await position(node.x,node.y+32,6);
    const start=results.requests.length;
    await frame().locator('#action').filter({hasText:/따기|줍기|잡기/}).click();
    await frame().locator('#catch-card').waitFor({state:'visible'});await ack();
    const writes=results.requests.slice(start).filter(r=>r.method==='PUT'&&r.path.includes('/play/backyard/'));
    assert.deepEqual(writes.map(r=>r.path),['/v1/play/backyard/rpg_collection']);
    assert(dto.rpg_collection.nodes.some(t=>t.startsWith(node.id+':')));
  }
  assert.equal(dto.rpg_collection.species.length,8);
  await page.locator('iframe').screenshot({path:resolve(evidence,'gathered.png')});
  results.checks.push('근접 행동으로 채집 8종·자연12점 획득, 각 collection PUT 하나');
  const fishingSpots=[208,304,368];
  for(let spot=0;spot<3;spot++){
    await position(592,fishingSpots[spot]);
    const before=JSON.stringify(dto.rpg_collection);
    await frame().locator('#action').filter({hasText:'낚시하기'}).click();
    await frame().locator('#cancel-fishing').click();assert.equal(JSON.stringify(dto.rpg_collection),before);
    const amount=spot===1?2:3;
    for(let i=0;i<amount;i++){
      await frame().locator('#action').filter({hasText:'낚시하기'}).click();
      await frame().locator('#action').filter({hasText:'끌어올리기'}).waitFor();
      await page.locator('iframe').screenshot({path:resolve(evidence,`fishing-${spot}-bite.png`)});
      if(spot===0&&i===0){
        // 실제 60초 대기 후에도 입질 유지. 단위 가상시계와 별도로 검증한다.
        await page.waitForTimeout(60000);
        assert.equal(await frame().locator('#action').textContent(),'끌어올리기');
      }
      await frame().locator('#action').click();
      await frame().locator('#catch-card').waitFor({state:'visible'});await ack();
      await frame().locator('#close-card').click();
    }
  }
  assert.equal(dto.rpg_collection.species.length,16);
  results.checks.push('실제 3점 낚시 8종·취소 수량 0·입질 실제 60초 후 획득');
  // 도감 UI는 만들지 않고 패널 수명 계약을 이벤트로 검증한다.
  await position(592,304);
  await frame().locator('#action').click();
  await frame().evaluate(()=>document.dispatchEvent(new CustomEvent('backyard.panel',{detail:{open:true}})));
  await page.waitForTimeout(4500);
  assert.match(await frame().locator('#action').textContent(),/기다려요|낚시하기/);
  await frame().evaluate(()=>document.dispatchEvent(new CustomEvent('backyard.panel',{detail:{open:false}})));
  await frame().locator('#action').filter({hasText:'끌어올리기'}).waitFor();
  const beforeResume=structuredClone(dto.rpg_collection);
  // visibilitychange를 주입하고 실제 복귀 재읽기 경로를 통과시킨다.
  await frame().evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(200);
  await frame().evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
  await ack();await frame().locator('#action').filter({hasText:'끌어올리기'}).waitFor();
  await frame().locator('#action').click();await frame().locator('#catch-card').waitFor({state:'visible'});await ack();
  const total=c=>c.species.reduce((sum,t)=>sum+Number(t.split(':')[1]),0);
  assert.equal(total(dto.rpg_collection)-total(beforeResume),1);
  results.checks.push('패널 일시정지·visibility 숨김/복귀 주입 뒤 획득 정확히 1개');
  await position(592,304);
  await frame().locator('#action').click();await frame().locator('#action').filter({hasText:'끌어올리기'}).waitFor();
  const beforeFailure=structuredClone(dto.rpg_collection);failPut=true;
  await frame().locator('#action').click();await frame().locator('#retry-save').waitFor({state:'visible'});
  assert.deepEqual(dto.rpg_collection,beforeFailure);
  assert.match(await frame().locator('#catch-text').textContent(),/저장 후 계속/);
  await frame().locator('#action').click();
  assert.match(await frame().locator('#feedback').textContent(),/저장 후 계속/);
  failPut=false;await frame().locator('#retry-save').click();await ack();
  assert.equal(total(dto.rpg_collection)-total(beforeFailure),1);
  results.checks.push('실제 collection PUT 503→새 획득 잠금→다시→수량 정확히 1개 저장');
  const saved=structuredClone(dto);
  await page.locator('iframe').screenshot({path:resolve(evidence,'all-species.png')});
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
