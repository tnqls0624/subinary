/**
 * 운영 이미지가 수자인 공식 runner 런타임을 빠뜨리지 않는지 검사한다.
 *
 * 가용성 검사(apps/api/.../sujain-browser.ts)는
 *   - SUJAIN_WEB_CONNECTIONS_ENABLED
 *   - 절대 경로 browser executable
 *   - tools/sujain-web-runner/run.mjs
 *   - 그 옆 node_modules/playwright-core@1.62.0
 * 를 요구한다. Dockerfile/compose 가 이 계약을 유지하는지 CI에서 잡는다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../../', import.meta.url).pathname;
const dockerfile = readFileSync(
  join(repoRoot, 'infrastructure/docker/Dockerfile.prod'),
  'utf8',
);
const compose = readFileSync(join(repoRoot, 'docker-compose.prod.yml'), 'utf8');

test('Dockerfile.prod installs sujain-web-runner playwright-core 1.62.0 and chromium', () => {
  assert.match(dockerfile, /cd \/app\/tools\/sujain-web-runner/);
  assert.match(dockerfile, /playwright-core/);
  assert.match(dockerfile, /1\.62\.0/);
  assert.match(dockerfile, /--only-shell/);
  assert.match(dockerfile, /chrome-headless-shell/);
  assert.match(dockerfile, /\/app\/tools\/sujain-web-runner\/chromium/);
  // 설치 RUN 은 수자인 디렉터리만. 주석에 신한 분리 안내가 있어도 bank-web 경로로 cd 하지 않는다.
  const runtimeInstall = dockerfile.match(
    /ENV PLAYWRIGHT_BROWSERS_PATH=[\s\S]*?(?=\nEXPOSE)/,
  );
  assert.ok(runtimeInstall, 'sujain runtime install block missing');
  assert.doesNotMatch(runtimeInstall[0], /cd \/app\/tools\/bank-web-runner/);
  assert.doesNotMatch(runtimeInstall[0], /BANK_WEB_/);
});

test('docker-compose.prod.yml wires SUJAIN_WEB_* on api only with image paths', () => {
  assert.match(compose, /SUJAIN_WEB_CONNECTIONS_ENABLED:\s*\$\{SUJAIN_WEB_CONNECTIONS_ENABLED:-true\}/);
  assert.match(compose, /SUJAIN_WEB_RUNNER_PATH:\s*\/app\/tools\/sujain-web-runner\/run\.mjs/);
  assert.match(
    compose,
    /SUJAIN_WEB_BROWSER_EXECUTABLE:\s*\/app\/tools\/sujain-web-runner\/chromium/,
  );
  assert.doesNotMatch(compose, /SUJAIN_WEB_RUNNER_PATH:.*bank-web/);
  assert.doesNotMatch(compose, /SUJAIN_WEB_BROWSER_EXECUTABLE:.*BANK_WEB/);
});
