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
import { readdirSync, readFileSync } from 'node:fs';
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
  // playwright-core@1.62.0 chromium-headless-shell EXECUTABLE_PATHS:
  //   linux-x64  → chrome-headless-shell-linux64/chrome-headless-shell
  //   linux-arm64 → chrome-linux/headless_shell  (홈 Mac 운영 이미지 플랫폼)
  // find 는 두 이름을 모두 허용해야 한다. 한쪽만 찾으면 플랫폼 회귀.
  assert.match(
    dockerfile,
    /find "\$\{PLAYWRIGHT_BROWSERS_PATH\}" -type f \\\( -name chrome-headless-shell -o -name headless_shell \\\)/,
  );
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

/**
 * .dockerignore 줄을 Docker 규칙대로 정규식으로 바꾼다. 컨텍스트 루트 기준이고, `**` 는 여러 단계,
 * `*`·`?` 는 한 단계 안에서만 맞는다. `!` 는 다시 넣기이며 마지막으로 맞은 줄이 이긴다.
 */
function dockerignoreRules(text) {
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const pattern = (negated ? line.slice(1) : line).replace(/^\/+/u, '').replace(/\/+$/u, '');
      let source = '';
      for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '*' && pattern[i + 1] === '*') {
          if (pattern[i + 2] === '/') {
            source += '(?:.*/)?';
            i += 2;
          } else {
            source += '.*';
            i += 1;
          }
        } else if (ch === '*') {
          source += '[^/]*';
        } else if (ch === '?') {
          source += '[^/]';
        } else {
          source += ch.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
        }
      }
      return { negated, regex: new RegExp(`^${source}$`, 'u') };
    });
}

/** 디렉터리가 빠지면 그 아래도 빠지므로 경로 자신이나 조상 중 하나가 맞으면 그 줄이 맞은 것으로 본다. */
function ignoredByDocker(rules, path) {
  const parts = path.split('/');
  const candidates = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  let ignored = false;
  for (const rule of rules) {
    if (candidates.some((candidate) => rule.regex.test(candidate))) ignored = !rule.negated;
  }
  return ignored;
}

test('.dockerignore does not drop tools/sujain-web-runner/kit/ and the image copies /app whole', () => {
  const rules = dockerignoreRules(readFileSync(join(repoRoot, '.dockerignore'), 'utf8'));
  // 판정기가 실제로 빠지는 경로를 빠진다고 보는지 먼저 확인한다(빈 판정기로 통과하지 않게).
  assert.equal(ignoredByDocker(rules, 'tools/sujain-web-runner/node_modules/playwright-core/package.json'), true);
  assert.equal(ignoredByDocker(rules, 'apps/shmup/project.godot'), true);
  assert.equal(ignoredByDocker(rules, '.env'), true);
  assert.equal(ignoredByDocker(rules, '.env.example'), false);

  const kitFiles = readdirSync(join(repoRoot, 'tools/sujain-web-runner/kit')).filter((name) => name.endsWith('.mjs'));
  assert.ok(kitFiles.length >= 4, 'runner kit modules missing');
  const runnerPaths = [
    'tools/sujain-web-runner/run.mjs',
    'tools/sujain-web-runner/policy.mjs',
    ...kitFiles.map((name) => `tools/sujain-web-runner/kit/${name}`),
  ];
  for (const path of runnerPaths) {
    assert.equal(ignoredByDocker(rules, path), false, `${path} is excluded from the build context`);
  }
  // kit/ 를 따로 COPY 하지 않는다: 빌드 단계가 컨텍스트 전체를, 런타임 단계가 /app 전체를 복사한다.
  assert.match(dockerfile, /^COPY \. \.$/mu);
  assert.match(dockerfile, /^COPY --from=builder \/app \/app$/mu);
});
