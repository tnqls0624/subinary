/** 실제 동봉 Phaser와 RPG 배포 원본의 20회 수명을 검증한다. 운영 통신은 없다. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/public/miniapps');
const evidence = resolve('docs/evidence/rpg-closeout');
await mkdir(evidence,{recursive:true});
const browser = await chromium.launch({headless:true});
const result = {browser:browser.version(),cycles:[],errors:[],network:[]};
try {
  const page = await browser.newPage({viewport:{width:430,height:640}});
  page.on('pageerror',error=>result.errors.push(error.message));
  page.on('console',entry=>{if(entry.type()==='error')result.errors.push(entry.text());});
  await page.route('**/*',route=>{result.network.push(route.request().url());return route.abort();});
  const html=await readFile(resolve(root,'backyard/index.html'),'utf8');
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,''));
  await page.addStyleTag({content:await readFile(resolve(root,'backyard/rpg-style.css'),'utf8')});
  for(const name of ['vendor/phaser.min.js','backyard/balance.js','backyard/rules.js','backyard/codec.js','backyard/rpg-codec.js','backyard/rpg-session.js','backyard/rpg-rules.js','backyard/rpg-input.js']) await page.addScriptTag({path:resolve(root,name)});
  await page.addScriptTag({path:resolve('scripts/verify-backyard/rpg-lifecycle.js')});
  result.baseline=await page.evaluate(()=>window.__life.counts());
  const engine=await readFile(resolve(root,'backyard/rpg-engine.js'),'utf8');
  for(let cycle=1;cycle<=20;cycle++){
    // 문서·DOM·계측기를 교체하지 않아 회차 사이의 잔존이 숨겨지지 않는다.
    await page.evaluate(engine);
    await page.waitForFunction(()=>document.querySelector('#world').dataset.ready==='true');
    await page.locator('#open-album').click();
    for(const tab of [1,2,0]) await page.locator(`#album-tab-${tab}`).click();
    await page.locator('#close-album').click();
    await page.evaluate(()=>window.__life.failSave());
    await page.waitForFunction(()=>window.__life.retryPending());
    const pad=await page.locator('#pad').boundingBox();
    assert(pad);
    await page.mouse.move(pad.x+pad.width/2,pad.y+pad.height/2);
    await page.mouse.down();
    const active=await page.evaluate(()=>window.__life.counts());
    assert.equal(active.games,1);assert.equal(active.scenes,3);assert.equal(active.raf,1);
    assert(active.pointerListeners>0);assert(active.timers>=1);assert.equal(active.observers,1);
    const captureBefore=await page.locator('#pad').evaluate(el=>el.hasPointerCapture(1));
    assert(captureBefore,'종료 직전 실제 브라우저 포인터 capture');
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
    // destroy는 다음 프레임에서 runDestroy를 수행하므로 원본 시계로 기다린다.
    await page.evaluate(()=>window.__life.wait(100));
    const destroyed=await page.evaluate(()=>window.__life.counts());
    const engineDestroyed=await page.evaluate(()=>window.__lastDestroyed);
    const captureAfter=await page.locator('#pad').evaluate(el=>el.hasPointerCapture(1));
    result.cycles.push({cycle,active,destroyed,engineDestroyed,captureBefore,captureAfter});
    result.remainingListeners=await page.evaluate(()=>window.__life.details());
    assert.deepEqual(engineDestroyed,{loopRunning:false,sceneCount:0,canvasConnected:false,textureCount:0});
    assert.equal(captureAfter,false);
    await page.mouse.up();
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.deepEqual(await page.evaluate(()=>window.__life.counts()),destroyed);
  }
  result.totals=await page.evaluate(()=>window.__life.totals());
  assert.deepEqual(result.totals,{createdGames:20,destroyedGames:20,createdScenes:60,destroyedScenes:60});
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.network,[]);
  result.final=await page.evaluate(()=>window.__life.counts());
  console.log(JSON.stringify(result,null,2));
  assert.deepEqual(result.final,{...result.baseline,listeners:process.argv.includes('--characterize')?40:0},'동일 문서의 Phaser 4.2.1 리스너 잔존 특성');
} finally {
  await writeFile(resolve(evidence,'same-document-lifecycle.json'),JSON.stringify(result,null,2)+'\n');
  await browser.close();
}
