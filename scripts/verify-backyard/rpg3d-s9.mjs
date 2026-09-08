/**
 * 슬라이스 9 검증 — 배포 후보와 롤백 근거.
 *
 * 세 가지를 각각 다른 방법으로 확인한다.
 *
 * 1. **정적 배포물**(브라우저 없음): `out` entry, `public/miniapps` ↔ `out/miniapps`
 *    양방향 바이트 일치, Phaser 동봉 0, 게임 경로의 이미지 에셋 0, 그리고 배포
 *    스크립트와 **같은 Info-ZIP 방식**(`cd out && zip -qr … .`)의 ZIP 실측.
 * 2. **실제 라우트의 네트워크**(브라우저): `/play/app/?key=backyard`가 만드는 요청
 *    **전부**를 기록해 CDN 요청 0 · 이미지 에셋 0 · Phaser 0을 판정한다. 슬라이스
 *    5·6·7 하네스는 `/v1/**`만 기록했으므로 이 판정을 대신할 수 없다.
 * 3. **저장 호환**(Node VM): 3D가 실제로 PUT한 5키를 **배포 codec 원본**으로 다시
 *    읽어 왕복시킨다. `rpg-codec.js`는 2D가 쓰던 것과 같은 파일이고 이번 삭제에서
 *    건드리지 않았으므로, 이것이 설계서 §10의 "2D가 같은 저장을 읽을 수 있다"는
 *    복귀 근거다. garden 원본과 rpg 5키는 지우거나 역마이그레이션하지 않는다.
 *
 * 데스크톱 Chromium 결과이며 **실기기 증거가 아니다**(슬라이스 8).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { resolve, extname, sep, relative, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/out');
const publicDir = resolve('apps/web/public');
const evidence = resolve('docs/evidence/rpg3d-s9');
await mkdir(evidence, { recursive: true });

const results = {
  browser: '', environment: 'macOS 데스크톱 Chromium; 실기기 성능·시각 승인은 여기서 판정하지 않음',
  checks: [], errors: [], artifact: {}, network: {}, saveCompat: {},
};

/** 디렉터리의 모든 파일을 상대 경로로 나열한다. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

// ── 1. 정적 배포물 ───────────────────────────────────────────────────────────
{
  for (const entry of ['index.html', 'play/app/index.html', 'play/index.html'])
    assert.equal((await stat(resolve(root, entry))).isFile(), true, `entry 없음: ${entry}`);

  // 양방향으로 비교한다. out에만 있는 파일(빌드가 끼워 넣은 것)도 드러나야 한다.
  const inPublic = (await walk(resolve(publicDir, 'miniapps'))).sort();
  const inOut = (await walk(resolve(root, 'miniapps'))).sort();
  assert.deepEqual(inOut, inPublic, 'public/miniapps 와 out/miniapps 의 파일 목록이 다름');
  const manifest = [];
  for (const path of inPublic) {
    const source = await readFile(resolve(publicDir, 'miniapps', path));
    const built = await readFile(resolve(root, 'miniapps', path));
    assert.equal(built.equals(source), true, `바이트 불일치: miniapps/${path}`);
    manifest.push({ path: `miniapps/${path}`, bytes: built.length, sha256: createHash('sha256').update(built).digest('hex') });
  }
  results.checks.push(`out entry 3개 존재, public/miniapps ↔ out/miniapps ${manifest.length}개 파일 목록·바이트·SHA-256 일치`);

  // Phaser 동봉 0 — 파일명과 내용 양쪽으로 본다. 청크 안에 섞여 들어간 경우도 잡는다.
  const all = await walk(root);
  const phaserNames = all.filter(path => /phaser/i.test(path));
  const phaserBodies = [];
  for (const path of all) {
    if (!/\.(js|css|html|json|txt|md)$/.test(path)) continue;
    const text = await readFile(resolve(root, path), 'utf8');
    if (/phaser\.min\.js|Phaser\.Game|Phaser\.Scene|Phaser\.VERSION/.test(text)) phaserBodies.push(path);
  }
  assert.deepEqual(phaserNames, [], `Phaser 파일명 잔존: ${phaserNames.join(', ')}`);
  assert.deepEqual(phaserBodies, [], `Phaser 참조 잔존: ${phaserBodies.join(', ')}`);
  results.checks.push(`Phaser 동봉 0 — 파일명 0건, ${all.length}개 파일 중 내용 참조 0건`);

  // 게임 경로의 이미지·바이너리 에셋 0. 3D는 정점 색만 쓴다.
  const assets = inPublic.filter(path => /\.(png|jpe?g|webp|gif|avif|bmp|svg|hdr|exr|ktx2|basis|glb|gltf|bin|fbx|obj|mp3|ogg|wav)$/i.test(path));
  assert.deepEqual(assets, [], `게임 경로 이미지·에셋 잔존: ${assets.join(', ')}`);
  results.checks.push('게임 경로(miniapps) 이미지·모델·오디오 에셋 0');

  // ZIP 실측 — deploy-ota-bundle.sh 와 같은 `cd out && zip -qr … .`
  const zipPath = resolve(tmpdir(), 'backyard-s9-ota.zip');
  await run('rm', ['-f', zipPath]);
  await run('zip', ['-qr', zipPath, '.'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const bundle = await readFile(zipPath);
  const files = await walk(root);
  let raw = 0;
  for (const path of files) raw += (await stat(resolve(root, path))).size;
  results.artifact = {
    method: 'deploy-ota-bundle.sh 와 동일: ( cd apps/web/out && zip -qr <path> . )',
    zipPath, files: files.length, rawBytes: raw, zipBytes: bundle.length,
    zipSha256: createHash('sha256').update(bundle).digest('hex'),
    baseline2dDeployZipBytes: 1570734, baseline2dDeployRawBytes: 5511282,
    zipDeltaVs2dDeploy: bundle.length - 1570734,
    rawDeltaVs2dDeploy: raw - 5511282,
    manifest,
  };
  results.checks.push(`OTA ZIP 실측 ${bundle.length}B (raw ${raw}B, 파일 ${files.length}개) — 2D 마지막 배포 1,570,734B 대비 ${bundle.length - 1570734}B`);
  assert.equal(bundle.length < 1570734, true, '설계서 §10 실패 조건: ZIP 이 2D 배포보다 커짐');
}

// ── 2·3. 실제 라우트 네트워크 + 저장 호환 ────────────────────────────────────
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
results.browser = browser.version();
/** 3D가 실제로 PUT한 5키. 저장 호환 검사의 입력이다. */
let dto = {};
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { results.errors.push(error.message); console.error(error.message); });
  page.on('console', entry => { if (entry.type() === 'error') results.errors.push(entry.text()); });

  // 요청을 **전부** 기록한다. route 로 가로챈 것과 실제로 나간 것을 모두 센다.
  const requests = [];
  page.on('request', req => requests.push({ method: req.method(), url: req.url(), type: req.resourceType() }));
  const failed = [];
  page.on('requestfailed', req => failed.push({ url: req.url(), error: req.failure()?.errorText ?? '' }));

  const user = { id: 'verify-user', email: 'verify@example.invalid', name: '검증', displayName: '검증' };
  const puts = [];
  /** route 로 실제 가로챈 URL. 하나도 밖으로 나가지 않았음을 이 목록으로 증명한다. */
  const intercepted = [];
  await page.route('**/v1/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    intercepted.push(req.url());
    let body = { items: [], count: 0, unreadCount: 0 };
    if (path === '/v1/card-sms-events') body = [];
    else if (path === '/v1/auth/refresh') body = { user, tokens: { accessToken: 'isolated-verification-token' } };
    else if (path === '/v1/auth/me') body = { user, memberships: [{ householdId: 'verify-household', householdName: '검증 가구', role: 'owner' }] };
    else if (path === '/v1/play/backyard') body = { items: Object.entries(dto).map(([stateKey, state]) => ({ stateKey, state })) };
    else if (path.startsWith('/v1/play/backyard/') && req.method() === 'PUT') {
      const key = path.split('/').at(-1); dto[key] = req.postDataJSON().state; puts.push(key);
      body = { stateKey: key, state: dto[key] };
    }
    await route.fulfill({ status: 200, json: body, headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' } });
  });

  const game = page.locator('[data-backyard-game]');
  await page.goto(base + '/play/app/?key=backyard');
  await game.and(page.locator('[data-ready="true"]')).waitFor();
  await page.locator('[data-save]').filter({ hasText: '저장됨' }).waitFor({ state: 'attached' });

  // 실제로 걷는다 — 저장 좌표가 초기값이 아니어야 왕복 검사가 의미를 갖는다.
  for (const key of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) {
    await page.locator('[data-pad]').focus();
    await page.keyboard.down(key); await page.waitForTimeout(500); await page.keyboard.up(key);
  }
  await page.waitForTimeout(1200);
  await page.locator('[data-save]').filter({ hasText: '저장됨' }).waitFor({ state: 'attached' });
  const shown = JSON.parse(await game.getAttribute('data-player'));

  /*
   * CDN 요청 0.
   *
   * 정적 export 는 빌드 시 `NEXT_PUBLIC_API_URL`(운영 API)을 인라인한다. 그래서
   * `/v1/**` 요청만은 같은 origin 이 아니며, 이 하네스가 **전부 route 로 가로채
   * 로컬에서 fulfill** 한다(운영 서버로 나가지 않는다). 그 밖의 외부 요청 —
   * 즉 실제 CDN·글꼴·에셋 — 은 하나도 허용하지 않는다.
   */
  const apiOrigin = 'https://app.subinary.cloud';
  const external = requests.filter(item => !item.url.startsWith(base) && !item.url.startsWith('data:') && !item.url.startsWith('blob:'));
  const externalApi = external.filter(item => item.url.startsWith(apiOrigin + '/v1/'));
  const externalOther = external.filter(item => !externalApi.includes(item));
  assert.deepEqual(externalOther, [], `CDN·외부 에셋 요청: ${JSON.stringify(externalOther)}`);
  assert.deepEqual(externalApi.map(item => item.url).sort(), [...intercepted].sort(),
    'API 요청 중 fixture 가 가로채지 못한 것이 있다 — 운영으로 나갔을 수 있다');
  // 이미지·모델·오디오 요청 0.
  const assetRequests = requests.filter(item => /\.(png|jpe?g|webp|gif|avif|bmp|hdr|exr|ktx2|basis|glb|gltf|fbx|obj|mp3|ogg|wav)(\?|$)/i.test(item.url)
    || ['image', 'media', 'font'].includes(item.type));
  assert.deepEqual(assetRequests, [], `이미지·미디어·폰트 요청: ${JSON.stringify(assetRequests)}`);
  const phaserRequests = requests.filter(item => /phaser/i.test(item.url));
  assert.deepEqual(phaserRequests, [], `Phaser 요청: ${JSON.stringify(phaserRequests)}`);
  assert.deepEqual(failed, [], `실패 요청: ${JSON.stringify(failed)}`);
  assert.deepEqual(results.errors, [], `콘솔·페이지 오류: ${JSON.stringify(results.errors)}`);

  results.network = {
    total: requests.length, sameOrigin: requests.length - external.length,
    apiInterceptedByFixture: externalApi.length, cdnOrExternalAsset: externalOther.length,
    assetRequests: 0, phaserRequests: 0, failed: 0,
    byType: requests.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] ?? 0) + 1 }), {}),
    scripts: requests.filter(item => item.type === 'script').map(item => item.url.slice(base.length)).sort(),
    puts,
  };
  results.checks.push(`실제 라우트 요청 ${requests.length}건 — 같은 origin ${requests.length - external.length}건, `
    + `운영 API ${externalApi.length}건은 전부 fixture 가 가로챔, CDN·외부 에셋 0 · 이미지/미디어/폰트 0 · Phaser 0 · 실패 0`);
  results.saveCompat.shownPlayer = shown;
} finally {
  await browser.close();
  server.close();
}

