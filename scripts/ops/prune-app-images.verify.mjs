// 운영 앱 이미지 보존 정리 verify (node --test). `pnpm ops:images:prune:test`.
//
// 이 스크립트는 무인 배포(CD) 안에서 운영 이미지를 지운다. 잘못 고치면 지금 도는 이미지나
// 롤백 후보를 지울 수 있어서, 가짜 docker 를 PATH 앞에 두고 실제 호출(인자 전체)과 결과를 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "prune-app-images.sh");
const bootstrapPath = join(here, "bootstrap-ai-pipeline-infrastructure.sh");
const REPO = "family-memory-ai/prod";

// 실제 스크립트가 부르는 모양 그대로만 답한다. 형식 문자열·--no-trunc·대상이 바뀌면 99 로 끝나 테스트가 깨진다.
// case 의 따옴표 안 문자열은 글자 그대로 비교된다(| 와 * 도 패턴이 아니다).
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DIR/calls"
case "$*" in
  'ps -aq')
    [ -f "$FAKE_DIR/ps-fail" ] && exit 1
    cat "$FAKE_DIR/containers" ;;
  'inspect --format {{.Image}} '*)
    [ "$#" -eq 4 ] || exit 98
    line="$(grep "^$4 " "$FAKE_DIR/container-images")" || exit 1
    printf '%s\\n' "\${line#* }" ;;
  'image inspect --format {{.Id}} family-memory-ai/prod:local')
    [ -f "$FAKE_DIR/local-id" ] || exit 1
    cat "$FAKE_DIR/local-id" ;;
  'image ls --no-trunc family-memory-ai/prod --format {{.CreatedAt}}|{{.Tag}}|{{.ID}}')
    [ -f "$FAKE_DIR/ls-fail" ] && exit 1
    cat "$FAKE_DIR/images" ;;
  'builder prune --all --force --reserved-space 10GB')
    [ -f "$FAKE_DIR/builder-fail" ] && exit 1
    exit 0 ;;
  'rmi '*)
    [ "$#" -eq 2 ] || exit 98
    grep -Fxq "$2" "$FAKE_DIR/rmi-fail" 2>/dev/null && exit 1
    exit 0 ;;
  *)
    echo "unexpected docker call: $*" >&2
    exit 99 ;;
