#!/usr/bin/env node
// =============================================================================
// repair-money-contract.mjs — ADR-0027 7단계: 기존 데이터 수리
// -----------------------------------------------------------------------------
// 5단계에서 `MONEY_CONTRACT_MODE=v2`로 전환했지만 그건 **앞으로 쓰이는 행**에만 적용된다.
// 그 전에 만들어진 행은 `money_contract_version = 1`로 남고, 8단계 VALIDATE는 "v2 행에만
// 적용되는 제약"을 검증하므로 v1 행이 남아 있는 한 열 수 없다.
//
// ## 이 도구가 자동으로 고치는 것 — 금액은 한 원도 바꾸지 않는다
//
// ADR §3의 "**결정적으로 재현 가능한 행만**"을 가장 보수적으로 읽었다. 관찰기가 `match`나
// `link_manual_only`를 낸 행은 새 계약이 같은 금액을 만든다는 뜻이라, 필요한 것은 재계산이
// 아니라 **계약 버전 스탬프**뿐이다. `net_amount_delta`가 0이므로 "수리 전후 월 합계 차이 =
// 수리 로그 delta 합"이라는 회귀 기준이 자명하게 성립한다.
//
// 금액이나 체인이 바뀌는 판정은 **하나도 자동 적용하지 않는다.** manifest에 남겨 사람이 본다.
//
// ## 사용
//
//   node scripts/repair-money-contract.mjs plan            # 계획만 적재(거래 무변경)
//   node scripts/repair-money-contract.mjs status          # 배치 목록
//   node scripts/repair-money-contract.mjs status <batch>  # 배치 상세
//   node scripts/repair-money-contract.mjs apply <batch>   # auto 행에 스탬프
//   node scripts/repair-money-contract.mjs revert <batch>  # 역순 되돌림
//
// `--json`을 붙이면 원시 JSON을 낸다.
//
// 종료 코드: 0 = 정상 · 1 = 사람 검토 대상이 남음 · 2 = 낡은 manifest를 건너뜀 · 3 = 실행 실패
// =============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = resolve(scriptDirectory, 'lib/money-repair-probe.mjs');
const API_CONTAINER = process.env.GATE_API_CONTAINER || 'family-memory-ai-api-1';

const argv = process.argv.slice(2).filter((a) => a !== '--json');
const wantJson = process.argv.slice(2).includes('--json');
const command = argv[0] ?? 'status';
const batchId = argv[1] ?? null;

const VALID = new Set(['plan', 'apply', 'revert', 'status']);
if (!VALID.has(command)) {
  console.error(`알 수 없는 명령: ${command} (plan|apply|revert|status)`);
  process.exit(3);
}
if ((command === 'apply' || command === 'revert') && !batchId) {
  console.error(`${command}에는 batch id가 필요합니다.`);
  process.exit(3);
}