// ── 3. 저장 호환 — 배포 codec 원본으로 왕복 ─────────────────────────────────
{
  const context = createContext({});
  for (const name of ['balance', 'rules', 'codec', 'rpg-rules', 'rpg-codec'])
    runInContext(await readFile(resolve(publicDir, 'miniapps/backyard', name + '.js'), 'utf8'), context, { filename: name + '.js' });
  const codec = runInContext('BackyardRpgCodec', context);

  assert.deepEqual(Object.keys(dto).sort(), [...codec.keys].sort(), `3D가 쓴 키가 5키와 다름: ${Object.keys(dto)}`);
  const roundTrip = {};
  for (const key of codec.keys) {
    const decoded = codec.decode(key, dto[key]);
    assert.equal(decoded.status, 'ok', `${key} 를 codec 이 읽지 못함: ${JSON.stringify(decoded)}`);
    // 왕복: 읽은 값을 다시 넣어도 같은 값이 나오고, 직렬화 형태가 동일하다.
    const again = codec.decode(key, decoded.value);
    assert.equal(again.status, 'ok');
    assert.equal(JSON.stringify(again.value), JSON.stringify(dto[key]), `${key} 왕복 불일치`);
    roundTrip[key] = decoded.value;
  }
  // 설계서 §10 의 명시 조건.
  assert.equal(roundTrip.rpg_meta.mapVersion, 1, 'rpg_meta.mapVersion 이 1이 아님');
  assert.equal(roundTrip.rpg_player.mapVersion, 1, 'rpg_player.mapVersion 이 1이 아님');
  for (const key of codec.keys) assert.equal(roundTrip[key].v, 2, `${key}.v 가 2가 아님`);
  const { x, y } = roundTrip.rpg_player;
  assert.equal(Number.isSafeInteger(x) && x >= 0 && x <= 511, true, `x 범위 밖: ${x}`);
  assert.equal(Number.isSafeInteger(y) && y >= 0 && y <= 383, true, `y 범위 밖: ${y}`);
  // 초기값 그대로면 "걷고 저장했다"를 증명하지 못한다.
  const fresh = codec.initial().rpg_player;
  assert.equal(x !== fresh.x || y !== fresh.y, true, `좌표가 초기값 그대로: ${x},${y}`);

  // garden 원본은 rpg 저장과 다른 키다. 3D 는 garden 을 쓰지도, 지우지도 않는다.
  assert.equal(codec.keys.includes('garden'), false);
  assert.equal(Object.keys(dto).includes('garden'), false, '3D 가 garden 키를 썼다');
  // 이미 초기화된 저장에서는 이주가 다시 돌지 않는다 — 역마이그레이션 경로가 없음을 확인한다.
  const gardenRaw = { v: 1, t: 1000, s: 42, f: 137, n: 9, k: ['p', 'w', 'c'], p: ['p:0:2000', 'w:9', 'c:11'] };
  const before = JSON.stringify(gardenRaw);
  const migrated = codec.migrate(gardenRaw);
  assert.equal(migrated.status, 'ok', `garden 이주 실패: ${JSON.stringify(migrated)}`);
  assert.equal(JSON.stringify(gardenRaw), before, 'migrate 가 garden 원본을 변형했다');
  assert.equal(migrated.data.rpg_meta.migrated, true);
  assert.equal(migrated.data.rpg_meta.mapVersion, 1);

  results.saveCompat = {
    ...results.saveCompat,
    keys: [...codec.keys], roundTrip,
    gardenPreserved: { input: gardenRaw, unchangedAfterMigrate: true, migratedMeta: migrated.data.rpg_meta },
    note: 'rpg-codec.js 는 2D 가 쓰던 것과 같은 파일이며 이번 삭제에서 수정하지 않았다. 왕복 통과가 설계서 §10 "2D 가 같은 저장을 읽을 수 있다"의 실측 근거다. 2D 표현 자체는 소스에서 제거되었으므로 복귀는 이전 배포물(OTA/웹) 되돌리기로 한다.',
  };
  results.checks.push(`3D 가 쓴 5키를 배포 codec 원본이 전부 왕복 — mapVersion 1 · v2 · x=${x}(0~511) · y=${y}(0~383), garden 원본 무변형`);
}

await writeFile(resolve(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ checks: results.checks, artifact: { ...results.artifact, manifest: `${results.artifact.manifest.length}개 파일` }, network: results.network, errors: results.errors }, null, 2));
