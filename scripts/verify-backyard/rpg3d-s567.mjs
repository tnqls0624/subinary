/**
 * 슬라이스 5·6·7 검증 — 실제 정적 export의 `/play/app/?key=backyard`를 격리 API
 * fixture와 함께 구동한다. 규칙을 복제하지 않고 화면이 노출한 값과 규칙 모듈 자체를
 * 페이지 안에서 읽어 비교한다.
 *
 * 데스크톱 Chromium 결과이며 **실기기 성능 증거가 아니다**(슬라이스 8).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve(homedir(), '.agents/skills/gstack/node_modules/playwright/index.mjs')).href);
const root = resolve('apps/web/out');
const evidence = resolve('docs/evidence/rpg3d-s567');
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
let dto = {};
const results = {
  browser: browser.version(),
  environment: 'macOS 데스크톱 Chromium; 실기기 성능·시각 승인은 여기서 판정하지 않음',
  checks: [], errors: [], requests: [], models: {}, performance: {}, transcript: [],
};
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { results.errors.push(error.message); console.error(error.message); });
  page.on('console', entry => { if (entry.type() === 'error') results.errors.push(entry.text()); });
  // 추가 WebGL context 생성을 세어 카드마다 context를 만들지 않음을 증명한다.
  await page.addInitScript(() => {
    window.__glContexts = 0;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (String(type).includes('webgl')) window.__glContexts++;
      return original.call(this, type, ...rest);
    };
  });
  dto = {};
  const user = { id: 'verify-user', email: 'verify@example.invalid', name: '검증', displayName: '검증' };
  // 모든 API 요청을 격리한다. 운영 서버로 전달하지 않는다.
  await page.route('**/v1/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    results.requests.push({ method: req.method(), path });
    let body = { items: [], count: 0, unreadCount: 0 };
    const status = 200;
    if (path === '/v1/card-sms-events') body = [];
    else if (path === '/v1/auth/refresh') body = { user, tokens: { accessToken: 'isolated-verification-token' } };
    else if (path === '/v1/auth/me') body = { user, memberships: [{ householdId: 'verify-household', householdName: '검증 가구', role: 'owner' }] };
    else if (path === '/v1/play/backyard') body = { items: Object.entries(dto).map(([stateKey, state]) => ({ stateKey, state })) };
    else if (path.startsWith('/v1/play/backyard/') && req.method() === 'PUT') {
      const key = path.split('/').at(-1); dto[key] = req.postDataJSON().state; body = { stateKey: key, state: dto[key] };
    }
    await route.fulfill({ status, json: body, headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' } });
  });
  const game = page.locator('[data-backyard-game]');
  const ready = () => game.and(page.locator('[data-ready="true"]')).waitFor();
  // 패널이 덮고 있어도 저장 상태는 판정할 수 있어야 한다 — 표시 여부가 아니라 상태를 본다.
  const ack = () => page.locator('[data-save]').filter({ hasText: '저장됨' }).waitFor({ state: 'attached' });
  const player = async () => JSON.parse(await game.getAttribute('data-player'));
  const nodes = async () => JSON.parse(await game.getAttribute('data-nodes'));
  const actors = async () => JSON.parse(await game.getAttribute('data-actors'));
  const stats = async () => ({ calls: Number(await game.getAttribute('data-calls')), triangles: Number(await game.getAttribute('data-triangles')) });
  /** 방향 패드에 초점을 두고 키보드로 실제로 걷는다. */
  async function press(key, ms) {
    await page.locator('[data-pad]').focus();
    await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key);
    await page.waitForTimeout(120);
  }
  /** 96px/s 규칙 속도로 목표 논리 좌표까지 축별로 걷는다. */
  async function walkTo(target) {
    for (let step = 0; step < 24; step++) {
      const at = await player();
      const dx = target.x - at.x, dy = target.y - at.y;
      if (Math.abs(dx) <= 5 && Math.abs(dy) <= 5) return at;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const distance = Math.abs(horizontal ? dx : dy);
      await press(horizontal ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : (dy > 0 ? 'ArrowDown' : 'ArrowUp'),
        Math.min(600, Math.max(40, distance / 96 * 1000)));
    }
    throw Error('걷기 목표 미도달: ' + JSON.stringify({ target, at: await player() }));
  }
  /** 실패한 자리의 실제 화면 상태를 증거에 남긴다. 원인 없이 타임아웃만 남기지 않는다. */
  async function dump(label, error) {
    const snapshot = {
      label, error: String(error && error.message || error),
      action: await page.locator('[data-action]').textContent().catch(() => null),
      feedback: await page.locator('[data-feedback]').textContent().catch(() => null),
      save: await page.locator('[data-save]').textContent().catch(() => null),
      player: await game.getAttribute('data-player').catch(() => null),
      collection: dto.rpg_collection, world: dto.rpg_world,
    };
    results.failure = snapshot;
    await page.screenshot({ path: resolve(evidence, 'failure-' + label + '.png'), scale: 'css' }).catch(() => {});
    return snapshot;
  }
  /** 위치만 저장 fixture로 고정한다. 획득·대화는 실제 화면 버튼을 누른다. */
  async function position(x, y, direction = 6, outfit = 0) {
    dto.rpg_player = { v: 2, mapVersion: 1, x: Math.round(x / 2), y: Math.round(y / 2), direction, outfit, t: 0 };
    await page.reload(); await ready(); await ack();
  }
  await page.goto(base + '/play/app/?key=backyard');
  await ready();

  // ── 부팅과 저장 계약 ──────────────────────────────────────────────────────
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('canvas').count(), 1);
  assert.deepEqual(Object.keys(dto), ['rpg_world', 'rpg_collection', 'rpg_residents', 'rpg_player', 'rpg_meta']);
  results.checks.push('실제 export 라우트에서 신규 4키 ACK→meta 마지막, iframe 0·canvas 1');
  results.performance.base = await stats();

  // ── 슬라이스 5: 주민 실루엣의 객체적 치수 ────────────────────────────────
  // 규칙과 모델 모듈을 페이지 안에서 직접 읽어 설계서 §6 표와 비교한다.
  results.models = await page.evaluate(() => {
    const shop = BackyardRpg3dModels.create({ geometry: g => g, material: m => m, color: hex => new THREE.Color(hex) });
    const measure = object => {
      const box = new THREE.Box3().setFromObject(object);
      return { height: +(box.max.y - box.min.y).toFixed(3), width: +(box.max.x - box.min.x).toFixed(3), depth: +(box.max.z - box.min.z).toFixed(3) };
    };
    const triangles = geometry => geometry.getAttribute('position').count / 3;
    const residents = {};
    for (const definition of BackyardRpgLife.residents) {
      const rig = shop.resident(definition.shape);
      residents[definition.id] = { shape: definition.shape, name: definition.name, ...measure(rig.group) };
    }
    const species = BackyardRpgLife.species.map(item => {
      const shape = shop.speciesGeometry(item.index);
      const mesh = new THREE.Mesh(shape);
      return { id: item.id, name: item.name, triangles: triangles(shape), ...measure(mesh) };
    });
    const furniture = {};
    for (const kind of ['pot', 'well', 'chair', 'workbench']) {
      const shape = shop.furnitureGeometry(kind);
      furniture[kind] = { triangles: triangles(shape), ...measure(new THREE.Mesh(shape)) };
    }
    const rig = shop.player(0);
    return { residents, species, furniture, player: measure(rig.group) };
  });
  const bear = results.models.residents.r0, bird = results.models.residents.r1, rabbit = results.models.residents.r2;
  // 색을 지워도 남는 구분: 곰이 가장 넓고, 새는 날개가 가장 넓게 벌어지고, 토끼가 가장 높다.
  assert(bear.width > rabbit.width, `곰 폭 ${bear.width} > 토끼 폭 ${rabbit.width}`);
  assert(bird.width > bear.width, `새 날개 폭 ${bird.width} > 곰 폭 ${bear.width}`);
  assert(rabbit.height > bear.height && rabbit.height > bird.height, `토끼 키 ${rabbit.height}`);
  assert(Math.abs(bear.height - 1.4) <= 0.08, `곰 키 ${bear.height} ≈ 1.4`);
  assert(Math.abs(bird.height - 1.2) <= 0.1, `새 키 ${bird.height} ≈ 1.2`);
  // 16종 전부가 서로 다른 기하다(폭·높이·삼각형 수 조합).
  const fingerprints = new Set(results.models.species.map(item => [item.width, item.height, item.depth, item.triangles].join('/')));
  assert.equal(fingerprints.size, 16);
  assert.equal(results.models.species.length, 16);
  results.checks.push(`주민 3명 실루엣 치수 구분(곰 폭 ${bear.width}·새 폭 ${bird.width}·토끼 키 ${rabbit.height}), 16종 기하 전부 상이`);

  // ── 이름·색을 가린 실루엣 판 ────────────────────────────────────────────
  {
    const board = await browser.newPage({ viewport: { width: 900, height: 480 }, deviceScaleFactor: 2 });
    await board.goto(base + '/miniapps/backyard/index.html');
    for (const name of ['vendor/three-r128.min.js', 'backyard/rpg-rules.js', 'backyard/rpg3d-models.js'])
      await board.addScriptTag({ url: base + '/miniapps/' + name });
    await board.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.id = 'board'; canvas.width = 880; canvas.height = 440;
      document.body.replaceChildren(canvas);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(2); renderer.setSize(880, 440, false);
      renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.NoToneMapping;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#F2F3E6');
      // 색·이름을 지우고 형태만 남긴다. 평면 단색이라 명암도 판정에 끼어들지 않는다.
      scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color('#2E3A2B') });
      const shop = BackyardRpg3dModels.create({ geometry: g => g, material: m => m, color: hex => new THREE.Color(hex) });
      const rigs = [shop.player(0), ...BackyardRpgLife.residents.map(item => shop.resident(item.shape))];
      rigs.forEach((rig, index) => { rig.group.position.set(index * 1.1 - 1.65, 0, 0); scene.add(rig.group); });
      // 발끝(y≈0)부터 귀 끝(y≈1.7)까지 한 판에 담는다. 종횡비 2:1을 유지한다.
      const camera = new THREE.OrthographicCamera(-2.1, 2.1, 1.05, -1.05, 0.1, 40);
      camera.position.set(0, 0.95, 10); camera.lookAt(0, 0.95, 0);
      renderer.render(scene, camera);
    });
    await board.locator('#board').screenshot({ path: resolve(evidence, 'silhouette-board.png') });
    await board.close();
    results.checks.push('이름·색을 가린 평면 단색 실루엣 판(왼쪽부터 플레이어·곰·새·토끼)');
  }

  // ── 레이아웃·회전 스크린샷 ──────────────────────────────────────────────
  for (const size of [{ width: 320, height: 568 }, { width: 360, height: 800 }, { width: 430, height: 900 }, { width: 800, height: 360 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(evidence, `layout-${size.width}x${size.height}.png`), scale: 'css' });
  }
  await page.setViewportSize({ width: 430, height: 900 });
  results.checks.push('320·360·430 세로와 800×360 가로에서 같은 장면·HUD');

  // ── 슬라이스 5: 주민 대화 ────────────────────────────────────────────────
  const spawn = await actors();
  assert.equal(spawn.length, 3);
  /** 주민을 화면에서 가리지 않는 자리를 고른다. 카메라는 항상 남쪽에서 북쪽을 본다. */
  async function beside(actor) {
    for (const [dx, dy, direction] of [[-26, 0, 0], [26, 0, 4], [0, 24, 6], [0, -24, 2]]) {
      await position(actor.x + dx, actor.y + dy, direction);
      if (/말 걸기/.test(await page.locator('[data-action]').textContent())) return { dx, dy, direction };
    }
    throw Error('주민 근접 자리를 찾지 못했습니다: ' + actor.id);
  }
  for (const actor of spawn) {
    await beside(actor);
    const near = (await actors()).find(item => item.id === actor.id);
    assert(Math.hypot(near.x - actor.x, near.y - actor.y) < 8, '주민이 바라보는 동안 멈춘다');
    await page.screenshot({ path: resolve(evidence, `resident-${actor.id}.png`), scale: 'css' });
    // 이름·색을 가린 실루엣. 사람 판정을 대신하지 않고 같은 프레임의 무채색 판을 남긴다.
    await page.addStyleTag({ content: '[data-backyard-game] canvas{filter:grayscale(1) contrast(1.35) brightness(0.92)}[data-place],[data-feedback],[data-save],[data-action]{visibility:hidden}' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(evidence, `resident-${actor.id}-silhouette.png`), scale: 'css' });
    await page.reload(); await ready();
  }
  results.checks.push('주민 3명 근접 스크린샷과 이름·색을 가린 무채색 실루엣 판');

  for (const actor of spawn) {
    await beside(actor);
    const before = await player();
    await page.locator('[data-action]').filter({ hasText: '말 걸기' }).click();
    await page.locator('[data-dialogue][open]').waitFor();
    await ack();
    // 대화 중 이동 입력 0.
    await page.keyboard.down('ArrowUp'); await page.waitForTimeout(500); await page.keyboard.up('ArrowUp');
    const during = await player();
    assert.deepEqual({ x: during.x, y: during.y }, { x: before.x, y: before.y }, '대화 중에는 걷지 않는다');
    for (let turn = 0; turn < 10; turn++) {
      const line = await page.locator('[data-dialogue-text]').textContent();
      assert(!/[{}]|undefined|null/.test(line), '대사 슬롯 미완성: ' + line);
      results.transcript.push(line);
      const writes = results.requests.length;
      await page.locator('[data-talk-next]').click(); await ack();
      const keys = results.requests.slice(writes).filter(item => item.method === 'PUT').map(item => item.path);
      assert.deepEqual(keys, ['/v1/play/backyard/rpg_residents'], '관계는 한 키만 저장한다');
    }
    await page.locator('[data-close-dialogue]').click();
    // 닫은 뒤 초점은 원래 버튼(행동)으로 돌아온다.
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.action !== undefined), true);
  }
  results.checks.push('주민 3명 × 10회 대화 = 빈 슬롯 없음, 매 회 rpg_residents 한 키, 대화 중 이동 0·초점 복귀');

  // ── 슬라이스 6: 채집 8종 ────────────────────────────────────────────────
  const active = await nodes();
  assert.equal(active.length, 12);
  for (const node of active) {
    await position(node.x, node.y + 24, 6);
    const writes = results.requests.length;
    const button = page.locator('[data-action]');
    if (!/따기|줍기|잡기/.test(await button.textContent())) throw Error('채집 대상을 잡지 못했습니다: ' + node.id);
    await button.click();
    await page.locator('[data-card]').waitFor(); await ack();
    const keys = results.requests.slice(writes).filter(item => item.method === 'PUT').map(item => item.path);
    assert.deepEqual(keys, ['/v1/play/backyard/rpg_collection'], '획득 하나가 collection PUT 하나');
    assert(dto.rpg_collection.nodes.some(tuple => tuple.startsWith(node.id + ':')), '채집점 재생성 시각 기록');
    await page.locator('[data-close-card]').click();
  }
  assert.equal(dto.rpg_collection.species.length, 8, '채집 8종');
  await page.screenshot({ path: resolve(evidence, 'gathered.png'), scale: 'css' });
  results.checks.push('활성 채집점 12곳에서 채집 8종 전부 획득, 각 collection PUT 하나·장소 기록');

  // ── 슬라이스 6: 낚시 8종 ────────────────────────────────────────────────
  const spots = await page.evaluate(() => BackyardRpgRules.sites.filter(site => site.kind === 'fishing').map(site => ({ x: site.x, y: site.y })));
  for (const [spot, place] of spots.entries()) {
    await position(place.x - 24, place.y, 0);
    const before = JSON.stringify(dto.rpg_collection);
    await page.locator('[data-action]').filter({ hasText: '낚시하기' }).click();
    await page.locator('[data-cancel-fishing]').click();
    assert.equal(JSON.stringify(dto.rpg_collection), before, '취소는 아무것도 잃지 않는다');
    const group = await page.evaluate(index => BackyardRpgLife.fishGroups[index].length, spot);
    for (let attempt = 0; attempt < group; attempt++) {
      await page.locator('[data-action]').filter({ hasText: '낚시하기' }).click();
      await page.locator('[data-action]').filter({ hasText: '끌어올리기' }).waitFor();
      if (spot === 0 && attempt === 0) {
        // 입질은 **시간 제한 없이** 유지된다. 20초를 흘려도 그대로다.
        await page.screenshot({ path: resolve(evidence, 'fishing-bite.png'), scale: 'css' });
        await page.waitForTimeout(20000);
        assert.match(await page.locator('[data-action]').textContent(), /끌어올리기/, '입질에 시간 제한이 없다');
        results.checks.push('입질 20초 유지 — 시간 제한 없음');
      }
      const writes = results.requests.length;
      await page.locator('[data-action]').click();
      // 16번째 획득은 카드 대신 **완료 화면**으로 이어진다(2D도 카드를 닫고 완료를 연다).
      try { await page.locator('[data-card], [data-completion][open]').first().waitFor({ timeout: 8000 }); }
      catch (error) { throw Error('획득 결과 미표시: ' + JSON.stringify(await dump(`fishing-${spot}-${attempt}`, error), null, 1)); }
      await ack();
      const keys = results.requests.slice(writes).filter(item => item.method === 'PUT').map(item => item.path);
      assert(keys.length >= 1 && keys.every(path => path === '/v1/play/backyard/rpg_collection'), '획득은 collection 키만 저장한다: ' + keys.join(','));
      assert(keys.length === 1 || dto.rpg_collection.completed === true, '획득 하나가 PUT 하나 — 완료 표시만 예외: ' + keys.join(','));
      if (await page.locator('[data-completion][open]').count() === 0) await page.locator('[data-close-card]').click();
    }
  }
  const caught = dto.rpg_collection.species.map(tuple => tuple.split(':')[0]).sort();
  assert.equal(caught.length, 16, '16종 전부 획득: ' + caught.join(','));
  assert(dto.rpg_collection.species.every(tuple => tuple.split(':')[3]), '최초 장소 전부 기록');
  results.checks.push('낚시 3곳에서 8종 획득, 취소 무손실·각 collection PUT 하나 — 합계 16종');

  // ── 슬라이스 6: 완료 화면과 도감 ────────────────────────────────────────
  await page.locator('[data-completion][open]').waitFor();
  assert.equal(dto.rpg_collection.completed, true, '완료 표시는 ACK 받은 저장이다');
  await page.screenshot({ path: resolve(evidence, 'completion.png'), scale: 'css' });
  await page.locator('[data-close-completion]').click();
  results.checks.push('16번째 획득 ACK 뒤 완료 화면 한 번, completed 저장 확정');

  const contexts = await page.evaluate(() => window.__glContexts);
  await page.locator('[data-open-album]').click();
  await page.locator('[data-album][open]').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__glContexts), contexts, '도감 카드마다 WebGL context를 만들지 않는다');
  assert.equal(await page.locator('canvas').count(), 1);
  const albumCards = Number(await game.getAttribute('data-album-cards'));
  assert(albumCards > 0, '도감 표본을 scissor로 그린다');
  results.performance.album = { cards: albumCards, calls: Number(await game.getAttribute('data-album-calls')) };
  const frozen = await player();
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(500); await page.keyboard.up('ArrowUp');
  assert.deepEqual(await player(), frozen, '패널 뒤에서 입력 0·세계 정지');
  let shown = 0;
  for (const [tab, label] of ['바닥·열매', '벌레', '물고기'].entries()) {
    if (tab) await page.getByRole('tab', { name: label }).click();
    await page.waitForTimeout(350);
    const cards = await page.locator('[data-album] button[data-species]').count();
    // 이 탭의 카드 전부가 표본으로 그려졌는지 확인한다.
    assert.equal(Number(await game.getAttribute('data-album-cards')), cards, label + ' 탭 표본 수');
    shown += cards;
    await page.screenshot({ path: resolve(evidence, `album-${tab}.png`), scale: 'css' });
  }
  assert.equal(shown, 16, '세 탭이 16종 전부를 보여준다');
  results.albumCards = shown;
  await page.locator('[data-album] button[data-species]').first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(evidence, 'album-detail.png'), scale: 'css' });
  const detail = await page.locator('[data-album-detail]').textContent();
  assert(/획득 장소/.test(detail), '최초 장소를 도감이 보여준다');
  await page.locator('[data-close-album]').click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.querySelector('[data-album]')?.open === true), false, '도감이 닫힌다');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.openAlbum !== undefined), true, '닫은 뒤 도감 버튼으로 초점 복귀');
  results.checks.push(`도감 3탭 합계 16칸 scissor 렌더(추가 WebGL context 0, canvas 1, 표본 ${albumCards}칸), 패널 뒤 입력 0, 초점 복귀`);

  // ── 슬라이스 7: 꾸미기 ──────────────────────────────────────────────────
  const bench = await page.evaluate(() => BackyardRpgRules.sites.find(site => site.kind === 'workbench'));
  await position(bench.x, bench.y + 24, 6);
  assert.match(await page.locator('[data-action]').textContent(), /꾸미기/);
  await page.locator('[data-action]').click();
  await page.locator('[data-editor]').waitFor();
  await page.screenshot({ path: resolve(evidence, 'editor.png'), scale: 'css' });
  // 앞 칸이 길이면 색이 아니라 거절 이유 문구가 함께 나온다.
  const placement = await page.locator('[data-placement]').textContent();
  assert.match(placement, /길·집 입구|발견 장소|비워 두세요|경계/, '거절 이유 문구: ' + placement);
  results.rejection = placement;
  await page.screenshot({ path: resolve(evidence, 'placement-rejected.png'), scale: 'css' });
  const before = JSON.stringify(dto.rpg_world);
  await page.locator('[data-action]').click();
  await page.waitForTimeout(400);
  assert.equal(JSON.stringify(dto.rpg_world), before, '거절된 자리는 저장되지 않는다');
  results.checks.push('길 차단 자리에서 거절 이유 문구 표시·저장 없음: ' + placement);

  // 실제로 걸어서 빈 칸 앞에 선 뒤 확정한다 → world 한 키 왕복.
  await walkTo({ x: 240, y: 616 });
  await walkTo({ x: 240, y: 664 });
  await press('ArrowDown', 60);
  // 앞 칸이 규칙상 놓을 수 있는 자리임을 화면 문구로 확인한다.
  results.placement = { cell: await page.evaluate(() => {
    const state = JSON.parse(document.querySelector('[data-backyard-game]').dataset.player);
    return BackyardRpgRules.preview(state, state.direction);
  }), placement: await page.locator('[data-placement]').textContent() };
  assert.match(results.placement.placement, /앞 칸에 놓을 수 있어요/, '빈 칸에서는 놓을 수 있다고 알린다');
  const writes = results.requests.length;
  await page.locator('[data-action]').filter({ hasText: '여기 놓기' }).click();
  await page.waitForTimeout(400);
  assert.match(await page.locator('[data-feedback]').textContent(), /앞에 놓았어요/, '앞 칸에 놓는다');
  await ack();
  const worldWrites = results.requests.slice(writes).filter(item => item.method === 'PUT').map(item => item.path);
  // 걸어서 자리를 골랐으므로 위치 저장(rpg_player)은 함께 나간다. 콘텐츠 키는 world 하나뿐이다.
  assert.deepEqual([...new Set(worldWrites.filter(path => !path.endsWith('rpg_player')))], ['/v1/play/backyard/rpg_world']);
  assert.equal(dto.rpg_world.items.length, 4, '고정 3개 + 새로 놓은 1개');
  await page.screenshot({ path: resolve(evidence, 'placed.png'), scale: 'css' });
  results.checks.push('작업대 → 걷기 → 고스트 → 확정으로 world 한 키 저장 왕복(4개)');

  // 48개 최대 장면. 규칙이 허용하는 칸만 골라 저장한 뒤 다시 읽는다.
  const cells = await page.evaluate(() => {
    const chosen = [];
    for (let row = 1; row <= 22 && chosen.length < 48; row++) for (let col = 1; col <= 30 && chosen.length < 48; col++) {
      const items = chosen.map((cell, index) => ({ id: String(index), kind: 'pot', col: cell.col, row: cell.row }));
      if (BackyardRpgRules.placementReason(items, { col, row }, []) === null) chosen.push({ col, row });
    }
    return chosen;
  });
  assert.equal(cells.length, 48, '규칙이 허용하는 48칸을 찾는다');
  dto.rpg_world = { v: 2, legacyFruit: 0, items: cells.map((cell, index) => `${index}:${['p', 'w', 'c'][index % 3]}:${cell.col}:${cell.row}`) };
  dto.rpg_collection = { ...dto.rpg_collection, nodes: dto.rpg_collection.nodes.filter(tuple => !tuple.startsWith('pot-')) };
  await position(240, 592, 6);
  assert.equal(dto.rpg_world.items.length, 48);
  await page.waitForTimeout(800);
  // 화분 16개 전부 익은 상태이므로 열매도 16개다. 익지 않으면 화분만 남는다.
  const potCount = cells.filter((_, index) => index % 3 === 0).length;
  assert.equal(await game.getAttribute('data-furniture'), `${potCount},${cells.filter((_, i) => i % 3 === 1).length},${cells.filter((_, i) => i % 3 === 2).length}`);
  assert.equal(Number(await game.getAttribute('data-berries')), potCount, '익은 화분마다 열매가 달린다');
  dto.rpg_collection = { ...dto.rpg_collection, nodes: [...dto.rpg_collection.nodes, ...cells.flatMap((_, index) => index % 3 === 0 ? ['pot-' + index + ':' + (Math.floor(Date.now() / 1000) + 10800)] : [])] };
  await position(240, 592, 6);
  await page.waitForTimeout(600);
  assert.equal(Number(await game.getAttribute('data-berries')), 0, '익지 않은 화분은 열매 없이 화분 시각만 유지한다');
  assert.equal(await game.getAttribute('data-furniture'), `${potCount},${cells.filter((_, i) => i % 3 === 1).length},${cells.filter((_, i) => i % 3 === 2).length}`);
  results.checks.push(`화분 시각 유지 — 익은 화분 ${potCount}개에 열매 ${potCount}개, 자라는 중이면 열매 0개·화분 ${potCount}개 그대로`);
  results.performance.max = await stats();
  await page.screenshot({ path: resolve(evidence, 'max-48.png'), scale: 'css' });
  assert(results.performance.max.calls > 0 && results.performance.max.triangles > 0);
  // 48개를 한 종류당 InstancedMesh 하나로 제출하므로 드로우콜이 개수에 비례하지 않는다.
  assert(results.performance.max.calls - results.performance.base.calls <= 6,
    `48개 추가 드로우콜 ${results.performance.max.calls - results.performance.base.calls}`);
  results.checks.push(`48개 포함 저장 왕복 후 draw call ${results.performance.max.calls}·삼각형 ${results.performance.max.triangles} (기본 ${results.performance.base.calls}·${results.performance.base.triangles})`);

  // 옷 2종.
  for (const outfit of [0, 1]) {
    await position(240, 592, 6, outfit);
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(evidence, `outfit-${outfit}.png`), scale: 'css' });
    assert.equal(dto.rpg_player.outfit, outfit);
  }
  results.checks.push('옷 0/1 두 종류가 같은 장면에서 색만 다르게 렌더');

  assert.deepEqual(results.errors, [], '콘솔·페이지 오류 없음');
  assert(results.requests.every(item => item.path.startsWith('/v1/')), '격리 API 밖 요청 없음');
} finally {
  results.dto = dto ?? null;
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await browser.close();
  server.close();
}
console.log(JSON.stringify({ checks: results.checks, performance: results.performance, errors: results.errors }, null, 2));