esac
`;

// 커밋 태그 8개(t1 이 가장 오래됨) + :local + 손으로 붙인 태그. 일부러 시간 순이 아니게 섞는다.
const id = (n) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const tag = (n) => `${String(n).repeat(12).slice(0, 12)}`;
const at = (hour) =>
  `2026-11-09 ${String(hour).padStart(2, "0")}:00:00 +0900 KST`;
const IMAGES = [
  `${at(3)}|${tag(3)}|${id(3)}`,
  `${at(8)}|${tag(8)}|${id(8)}`,
  `${at(8)}|local|${id(8)}`,
  `${at(1)}|${tag(1)}|${id(1)}`,
  `${at(6)}|${tag(6)}|${id(6)}`,
  `${at(2)}|manual-test|${id(9)}`,
  `${at(5)}|${tag(5)}|${id(5)}`,
  `${at(2)}|${tag(2)}|${id(2)}`,
  `${at(7)}|${tag(7)}|${id(7)}`,
  `${at(4)}|${tag(4)}|${id(4)}`,
];

function run({
  args = [tag(8)],
  env = {},
  containers = { c8: id(8) },
  localId = id(8),
  images = IMAGES,
  files = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prune-images-"));
  try {
    const bin = join(dir, "bin");
    const fakeDir = join(dir, "fake");
    mkdirSync(bin);
    mkdirSync(fakeDir);
    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(join(fakeDir, "images"), images.join("\n") + "\n");
    writeFileSync(
      join(fakeDir, "containers"),
      Object.keys(containers).join("\n") + "\n"
    );
    writeFileSync(
      join(fakeDir, "container-images"),
      Object.entries(containers)
        .map(([c, i]) => `${c} ${i}`)
        .join("\n") + "\n"
    );
    if (localId) writeFileSync(join(fakeDir, "local-id"), localId + "\n");
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(fakeDir, name), content);
    writeFileSync(join(fakeDir, "calls"), "");

    const result = spawnSync("sh", [scriptPath, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_DIR: fakeDir,
        INFRA_KEEP_APP_IMAGES: "",
        INFRA_PRUNE_DRY_RUN: "",
        ...env,
      },
    });
    const calls = readFileSync(join(fakeDir, "calls"), "utf8")
      .split("\n")
      .filter(Boolean);
    return {
      ...result,
      calls,
      removed: calls.filter((c) => c.startsWith("rmi ")).map((c) => c.slice(4)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("기본은 최신 이미지 5개를 남기고 오래된 것부터 지운다(입력 순서와 무관)", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /unexpected docker call/);
  assert.deepEqual(r.removed.sort(), [
    `${REPO}:${tag(1)}`,
    `${REPO}:${tag(2)}`,
    `${REPO}:${tag(3)}`,
  ]);
  assert.match(
    r.stdout,
    /\[infra\] app_images_kept=5 app_images_removed=3 prune_failures=0/
  );
});

test("실제 호출 모양: 컨테이너 목록·:local·이미지 목록을 정해진 형식으로 읽는다", () => {
  const r = run({ containers: { c8: id(8), old: id(1) } });
  for (const expected of [
    "ps -aq",
    "inspect --format {{.Image}} c8",
    "inspect --format {{.Image}} old",
    `image inspect --format {{.Id}} ${REPO}:local`,
    `image ls --no-trunc ${REPO} --format {{.CreatedAt}}|{{.Tag}}|{{.ID}}`,
  ]) {
    assert.ok(
      r.calls.includes(expected),
      `${expected}\n---\n${r.calls.join("\n")}`
    );
  }
});

test("빌드 캐시 정리는 마지막 rmi 뒤에 한 번만 한다(순서가 바뀌면 캐시가 레이어를 놓지 않는다)", () => {
  const r = run();
  const lastRmi = r.calls.findLastIndex((c) => c.startsWith("rmi "));
  const builder = r.calls
    .map((c, i) => [c, i])
    .filter(([c]) => c.startsWith("builder "));
  assert.ok(lastRmi >= 0);
  assert.equal(builder.length, 1, r.calls.join("\n"));
  assert.ok(builder[0][1] > lastRmi, r.calls.join("\n"));
});

test("최신 N개는 태그가 아니라 서로 다른 이미지로 센다", () => {
  // 이미지에 안 들어가는 파일만 바뀐 커밋: 같은 이미지(id 8)에 태그만 하나 더 붙는다.
  const images = [...IMAGES, `${at(8)}|aaaaaaaaaaaa|${id(8)}`];
  const r = run({
    images,
    env: { INFRA_KEEP_APP_IMAGES: "2" },
    containers: {},
    localId: "",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.removed.includes(`${REPO}:aaaaaaaaaaaa`));
  assert.ok(!r.removed.includes(`${REPO}:${tag(8)}`));
  assert.ok(
    !r.removed.includes(`${REPO}:${tag(7)}`),
    "두 번째로 새로운 이미지는 남아야 한다"
  );
  assert.equal(r.removed.length, 6);
});

test(":local 과 손으로 붙인 태그는 세지도 지우지도 않는다", () => {
  const r = run({
    env: { INFRA_KEEP_APP_IMAGES: "1" },
    containers: {},
    localId: "",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.removed.includes(`${REPO}:local`));
  assert.ok(!r.removed.includes(`${REPO}:manual-test`));
  assert.ok(
    !r.removed.includes(`${REPO}:${tag(8)}`),
    "가장 최신 태그는 남는다"
  );
  assert.equal(r.removed.length, 7);
});

test("컨테이너가 쓰는 이미지는 오래돼도 남긴다(정지한 컨테이너 포함)", () => {
  const r = run({ containers: { c8: id(8), stopped: id(1) } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.removed.includes(`${REPO}:${tag(1)}`));
  assert.match(
    r.stdout,
    new RegExp(`남김 ${REPO}:${tag(1)} \\(컨테이너가 쓰는 중\\)`)
  );
});

test("이번 배포 태그와 :local 과 같은 이미지는 최신 N개 밖이어도 남긴다(롤백 직후)", () => {
  const r = run({ args: [tag(2)], localId: id(1), containers: {} });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.removed, [`${REPO}:${tag(3)}`]);
});

test("rmi 는 -f 없이 태그 하나씩만 부르고, 위험한 정리 명령은 쓰지 않는다", () => {
  const r = run({
    env: { INFRA_KEEP_APP_IMAGES: "1" },
    containers: {},
    localId: "",
  });
  for (const call of r.calls) {
    assert.doesNotMatch(call, /^rmi .*(-f|--force)/, call);
    assert.doesNotMatch(call, /^(system|volume|container|image) prune/, call);
    if (call.startsWith("rmi "))
      assert.match(call, new RegExp(`^rmi ${REPO}:[0-9a-f]{12}$`));
  }
});

test("하나를 못 지워도 나머지는 계속 지우고, 실패를 종료 코드로 알린다", () => {
  const r = run({ files: { "rmi-fail": `${REPO}:${tag(2)}\n` } });
  assert.equal(r.status, 1);
  assert.deepEqual(r.removed.sort(), [
    `${REPO}:${tag(1)}`,
    `${REPO}:${tag(2)}`,
    `${REPO}:${tag(3)}`,
  ]);
  assert.match(r.stdout, /app_images_removed=2 prune_failures=1/);
});

test("빌드 캐시 정리 실패도 종료 코드로 알린다", () => {
  const r = run({ files: { "builder-fail": "" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /prune_failures=1/);
});

test("docker ps 나 image ls 가 실패하면 아무것도 지우지 않는다", () => {
  for (const file of ["ps-fail", "ls-fail"]) {
    const r = run({ files: { [file]: "" } });
    assert.equal(r.status, 1, file);
    assert.deepEqual(r.removed, [], file);
    assert.ok(!r.calls.some((c) => c.startsWith("builder ")), file);
  }
});

test("남길 수가 1 이상의 정수가 아니면 아무것도 하지 않고 64 로 끝난다", () => {
  for (const keep of ["0", "abc", "-1", "2.5", " 3"]) {
    const r = run({ env: { INFRA_KEEP_APP_IMAGES: keep } });
    assert.equal(r.status, 64, `keep=${JSON.stringify(keep)}`);
    assert.deepEqual(r.calls, [], `keep=${JSON.stringify(keep)}`);
  }
});

test("dry run 값이 true/false 가 아니면(1·TRUE 등) 지우지 않고 64 로 끝난다", () => {
  for (const value of ["1", "TRUE", "yes", "ture"]) {
    const r = run({ env: { INFRA_PRUNE_DRY_RUN: value } });
    assert.equal(r.status, 64, `dry_run=${value}`);
    assert.deepEqual(r.calls, [], `dry_run=${value}`);
  }
});

test("dry run 은 지울 대상만 보이고 rmi·캐시 정리를 부르지 않는다", () => {
  const r = run({ env: { INFRA_PRUNE_DRY_RUN: "true" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.removed, []);
  assert.ok(!r.calls.some((c) => c.startsWith("builder ")));
  assert.match(r.stdout, new RegExp(`지울 예정 ${REPO}:${tag(1)}`));
  assert.match(r.stdout, /지울 예정 3/);
});

// bootstrap 끝의 정리 블록을 잘라 실제로 실행한다: 정리 실패가 배포를 실패로 만들거나,
// --skip-build 롤백에서 정리가 도는 회귀를 잡는다.
function runBootstrapTail({ skipBuild, pruneExit, githubActions }) {
  const src = readFileSync(bootstrapPath, "utf8");
  const verifyAt = src.lastIndexOf(
    "sh scripts/ops/verify-ai-pipeline-infrastructure.sh"
  );
  const blockAt = src.lastIndexOf('if [ "$skip_build" = false ]; then');
  assert.ok(
    verifyAt > 0 && blockAt > verifyAt,
    "정리 블록은 verify 뒤에 있어야 한다"
  );
  const block = src.slice(blockAt);
  assert.match(block, /sh scripts\/ops\/prune-app-images\.sh "\$git_sha"/);

  const dir = mkdtempSync(join(tmpdir(), "prune-bootstrap-"));
  try {
    mkdirSync(join(dir, "scripts", "ops"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "ops", "prune-app-images.sh"),
      `printf '%s\\n' "called $*" >> "${join(
        dir,
        "calls"
      )}"\nexit ${pruneExit}\n`
    );
    writeFileSync(join(dir, "calls"), "");
    const result = spawnSync(
      "sh",
      [
        "-c",
        `set -eu\nskip_build=${skipBuild}\ngit_sha=abc123def456\n${block}`,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          ...(githubActions ? { GITHUB_ACTIONS: "true" } : {}),
        },
      }
    );
    return { ...result, calls: readFileSync(join(dir, "calls"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("bootstrap: 정리가 실패해도 배포는 0 으로 끝나고, CD 에서는 실행 요약 경고를 단다", () => {
  const r = runBootstrapTail({
    skipBuild: false,
    pruneExit: 1,
    githubActions: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls, "called abc123def456\n");
  assert.match(r.stderr, /\[infra\] WARNING: 오래된 앱 이미지 정리 실패/);
  assert.match(r.stdout, /^::warning title=[^:]+::/m);

  const local = runBootstrapTail({
    skipBuild: false,
    pruneExit: 1,
    githubActions: false,
  });
  assert.equal(local.status, 0);
  assert.doesNotMatch(local.stdout, /::warning/);
});

test("bootstrap: 정리가 성공하면 경고가 없고, --skip-build 롤백에서는 정리를 부르지 않는다", () => {
  const ok = runBootstrapTail({
    skipBuild: false,
    pruneExit: 0,
    githubActions: true,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout + ok.stderr, "");

  const rollback = runBootstrapTail({
    skipBuild: true,
    pruneExit: 1,
    githubActions: true,
  });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(rollback.calls, "");
});