function runProbe() {
  const state = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', API_CONTAINER], {
    encoding: 'utf8',
  }).trim();
  if (state !== 'true') throw new Error(`컨테이너가 실행 중이 아닙니다: ${API_CONTAINER}`);
  const stdout = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'NODE_OPTIONS=--no-warnings',
      '-e',
      `REPAIR_COMMAND=${command}`,
      ...(batchId ? ['-e', `REPAIR_BATCH_ID=${batchId}`] : []),
      API_CONTAINER,
      'node',
      '--input-type=module',
      '-',
    ],
    { input: readFileSync(PROBE_PATH, 'utf8'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function printRemaining(r) {
  const done = r.remaining.total - r.remaining.v1;
  console.log('');
  console.log(
    `계약 버전: v2 ${done}건 / 전체 ${r.remaining.total}건 · 남은 v1 ${r.remaining.v1}건` +
      (r.remaining.v1 === 0 ? '  ← 8단계(VALIDATE) 진입 가능' : ''),
  );
}

try {
  const r = runProbe();
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  if (r.command === 'plan') {
    console.log('ADR-0027 7단계 — 수리 계획 적재 (거래 행 무변경)');
    console.log('='.repeat(72));
    console.log(`batch: ${r.batchId}`);
    console.log(`대상 v1 ${r.targets}건 · 계획 ${r.planned}건 · 미기록 ${r.unrecorded}건`);
    console.log(`  자동(스탬프) ${r.auto}건 · 사람 검토 ${r.review}건`);
    console.log('');
    console.log('판정 분포');
    for (const b of r.breakdown) {
      const mark = b.eligibility === 'auto' ? '✓' : '⚠';
      console.log(
        `  ${mark} ${`${b.eligibility}/${b.verdict}`.padEnd(38)} ${String(b.n).padStart(4)}건` +
          `  delta합 ${b.net_delta_sum}`,
      );
    }
    printRemaining(r);
    console.log('='.repeat(72));
    console.log(`적용: node scripts/repair-money-contract.mjs apply ${r.batchId}`);
    process.exit(r.review > 0 ? 1 : 0);
  }

  if (r.command === 'apply') {
    console.log('ADR-0027 7단계 — 수리 적용 (계약 버전 스탬프)');
    console.log('='.repeat(72));
    console.log(`batch: ${r.batchId}`);
    console.log(`적용 ${r.applied}건`);
    console.log(`  건너뜀: 낡은 manifest ${r.skippedStale}건 · 이미 v2 ${r.skippedAlreadyV2}건 · 행 없음 ${r.skippedMissing}건`);
    console.log(`  사람 검토로 남김 ${r.review}건`);
    if (r.skippedStale > 0) {
      console.log('');
      console.log('⚠ 낡은 manifest가 있었다. 그 사이 누군가 해당 거래를 수정했다는 뜻이다.');
      console.log('  plan을 다시 돌려 새 배치를 만들면 된다 — 덮어쓰지 않은 것이 정상 동작이다.');
    }
    printRemaining(r);
    console.log('='.repeat(72));
    process.exit(r.skippedStale > 0 ? 2 : r.review > 0 ? 1 : 0);
  }

  if (r.command === 'revert') {
    console.log('ADR-0027 7단계 — 수리 되돌림');
    console.log('='.repeat(72));
    console.log(`batch: ${r.batchId}`);
    console.log(`되돌림 ${r.reverted}건 · 차단 ${r.blocked}건 · 미적용 ${r.skippedNotApplied}건`);
    if (r.blocked > 0) {
      console.log('');
      console.log('⚠ 차단된 행은 적용 후 사용자가 손댄 거래다. 자동 되돌림이 그 수정을');
      console.log('  덮어쓰지 않는다(ADR §4). before/after와 현재값을 사람이 병합해야 한다.');
    }
    printRemaining(r);
    console.log('='.repeat(72));
    process.exit(r.blocked > 0 ? 1 : 0);
  }

  console.log('ADR-0027 7단계 — 수리 배치 현황');
  console.log('='.repeat(72));
  if (r.batches.length === 0) {
    console.log('수리 배치가 없다. `plan`으로 시작한다.');
  }
  for (const b of r.batches) {
    console.log(
      `${b.batch_id}  ${b.created_at?.slice(0, 19) ?? ''}\n` +
        `  총 ${b.total}건 (자동 ${b.auto} · 검토 ${b.review}) · 적용 ${b.applied} · 되돌림 ${b.reverted}` +
        `${b.blocked > 0 ? ` · 차단 ${b.blocked}` : ''} · delta합 ${b.net_delta_sum}`,
    );
  }
  if (r.breakdown) {
    console.log('');
    console.log('판정 분포');
    for (const b of r.breakdown) {
      const mark = b.eligibility === 'auto' ? '✓' : '⚠';
      console.log(`  ${mark} ${`${b.eligibility}/${b.verdict}`.padEnd(38)} ${String(b.n).padStart(4)}건`);
    }
  }
  printRemaining(r);
  console.log('='.repeat(72));
  process.exit(0);
} catch (error) {
  console.error(`실행 실패: ${error?.message ?? error}`);
  process.exit(3);
}
