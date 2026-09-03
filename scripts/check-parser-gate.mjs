#!/usr/bin/env node
// =============================================================================
// check-parser-gate.mjs — ADR-0027 6단계 전환 게이트 (읽기 전용)
// -----------------------------------------------------------------------------
// 파서 게이트를 켜도 안전한지, **운영에 실제로 온 카드문자 전수**로 확인한다.
//
// ## 왜 코퍼스 테스트로 부족한가
//
// `action-amount.shadow.test.ts`가 코퍼스 58건으로 전환 조건 네 개를 지킨다. 하지만
// 그 코퍼스는 사람이 고른 표본이다. ADR 3단계는 "retained 카드문자 corpus를 전수
// 재생"하라고 요구한다 — 4단계에서 배운 것과 같은 이유다: **표본이 0이어도 delta는 0**.
// 코퍼스에 없는 레이아웃이 운영에 있으면 게이트를 켠 뒤에야 알게 된다.
//
// ## 판정 (ADR 롤아웃 3단계 전환 조건)
//
//   G1  기존 정상 승인/취소의 금액 delta 0건        (`amount_differs`)
//   G2  기존 정상 승인/취소의 신규 격리 0건          (`new_missing`)
//   G3  저장값과 재생값의 불일치 0건                (재생 기준이 저장 기준과 같은가)
//
// `new_rejects_legacy`는 **위반이 아니다.** 신규가 판촉·한도·잔액을 걸러낸 것이고 그게
// 이 게이트의 목적이다. 다만 표본을 남겨 사람이 "정말 비거래인가"를 볼 수 있게 한다.
//
// ## 사용
//
//   node scripts/check-parser-gate.mjs           # 사람이 읽는 리포트
//   node scripts/check-parser-gate.mjs --json    # 원시 JSON
//
// 종료 코드: 0 = 게이트 통과 · 1 = 위반 있음 · 3 = 실행 실패
// =============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = resolve(scriptDirectory, 'lib/parser-gate-probe.mjs');
// 파서는 worker가 소유한다(카드문자 파싱 잡). dist도 그쪽 이미지 기준으로 본다.
const CONTAINER = process.env.GATE_WORKER_CONTAINER || 'family-memory-ai-worker-1';
const wantJson = process.argv.slice(2).includes('--json');

function runProbe() {
  const state = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', CONTAINER], {
    encoding: 'utf8',
  }).trim();
  if (state !== 'true') throw new Error(`컨테이너가 실행 중이 아닙니다: ${CONTAINER}`);
  const stdout = execFileSync(
    'docker',
    ['exec', '-i', '-e', 'NODE_OPTIONS=--no-warnings', CONTAINER, 'node', '--input-type=module', '-'],
    { input: readFileSync(PROBE_PATH, 'utf8'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

try {
  const r = runProbe();
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2));
    process.exit(r.violations.length > 0 || r.storedDelta > 0 ? 1 : 0);
  }

  const s = r.summary;
  console.log('ADR-0027 6단계 — 파서 게이트 전환 조건 (운영 문자 전수 재생, 읽기 전용)');
  console.log('='.repeat(74));
  console.log(`문자 ${s.total}건 · 카드 파서로 라우팅 ${s.routed}건 · 비카드 ${s.unrouted}건`);
  console.log('');
  console.log('신규 추출기 대조 (라우팅된 건만)');
  for (const [verdict, n] of Object.entries(s.byVerdict).sort((a, b) => b[1] - a[1])) {
    if (n === 0) continue;
    // `new_rejects_legacy`는 게이트의 목적이므로 경고 표시를 붙이지 않는다.
    const mark = verdict === 'same' || verdict === 'new_rejects_legacy' ? '✓' : '⚠';
    console.log(`  ${mark} ${verdict.padEnd(24)} ${String(n).padStart(4)}건`);
  }

  console.log('');
  console.log('확정 범위 (Tier)');
  for (const [tier, n] of Object.entries(r.byTier).sort((a, b) => b[1] - a[1])) {
    const label =
      tier === 'action_segment'
        ? 'Tier 1 (액션과 같은 구간)'
        : tier === 'message_block'
          ? 'Tier 2 (전 구간 유일)'
          : '미확정';
    console.log(`  ${label.padEnd(28)} ${String(n).padStart(4)}건`);
  }

  console.log('');
  console.log('추출기 상태');
  for (const [status, n] of Object.entries(r.byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(28)} ${String(n).padStart(4)}건`);
  }

  console.log('');
  console.log('게이트 판정');
  const g1 = r.violations.filter((v) => v.verdict === 'amount_differs');
  const g2 = r.violations.filter((v) => v.verdict === 'new_missing');
  const line = (ok, label, detail) =>
    console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${label.padEnd(42)} ${detail}`);
  line(g1.length === 0, 'G1 기존 정상 거래의 금액 delta 0건', `${g1.length}건`);
  line(g2.length === 0, 'G2 기존 정상 거래의 신규 격리 0건', `${g2.length}건`);
  line(r.storedDelta === 0, 'G3 저장값과 재생값 불일치 0건', `${r.storedDelta}건`);

  if (r.violations.length > 0) {
    console.log('');
    console.log('위반 상세 (식별자 접두 8자 · PII 없음)');
    for (const v of r.violations.slice(0, 30)) {
      console.log(
        `  · ${v.id} ${v.verdict} ${v.type}${v.foreign ? ' (외화)' : ''} ` +
          `status=${v.status} tier=${v.tier} legacy=${v.legacyAmount} new=${v.newAmount}` +
          `${v.discarded.length > 0 ? ` discarded=[${v.discarded.join(',')}]` : ''}`,
      );
    }
    if (r.violations.length > 30) {
      console.log(`  … 그리고 ${r.violations.length - 30}건 더 (--json으로 전체 확인)`);
    }
  }

  if (r.rejectSamples.length > 0) {
    console.log('');
    console.log('신규가 비거래로 판정한 건 (위반 아님 — 사람이 확인할 표본)');
    for (const x of r.rejectSamples) {
      console.log(
        `  · ${x.id} status=${x.status} parse=${x.parseStatus} type=${x.type} legacy=${x.legacyAmount}`,
      );
    }
  }

  console.log('');
  console.log(`읽기 전용 가드: ${r.guard.sqlstate}`);
  console.log('='.repeat(74));
  const pass = r.violations.length === 0 && r.storedDelta === 0;
  console.log(
    pass
      ? '게이트 통과 — 6단계 활성화 가능. D-4 negative는 코퍼스 테스트가 담당한다.'
      : '게이트 미통과 — 위반을 먼저 해소한다. 게이트를 켜면 그 건들이 L1→L2로 내려간다.',
  );
  process.exit(pass ? 0 : 1);
} catch (error) {
  console.error(`실행 실패: ${error?.message ?? error}`);
  process.exit(3);
}
