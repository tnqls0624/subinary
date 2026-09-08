/**
 * 뒷마당 3D 그래픽 미리보기 촬영.
 *
 * 제품 스크립트(`rpg3d-scene.js` 등)를 그대로 로드해 실제 화면을 찍는다.
 * 저장·API·운영 스택을 건드리지 않는다 — 정적 파일만 서빙한다.
 *
 *   node scripts/preview-backyard/shot.mjs [출력디렉터리]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = resolve(process.cwd(), 'apps/web/public');
const harness = resolve(process.cwd(), 'scripts/preview-backyard/index.html');
const out = resolve(process.argv[2] || '/tmp/backyard-preview');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url || '/').split('?')[0]);
  try {
    // 하네스는 public/ 밖에 둔다. public/은 정적 export로 폰까지 나가는 경로다.
    const file = path === '/' ? harness : join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404).end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
await mkdir(out, { recursive: true });

/** 촬영 시나리오. 논리 좌표는 rpg-rules의 지도 단위다. */
const shots = [
  { name: '01-집앞', place: [352, 512, 6], pose: [0, false] },
  { name: '02-나무그늘', place: [240, 288, 2], pose: [12, true] },
  { name: '03-연못가', place: [600, 400, 0], pose: [0, false] },
  { name: '04-오솔길', place: [528, 240, 6], pose: [7, true] },
  { name: '05-저녁-집앞', place: [352, 512, 6], pose: [0, false], hour: 18.3 },
  { name: '06-밤-연못', place: [600, 400, 0], pose: [0, false], hour: 22 },
];

const problems = [];
for (const device of [{ id: 'phone', width: 390, height: 844 }, { id: 'wide', width: 900, height: 600 }]) {
  const page = await browser.newPage({ viewport: { width: device.width, height: device.height }, deviceScaleFactor: 2 });
  page.on('pageerror', error => problems.push(`${device.id} pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.log('console:', message.text()); if (message.type() === 'error') problems.push(`${device.id} console: ${message.text()}`); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  const failed = await page.evaluate(() => window.__previewError || '');
  if (failed) { problems.push(`${device.id} scene: ${failed}`); break; }
  await page.waitForFunction(() => window.__ready && window.__ready(), null, { timeout: 20000 });
  for (const shot of shots) {
    await page.evaluate(([p, pose, hour]) => { window.__hour(hour); window.__place(p[0], p[1], p[2]); window.__pose(pose[0], pose[1]); window.__advance(1200); }, [shot.place, shot.pose, shot.hour ?? 12.5]);
    await page.screenshot({ path: join(out, `${device.id}-${shot.name}.png`) });
  }
  const stats = await page.evaluate(() => {
    const host = document.getElementById('host');
    return { calls: host.dataset.calls, triangles: host.dataset.triangles, points: host.dataset.points, cpu: host.dataset.renderCpuMs };
  });
  console.log(`${device.id}: draw calls ${stats.calls} · triangles ${stats.triangles} · points(밤) ${stats.points} · CPU ${stats.cpu}ms`);
  await page.close();
}
await browser.close();
server.close();
if (problems.length) { console.error('문제:\n' + problems.join('\n')); process.exit(1); }
console.log('저장 위치: ' + out);
