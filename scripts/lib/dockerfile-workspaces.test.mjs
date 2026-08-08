/**
 * `Dockerfile.prod`의 워크스페이스 manifest COPY 목록이 실제 워크스페이스와 일치하는지 검사한다.
 *
 * 왜 필요한가 (2026-08-08에 실제로 겪음):
 * `Dockerfile.prod`는 install cache를 살리려고 각 워크스페이스의 `package.json`을 **한 줄씩
 * 명시적으로** COPY한다. 새 패키지를 만들고 이 목록에 줄을 안 더하면 `pnpm install`이 그
 * 패키지의 devDeps를 건너뛰고, 뒤이은 build 단계가 `tsup: not found`로 죽는다.
 *
 * 이 실수는 **운영 이미지 빌드에서만 드러난다**:
 *   - `Dockerfile.dev`는 `COPY . .`라 전부 복사한다 → dev 스택은 멀쩡히 뜬다.
 *   - 로컬 `pnpm install --frozen-lockfile`은 node_modules가 이미 있어 통과한다.
 *   - 타입체크·테스트도 전부 통과한다.
 * 즉 배포를 눌러야 알게 된다. 그래서 CI에서 미리 잡는다.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../../', import.meta.url).pathname;
const dockerfile = readFileSync(
  join(repoRoot, 'infrastructure/docker/Dockerfile.prod'),
  'utf8',
);

/** `packages/`·`apps/` 아래에서 package.json을 가진 디렉터리 = 워크스페이스. */
function discoverWorkspaces() {
  const found = [];
  for (const group of ['apps', 'packages']) {
    const base = join(repoRoot, group);
    for (const name of readdirSync(base, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const manifest = join(base, name.name, 'package.json');
      if (existsSync(manifest)) found.push(`${group}/${name.name}`);
    }
  }
  return found.sort();
}

/** Dockerfile.prod가 COPY하는 워크스페이스 manifest 경로. */
function copiedWorkspaces() {
  const pattern = /^COPY\s+(apps|packages)\/([^/\s]+)\/package\.json\s/gm;
  const found = [];
  for (const m of dockerfile.matchAll(pattern)) found.push(`${m[1]}/${m[2]}`);
  return found.sort();
}

test('Dockerfile.prod가 모든 워크스페이스의 package.json을 COPY한다', () => {
  const missing = discoverWorkspaces().filter(
    (w) => !copiedWorkspaces().includes(w),
  );
  assert.deepEqual(
    missing,
    [],
    `Dockerfile.prod의 COPY 목록에 빠진 워크스페이스가 있다: ${missing.join(', ')}\n` +
      `infrastructure/docker/Dockerfile.prod 에 다음을 더하라:\n` +
      missing.map((w) => `  COPY ${w}/package.json ${w}/package.json`).join('\n'),
  );
});

test('Dockerfile.prod가 존재하지 않는 워크스페이스를 COPY하지 않는다', () => {
  const workspaces = discoverWorkspaces();
  const stale = copiedWorkspaces().filter((w) => !workspaces.includes(w));
  assert.deepEqual(
    stale,
    [],
    `삭제된 워크스페이스가 COPY 목록에 남아 있다(빌드가 즉시 실패한다): ${stale.join(', ')}`,
  );
});
