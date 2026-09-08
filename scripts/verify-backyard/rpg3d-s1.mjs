/** 실제 배포 fixture 및 기존 2D를 로컬 격리 서버에서 비교한다. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const {chromium,devices}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||resolve(homedir(),'.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root=resolve('apps/web/public'),evidence=resolve('docs/evidence/rpg3d-s1');
await mkdir(evidence,{recursive:true});
const requests=[];
const server=createServer(async(req,res)=>{
  requests.push({method:req.method,url:req.url});
  try{
    let file=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!file.startsWith(root+sep))throw Error('허용 경로 밖');
    if((await stat(file)).isDirectory())file=resolve(file,'index.html');
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]||'application/octet-stream');
    res.end(await readFile(file));
  }catch{res.writeHead(404);res.end('not found');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const results={browser:browser.version(),environment:'macOS 데스크톱 Chromium; 모바일 에뮬레이션은 실기기 성능 증거가 아님',screens:[],checks:[],errors:[],mobileFirstFrame:'확인 못 함 — 연결된 대표 실기기 없음'};
/** 같은 픽셀 크기의 원본 캡처를 브라우저에서 나란히 배치한다. */
async function compare(files,labels,name,width,height){
  const page=await browser.newPage({viewport:{width:width*2,height:height+48},deviceScaleFactor:1});
  const images=await Promise.all(files.map(file=>readFile(resolve(evidence,file))));
  await page.setContent(`<html lang="ko"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#f5f3e9;color:#394b36;font:14px system-ui;display:flex}figure{margin:0;width:${width}px}figcaption{height:48px;display:grid;place-items:center}img{display:block;width:${width}px;height:${height}px}</style>${images.map((bytes,i)=>`<figure><figcaption>${labels[i]}</figcaption><img src="data:image/png;base64,${bytes.toString('base64')}"></figure>`).join('')}</html>`);
  await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  await page.screenshot({path:resolve(evidence,name),scale:'css'});await page.close();
}
try{
  for(const size of [{width:360,height:800},{width:800,height:360}]){
    const page=await browser.newPage({viewport:size,deviceScaleFactor:1.5});
    page.on('pageerror',e=>results.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')results.errors.push(m.text());});
    const network=[];page.on('request',r=>network.push({url:r.url(),method:r.method()}));
    // 숨은 저장 호출도 실패시킨다. fixture에는 bridge 자체가 없다.
    await page.addInitScript(()=>{
      Storage.prototype.getItem=()=>{throw Error('fixture 저장 읽기 금지');};
      Storage.prototype.setItem=()=>{throw Error('fixture 저장 쓰기 금지');};
      window.fetch=()=>{throw Error('fixture fetch 금지');};
    });
    await page.goto(base+'/miniapps/backyard/rpg3d-fixture.html');
    await page.locator('#fixture[data-ready=true]').waitFor();
    const data=await page.locator('#fixture').evaluate(element=>({...element.dataset}));
    assert.equal(data.treeCount,'12');assert.equal(data.terrainVertices,'825');
    assert(Number(data.characterHeightPercent)>=12&&Number(data.characterHeightPercent)<=16);
    assert(Number(data.characterCenterPercent)>=55&&Number(data.characterCenterPercent)<=60);
    assert.equal(await page.locator('iframe').count(),0);
    assert.equal(await page.locator('canvas').count(),1);
    const name=`3d-${size.width}x${size.height}`;
    await page.screenshot({path:resolve(evidence,name+'.png'),scale:'css'});
    await page.locator('#lighting').click();assert.equal(await page.locator('#lighting').getAttribute('aria-pressed'),'false');
    await page.screenshot({path:resolve(evidence,name+'-unlit.png'),scale:'css'});
    await page.locator('#lighting').click();assert.equal(await page.locator('#lighting').getAttribute('aria-pressed'),'true');
    assert(network.every(r=>r.method==='GET'&&r.url.startsWith(base)));
    assert(!network.some(r=>/bridge|session|codec|phaser|\.(png|jpg|webp|hdr)/.test(r.url)));
    results.screens.push({size,data,network});
    // 같은 문서에서 회전한 후 동일한 지도 anchor와 조명 상태를 유지한다.
    await page.setViewportSize({width:size.height,height:size.width});
    assert.equal(await page.locator('#fixture').getAttribute('data-anchor'),data.anchor);
    const dimensions=await page.locator('canvas').evaluate(c=>({w:c.clientWidth,h:c.clientHeight,pixels:c.width*c.height}));
    assert.equal(dimensions.w,size.height);assert.equal(dimensions.h,size.width);assert(dimensions.pixels<=1500000);
    // 실제 WebGL loss/restore 이벤트와 명시적 오류 안내를 확인한다.
    await page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2');window.__contextExtension=gl.getExtension('WEBGL_lose_context');window.__contextExtension.loseContext();});
    await page.locator('#failure').waitFor({state:'visible'});
    await page.screenshot({path:resolve(evidence,name+'-context-loss.png'),scale:'css'});
    await page.evaluate(()=>window.__contextExtension.restoreContext());
    await page.locator('#fixture[data-ready=true]').waitFor();
    await page.locator('#failure').waitFor({state:'hidden'});
    await page.close();
    await compare([name+'.png',name+'-unlit.png'],['3D · 반구광 + 햇살 + 그림자','3D · 조명 없음 / 동일 재질색'],`lighting-${size.width}x${size.height}.png`,size.width,size.height);

    const old=await browser.newPage({viewport:size,deviceScaleFactor:1});
    // 기존 제품 JS는 수정하지 않고 bridge 경계만 메모리 fixture로 대체한다.
    await old.route('**/miniapps/bridge.js',route=>route.fulfill({contentType:'text/javascript',body:`window.MiniApp={ready:async()=>{},state:{get:async key=>{const data=BackyardRpgCodec.initial();const point=BackyardRpgRules.required[2];data.rpg_player.x=point.x/2;data.rpg_player.y=point.y/2;data.rpg_player.direction=2;return data[key]??null;},set:async()=>{throw Error('2D 비교 fixture는 저장하지 않습니다');}}};`}));
    await old.goto(base+'/miniapps/backyard/index.html');await old.locator('#world[data-ready=true]').waitFor();
    const oldName=`2d-${size.width}x${size.height}.png`;
    await old.screenshot({path:resolve(evidence,oldName),scale:'css'});await old.close();
    await compare([oldName,name+'.png'],['기존 2D · 같은 지도 위치','3D 슬라이스 1 · 같은 지도 위치'],`compare-${size.width}x${size.height}.png`,size.width,size.height);
  }
  results.checks.push('360×800 / 800×360, 동일 anchor·12그루·825정점·canvas 1·iframe 0','조명 on/off와 회전, 내부 150만 픽셀 제한','3D 저장 API/Storage 호출 0·CDN/이미지 요청 0','WebGL context loss 오류 UI 및 restore 뒤 같은 장면 복원');
  results.emulatedTiming=[];
  for(const deviceName of ['Pixel 5','iPhone 13']){
    const context=await browser.newContext({...devices[deviceName]});const page=await context.newPage();
    const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    for(let run=0;run<3;run++){
      await cdp.send('Network.clearBrowserCache');await page.goto(base+'/miniapps/backyard/rpg3d-fixture.html');await page.locator('#fixture[data-ready=true]').waitFor();
      results.emulatedTiming.push({deviceName,run,cpuThrottle:4,engine:'Chromium (iPhone도 WKWebView 아님)',data:await page.locator('#fixture').evaluate(e=>({...e.dataset}))});
    }await context.close();
  }
  const broken=await browser.newPage();await broken.route('**/three-r128.min.js',r=>r.fulfill({contentType:'text/javascript',body:'window.THREE={REVISION:"wrong"};'}));
  await broken.goto(base+'/miniapps/backyard/rpg3d-fixture.html');await broken.locator('#failure').waitFor({state:'visible'});assert.match(await broken.locator('#failure-detail').textContent(),/r128/);await broken.close();
  results.checks.push('동봉 엔진 버전 불일치 오류 UI');
  assert.deepEqual(results.errors,[]);
  await writeFile(resolve(evidence,'browser-results.json'),JSON.stringify({...results,requests},null,2));
  console.log(JSON.stringify(results,null,2));
}finally{await browser.close();await new Promise(done=>server.close(done));}
