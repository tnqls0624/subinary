#!/usr/bin/env node
// =============================================================================
// fixate-legacy-fx-snapshots.mjs — ADR-0027 4단계: 레거시 환율을 스냅샷으로 고정
// -----------------------------------------------------------------------------
// ## 무엇을 푸는가
//
// 전환 게이트의 G4("설명되지 않은 외화 delta 0건")가 UNVERIFIED로 남는 진짜 원인은
// 표본 부족이 아니라 **공급자 미배선**이다. `fx_rate_snapshots`는 `0049`로 만들어졌지만
// `fixate()`를 부르는 코드가 저장소에 0건이라 테이블이 비어 있고, 스냅샷이 없으면
// 계획기는 외화 거래를 `fx_snapshot_missing`으로 거절한다
// (`packages/transaction-domain/src/shadow-observer.ts:253`).
//
// ## 어떻게 푸는가 — 값을 구하지 않고 승격한다
//
// 새 역사 환율 공급자를 붙이지 않는다. v1 거래에 **이미 적용된** `exchange_rate`를
// 그 기준일의 불변 스냅샷으로 승격할 뿐이다. 그래서:
//
//   - 사용자가 이미 본 KRW 금액이 바뀌지 않는다(무회귀).
//   - 재계산·재시도가 같은 행을 참조하게 된다 — ADR §3이 요구한 것은 값의 교정이 아니라
//     **흔들리지 않음**이다.
//   - 진짜 공급자가 필요해지는 시점은 "새 외화 거래가 들어올 때"이고, 그건 이 스크립트가
//     아니라 승격 경로의 몫이다(별도 후속 결정, ADR "검토한 대안" 참조).
//
// ## 실행
//
//   node scripts/fixate-legacy-fx-snapshots.mjs           # dry-run(기본) — 읽기 전용
//   node scripts/fixate-legacy-fx-snapshots.mjs --apply    # 실제 고정(운영 DB 쓰기)
//
// 종료 코드: 0 = 정상 · 1 = 건너뛴 그룹 있음(사람 판단 필요) · 3 = 수집/실행 실패
// =============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = resolve(scriptDirectory, 'lib/fx-backfill-probe.mjs');
const API_CONTAINER = process.env.GATE_API_CONTAINER || 'family-memory-ai-api-1';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const wantJson = args.has('--json');

function assertContainer() {
  if (/postgres/u.test(API_CONTAINER)) {
    throw new Error(`프로브는 api 컨테이너에서 실행됩니다(node + dist 필요). 대상: ${API_CONTAINER}`);
  }
  const state = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', API_CONTAINER], {
    encoding: 'utf8',
  }).trim();
  if (state !== 'true') {
    throw new Error(`컨테이너가 실행 중이 아닙니다: ${API_CONTAINER} (${state})`);
  }
}

function runProbe() {
  const source = readFileSync(PROBE_PATH, 'utf8');
  const stdout = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'NODE_OPTIONS=--no-warnings',
      '-e',
      `FX_BACKFILL_APPLY=${apply ? '1' : '0'}`,
      API_CONTAINER,
      'node',
      '--input-type=module',
      '-',
    ],
    { input: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

try {
  assertContainer();
  const result = runProbe();

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exit(result.skipped.length > 0 ? 1 : 0);
  }

  const mode = apply ? '적용' : 'dry-run (아무것도 쓰지 않았습니다)';
  console.log(`ADR-0027 4단계 — 레거시 환율 스냅샷 고정 [${mode}]`);
  console.log('='.repeat(72));

  if (result.planned.length === 0) {
    console.log('고정할 그룹이 없습니다 — 스냅샷 없는 외화 거래가 0건입니다.');
  }
  for (const p of result.planned) {
    const done = result.applied.find(
      (a) => a.baseCurrency === p.baseCurrency && a.asOfDate === p.asOfDate,
    );
    const mark = apply ? (done?.snapshotId ? '✓' : '✗') : '·';
    console.log(
      `${mark} ${p.baseCurrency} ${p.asOfDate}  rate=${p.rate}  (거래 ${p.txnCount}건)` +
        (done?.snapshotId ? `  → ${done.snapshotId.slice(0, 8)}` : ''),
    );
    if (done && done.storedRate !== null && done.storedRate !== p.rate) {
      console.log(
        `    ⚠ 이미 고정된 값이 다릅니다: 저장 ${done.storedRate} ≠ 계획 ${p.rate}` +
          ' — 스냅샷은 불변이므로 기존 값이 유지됩니다.',
      );
    }
  }

  for (const s of result.skipped) {
    console.log(`? ${s.baseCurrency} ${s.asOfDate}  건너뜀 — ${s.detail} (거래 ${s.txnCount}건)`);
    console.log('    같은 날 환율이 여러 개면 "첫 성공 값"을 기계가 정할 수 없습니다. 사람이 정해야 합니다.');
  }

  console.log('='.repeat(72));
  console.log(
    `계획 ${result.planned.length} · 적용 ${result.applied.filter((a) => a.snapshotId).length} · 건너뜀 ${result.skipped.length}`,
  );
  console.log(`읽기 전용 가드: ${result.guard.sqlstate}`);
  if (!apply && result.planned.length > 0) {
    console.log('\n실제로 고정하려면: node scripts/fixate-legacy-fx-snapshots.mjs --apply');
  }
  process.exit(result.skipped.length > 0 ? 1 : 0);
} catch (error) {
  console.error(`실행 실패: ${error?.message ?? error}`);
  process.exit(3);
}
