#!/usr/bin/env node
// =============================================================================
// replay-money-contract.mjs — ADR-0027 4단계: 기존 거래 전수 재생 (읽기 전용)
// -----------------------------------------------------------------------------
// shadow 관측은 "배포 이후 새로 쓰인 거래"만 담는다. 그래서 쓰지 않는 경로와 오래된
// 거래는 표본에 영원히 들어오지 않고, 게이트의 G2b/G4가 UNVERIFIED로 굳는다.
// 이 스크립트는 같은 관찰기를 **기존 행 전체**에 돌려 그 공백을 측정으로 바꾼다.
//
// 아무것도 쓰지 않는다 — 관찰기의 sink를 메모리로 갈아끼운다.
//
// 실행: node scripts/replay-money-contract.mjs [--json]
// 종료 코드: 0 = delta 0 · 1 = delta 있음 · 2 = 미기록 있음 · 3 = 실행 실패
// =============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = resolve(scriptDirectory, 'lib/money-replay-probe.mjs');
const API_CONTAINER = process.env.GATE_API_CONTAINER || 'family-memory-ai-api-1';
const wantJson = new Set(process.argv.slice(2)).has('--json');

function runProbe() {
  const state = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', API_CONTAINER], {
    encoding: 'utf8',
  }).trim();
  if (state !== 'true') throw new Error(`컨테이너가 실행 중이 아닙니다: ${API_CONTAINER}`);
  const stdout = execFileSync(
    'docker',
    ['exec', '-i', '-e', 'NODE_OPTIONS=--no-warnings', API_CONTAINER, 'node', '--input-type=module', '-'],
    { input: readFileSync(PROBE_PATH, 'utf8'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

try {
  const r = runProbe();
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2));
    process.exit(r.nonzeroDelta > 0 ? 1 : r.unrecorded > 0 ? 2 : 0);
  }

  console.log('ADR-0027 4단계 — 기존 거래 전수 재생 (읽기 전용)');
  console.log('='.repeat(72));
  console.log(`대상 ${r.totalRows}건 · 관측 기록 ${r.recorded}건 · 미기록 ${r.unrecorded}건`);
  console.log('');
  console.log('행 성격별 (라벨은 근사 — 판정 근거가 아니다)');
  for (const [path, n] of Object.entries(r.byPath).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${path.padEnd(32)} ${n}건`);
  }
  console.log('');
  console.log('새 계약 대조 결과');
  for (const [verdict, n] of Object.entries(r.byVerdict).sort((a, b) => b[1] - a[1])) {
    const mark = verdict === 'match' ? '✓' : '⚠';
    console.log(`  ${mark} ${verdict.padEnd(30)} ${n}건`);
  }
  if (Object.keys(r.failureReasons).length > 0) {
    console.log('');
    console.log('계획 실패 사유');
    for (const [reason, n] of Object.entries(r.failureReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason.padEnd(32)} ${n}건`);
    }
  }
  console.log('');
  console.log(`외화 관측 ${r.foreign}건 · 순액 delta≠0 ${r.nonzeroDelta}건`);
  for (const s of r.deltaSamples) {
    console.log(
      `  · ${s.transactionId} ${s.type} ${s.foreign ? '(외화)' : ''} ` +
        `${s.verdict} delta=${s.netAmountDelta}${s.failureReason ? ` reason=${s.failureReason}` : ''}`,
    );
  }
  console.log('='.repeat(72));
  console.log(`읽기 전용 가드: ${r.guard.sqlstate}`);
  process.exit(r.nonzeroDelta > 0 ? 1 : r.unrecorded > 0 ? 2 : 0);
} catch (error) {
  console.error(`실행 실패: ${error?.message ?? error}`);
  process.exit(3);
}
