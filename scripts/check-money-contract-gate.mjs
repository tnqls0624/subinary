#!/usr/bin/env node
// =============================================================================
// check-money-contract-gate.mjs — ADR-0027 전환 게이트 판정 (운영 DB 읽기 전용)
// -----------------------------------------------------------------------------
// ADR-0027 롤아웃 **3단계**가 나열한 전환 조건을 하나씩 판정한다.
// **아무것도 켜지 않는다.** 산출물은 "지금 enforce해도 되는가"에 대한 판정뿐이다.
//
// ## 이 스크립트의 제1 규칙: PASS와 UNVERIFIED를 합치지 않는다
//
// 게이트 조건은 전부 "delta 0건" 꼴이다. 그런데 **표본이 0이어도 delta는 0**이다.
// 둘을 같은 값으로 내보내면 "관측한 적 없음"이 "문제 없음"으로 굳고, 그 상태로
// enforce하면 가족이 매일 보는 금액이 틀린 채로 고정된다. 그래서 각 조건은
// PASS / FAIL / UNVERIFIED 세 값을 갖고, **하나라도 PASS가 아니면 전체가 NOT READY**다.
//
// ## 읽기 전용
//
// `snapshot-money-baseline.mjs`의 3중 가드를 그대로 재사용한다(새로 짜지 않았다):
//   (1) 운영 api 컨테이너 안 `repeatable read, read only` 트랜잭션,
//   (2) 전송 직전 SELECT/WITH 검사,
//   (3) 매 실행 `where false` UPDATE로 SQLSTATE 25006 자가검증.
// 프로브 소스는 stdin으로 주입한다 — 운영 컨테이너 파일시스템에 쓰지 않는다.
// `docker compose`는 쓰지 않으므로 `-p` 누락으로 운영 스택을 건드릴 위험이 없다.
//
// ## PII
//
// 카드 문자 원문·가맹점명·발신자는 출력에 담기지 않는다. 새 게이트가 떨어뜨리는
// 건은 원문 대신 **패턴 서명**(토큰 계열 + 금액 토큰 수 + 줄 수)으로만 보고한다.
//
// 실행:
//   node scripts/check-money-contract-gate.mjs           # 사람이 읽는 판정표
//   node scripts/check-money-contract-gate.mjs --json     # 원시 JSON
//   node scripts/check-money-contract-gate.mjs --skip-fixture  # vitest 없이 DB만
//
// 종료 코드:
//   0  = READY  (모든 조건 PASS)
//   1  = NOT READY (FAIL 있음)
//   2  = NOT READY (UNVERIFIED 있음 — 확인하지 못한 조건이 남았다)
//   3  = 수집 자체 실패(가드 실패·컨테이너 부재 등)
// =============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..');
const PROBE_PATH = resolve(scriptDirectory, 'lib/money-gate-probe.mjs');

/** 프로브는 api 컨테이너에서만 돈다(node + dist가 거기 있다). 기준선 스크립트와 동일. */
const API_CONTAINER = process.env.GATE_API_CONTAINER || 'family-memory-ai-api-1';

/** ADR 롤아웃 3단계가 명시한 최소 관측량. */
const MIN_SHADOW_DAYS = 7;
const MIN_SHADOW_RECORDS = 50;

/**
 * shadow가 관측해야 하는 쓰기 경로 전부(`MoneyShadowPath`).
 * 일부 경로가 한 번도 안 돌았다면 그 경로의 "delta 0"은 측정이 아니라 공백이다.
 */
const ALL_SHADOW_PATHS = [
  'worker_promotion_approval',
  'worker_promotion_cancellation',
  'api_manual_fields',
  'api_human_review',
  'api_transaction_update',
  'api_link_cancellation',
];

const args = new Set(process.argv.slice(2));
const wantJson = args.has('--json');
const skipFixture = args.has('--skip-fixture');

/* -------------------------------------------------------------------------- */
/* 판정 프리미티브                                                            */
/* -------------------------------------------------------------------------- */

const results = [];

/**
 * @param {string} id ADR 조건 식별자
 * @param {string} title 조건 문구(ADR 원문에 맞춘다)
 * @param {'PASS'|'FAIL'|'UNVERIFIED'} status
 * @param {string} detail 근거 — 숫자를 반드시 포함한다
 * @param {string} [why] UNVERIFIED/FAIL일 때 무엇이 있어야 판정 가능한지
 */
function record(id, title, status, detail, why) {
  results.push({ id, title, status, detail, why: why ?? null });
}

/* -------------------------------------------------------------------------- */
/* 수집                                                                       */
/* -------------------------------------------------------------------------- */

function assertTargetContainer() {
  if (/postgres/u.test(API_CONTAINER)) {
    throw new Error(
      `프로브는 api 컨테이너에서 실행됩니다(node + dist 필요). 대상: ${API_CONTAINER}`,
    );
  }
  const state = execFileSync(
    'docker',
    ['inspect', '--format', '{{.State.Running}}', API_CONTAINER],
    { encoding: 'utf8' },
  ).trim();
  if (state !== 'true') {
    throw new Error(`컨테이너가 실행 중이 아닙니다: ${API_CONTAINER} (${state})`);
  }
}

function runProbe() {
  const source = readFileSync(PROBE_PATH, 'utf8');
  const stdout = execFileSync(
    'docker',
    ['exec', '-i', API_CONTAINER, 'node', '--input-type=module', '-'],
    { input: source, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    throw new Error(`프로브가 JSON을 반환하지 않았습니다: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(trimmed);
}

/**
 * D-4 negative fixture는 저장소 안 vitest 스위트다(`action-amount.shadow.test.ts`).
 * DB가 아니라 코드 픽스처라 컨테이너가 아닌 호스트에서 돌린다. 스위트가 없거나
 * 돌릴 수 없으면 **UNVERIFIED**로 남긴다 — 없는 픽스처를 100%라고 하지 않는다.
 */
function runFixtureSuite() {
  const cwd = resolve(repoRoot, 'packages/card-parsers');
  const vitestEntry = resolve(cwd, 'node_modules/vitest/vitest.mjs');
  try {
    const stdout = execFileSync(
      process.execPath,
      [vitestEntry, 'run', 'src/action-amount.shadow.test.ts'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const match = /Tests\s+(\d+)\s+passed\s+\((\d+)\)/u.exec(stdout);
    return {
      ran: true,
      ok: true,
      passed: match ? Number(match[1]) : null,
      total: match ? Number(match[2]) : null,
      raw: stdout.slice(-500),
    };
  } catch (error) {
    const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
    // 파일이 없거나 vitest가 없으면 "실패"가 아니라 "돌리지 못함"이다.
    const missing = /Cannot find module|No test files found/u.test(output);
    return { ran: !missing, ok: false, passed: null, total: null, raw: output.slice(-800) };
  }
}

/* -------------------------------------------------------------------------- */
/* 조건 판정 — ADR 롤아웃 3단계                                               */
/* -------------------------------------------------------------------------- */

function judgeStage3(probe, fixture) {
  const { shadow, corpus } = probe;

  /* G1. live shadow 최소 7일 -------------------------------------------- */
  if (shadow.rows === 0) {
    record(
      'G1',
      'live shadow 최소 7일',
      'UNVERIFIED',
      'shadow 관측 기록이 0건입니다.',
      'shadow 배포 후 관측이 쌓여야 기간을 잴 수 있습니다.',
    );
  } else {
    const pass = shadow.durationDays >= MIN_SHADOW_DAYS;
    record(
      'G1',
      'live shadow 최소 7일',
      pass ? 'PASS' : 'FAIL',
      `${shadow.durationDays}일 (${shadow.firstAt} ~ ${shadow.lastAt}, 관측일 ${shadow.distinctDays}일)`,
      pass ? undefined : `${MIN_SHADOW_DAYS}일 필요`,
    );
  }

  /* G2. live shadow 50건 이상 ------------------------------------------- */
  {
    const pass = shadow.rows >= MIN_SHADOW_RECORDS;
    record(
      'G2',
      'live shadow 50건 이상',
      pass ? 'PASS' : 'FAIL',
      `${shadow.rows}건 (고유 거래 ${shadow.distinctTransactions}건)`,
      pass ? undefined : `${MIN_SHADOW_RECORDS - shadow.rows}건 부족`,
    );
  }

  /* G2b. 관측 커버리지 — ADR 본문에는 없지만 G3~G4의 전제다 ------------- */
  {
    const missingPaths = ALL_SHADOW_PATHS.filter((path) => !(shadow.byPath[path] > 0));
    const status = missingPaths.length === 0 ? 'PASS' : 'UNVERIFIED';
    record(
      'G2b',
      '쓰기 경로 6개 전부 관측 (G3·G4의 전제)',
      status,
      `관측된 경로 ${ALL_SHADOW_PATHS.length - missingPaths.length}/6` +
        (missingPaths.length ? ` · 미관측: ${missingPaths.join(', ')}` : ''),
      missingPaths.length
        ? '미관측 경로의 "delta 0"은 측정이 아니라 표본 없음입니다.'
        : undefined,
    );
  }

  /* G3. 기존 정상 KRW 결과의 금액 delta 0건 ----------------------------- */
  {
    const krwDelta = shadow.byVerdict.krw_amount_delta ?? 0;
    const krwObserved = (shadow.rows ?? 0) - (shadow.foreignRows ?? 0);
    if (krwObserved === 0) {
      record(
        'G3',
        '기존 정상 KRW 결과의 금액 delta 0건',
        'UNVERIFIED',
        'KRW 관측 표본이 0건입니다.',
        '표본이 없으면 delta 0은 "차이 없음"이 아닙니다.',
      );
    } else {
      const pass = krwDelta === 0 && shadow.nonzeroDelta === 0;
      record(
        'G3',
        '기존 정상 KRW 결과의 금액 delta 0건',
        pass ? 'PASS' : 'FAIL',
        `krw_amount_delta ${krwDelta}건 · net_amount_delta≠0 ${shadow.nonzeroDelta}건 (KRW 표본 ${krwObserved}건)`,
      );
    }
  }

  /* G4. 설명되지 않은 외화 delta 0건 ------------------------------------ */
  {
    /*
     * **"설명된"의 정의(코드 기준)**: `fx_amount_delta` 판정이면서, 그 delta가
     * `(원통화, 기준일, 계약버전)` 스냅샷을 **실제로 찾아** 계산한 결과일 때만
     * "설명됨"으로 센다. 스냅샷 없이 나온 차이는 설명이 아니라 계산 실패다
     * (`plan_failed` / `fx_snapshot_missing`).
     *
     * 지금은 스냅샷 테이블이 비어 있으므로 **설명될 수 있는 외화 delta가 원리적으로
     * 존재하지 않는다.** 따라서 외화 표본이 0이면 PASS가 아니라 UNVERIFIED다.
     */
    const fxDelta = shadow.byVerdict.fx_amount_delta ?? 0;
    const planFailed = shadow.byVerdict.plan_failed ?? 0;
    if ((shadow.foreignRows ?? 0) === 0) {
      record(
        'G4',
        '설명되지 않은 외화 delta 0건',
        'UNVERIFIED',
        `외화 관측 표본 0건 (fx_amount_delta ${fxDelta}건 · plan_failed ${planFailed}건)`,
        '외화 거래가 shadow 창 안에서 한 건도 발생하지 않아 판정 근거가 없습니다.',
      );
    } else {
      const explainable = probe.fx.snapshots.total > 0;
      const pass = fxDelta === 0 && planFailed === 0;
      record(
        'G4',
        '설명되지 않은 외화 delta 0건',
        pass ? 'PASS' : 'FAIL',
        `외화 표본 ${shadow.foreignRows}건 · fx_amount_delta ${fxDelta}건 · plan_failed ${planFailed}건` +
          (explainable ? '' : ' · 스냅샷 0개(설명 근거 없음)'),
      );
    }
  }

  /* G5. 기존 정상 승인의 신규 격리 0건 ---------------------------------- */
  {
    const h = corpus.healthy;
    if (h.population === 0) {
      record(
        'G5',
        '기존 정상 승인의 신규 격리 0건',
        'UNVERIFIED',
        '재생 대상(L0가 금액을 만든 승인) 0건.',
        '모집단이 없으면 격리 0은 측정이 아닙니다.',
      );
    } else {
      const wouldQuarantine = h.notResolved - h.rescuableByRecipe;
      const pass = h.notResolved === 0;
      record(
        'G5',
        '기존 정상 승인의 신규 격리 0건',
        pass ? 'PASS' : 'FAIL',
        `모집단 ${h.population}건(승격된 승인 ${h.promotedApprovals}건 중 L0 산출 ${h.population}건 ·` +
          ` 사람이 값을 넣은 ${h.humanSourced}건은 오늘도 자동 승격이 아니라 제외)` +
          ` 중 새 게이트 L0 실패 ${h.notResolved}건` +
          (h.notResolved > 0
            ? ` (레시피 구제 가능 ${h.rescuableByRecipe}건 → 실질 격리 ${wouldQuarantine}건)`
            : ''),
        pass ? undefined : '게이트를 활성화하면 오늘 정상인 승인이 격리로 떨어집니다.',
      );
    }
  }

  /* G5b. 게이트가 확정하되 금액이 달라지는 건 --------------------------- */
  {
    const h = corpus.healthy;
    const pass = h.resolvedDifferentAmount === 0;
    record(
      'G5b',
      '기존 정상 승인의 파서 금액 delta 0건 (기존 파서 대비)',
      h.population === 0 ? 'UNVERIFIED' : pass ? 'PASS' : 'FAIL',
      `확정 ${h.resolvedSameAmount + h.resolvedDifferentAmount}건 중 기존 파서와 불일치 ${h.resolvedDifferentAmount}건`,
      h.population === 0 ? '모집단 없음' : undefined,
    );
  }

  /* G6. D-4 negative fixture 통과 100% ---------------------------------- */
  {
    if (skipFixture) {
      record('G6', 'D-4 negative fixture 통과 100%', 'UNVERIFIED', '--skip-fixture로 건너뜀');
    } else if (!fixture.ran) {
      record(
        'G6',
        'D-4 negative fixture 통과 100%',
        'UNVERIFIED',
        'fixture 스위트를 실행하지 못했습니다.',
        'packages/card-parsers의 vitest를 돌릴 수 있어야 합니다.',
      );
    } else if (fixture.ok) {
      record(
        'G6',
        'D-4 negative fixture 통과 100%',
        'PASS',
        `action-amount.shadow.test.ts ${fixture.passed}/${fixture.total} 통과`,
      );
    } else {
      record(
        'G6',
        'D-4 negative fixture 통과 100%',
        'FAIL',
        'fixture 스위트가 실패했습니다.',
      );
    }
  }

  /* G7. retained 카드문자 corpus 전수 재생 ------------------------------ */
  {
    const pass = corpus.events > 0;
    record(
      'G7',
      'retained 카드문자 corpus 전수 재생',
      pass ? 'PASS' : 'UNVERIFIED',
      `문자 ${corpus.events}건 재생 (라우팅됨 ${corpus.routed} · 비카드 ${corpus.unrouted})` +
        ` · verdict ${JSON.stringify(corpus.byVerdict)}`,
      pass ? undefined : '재생 대상이 없습니다.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 4단계 사전 검토 — 판정이 아니라 관측치(게이트에 합산하지 않는다)             */
/* -------------------------------------------------------------------------- */

function renderStage4(probe) {
  const { fx, repair } = probe;
  const lines = [];
  lines.push('');
  lines.push('── 4단계 사전 검토 (참고 · 3단계 게이트에 합산하지 않음) ──');
  lines.push(
    `  환율 스냅샷: ${fx.snapshots.total}개 (통화 ${fx.snapshots.currencies} · 기준일 ${fx.snapshots.dates})`,
  );
  lines.push(
    `  외화 거래: ${fx.foreignTransactions.total}건 · 스냅샷 미연결 ${fx.foreignTransactions.withoutSnapshot}건`,
  );
  for (const need of fx.neededBaseDates) {
    lines.push(`    - ${need.currency}: 기준일 ${need.baseDates}개 필요`);
  }
  lines.push(
    `  수리 대상(v1) ${repair.v1Rows}행 / v2 ${repair.v2Rows}행 · 가구 ${repair.households}곳`,
  );
  lines.push(
    `  그중 shadow가 실제로 판정해 본 것 ${repair.shadowObservedTransactions}행` +
      ` · 판정 근거 없는 v1 ${repair.unobservedV1Rows}행`,
  );
  return lines;
}

/* -------------------------------------------------------------------------- */
/* 출력                                                                       */
/* -------------------------------------------------------------------------- */

function render(probe, fixture) {
  const icon = { PASS: '✓', FAIL: '✗', UNVERIFIED: '?' };
  const lines = [];
  lines.push('');
  lines.push('ADR-0027 전환 게이트 — 롤아웃 3단계 조건');
  lines.push('='.repeat(72));
  for (const item of results) {
    lines.push(`${icon[item.status]} [${item.status.padEnd(10)}] ${item.id} ${item.title}`);
    lines.push(`      ${item.detail}`);
    if (item.why) lines.push(`      → ${item.why}`);
  }
  lines.push('='.repeat(72));

  const failed = results.filter((r) => r.status === 'FAIL');
  const unverified = results.filter((r) => r.status === 'UNVERIFIED');
  const verdict =
    failed.length === 0 && unverified.length === 0 ? 'READY' : 'NOT READY';

  lines.push(
    `판정: ${verdict}  (PASS ${results.length - failed.length - unverified.length} · ` +
      `FAIL ${failed.length} · UNVERIFIED ${unverified.length})`,
  );
  if (failed.length) lines.push(`  FAIL: ${failed.map((r) => r.id).join(', ')}`);
  if (unverified.length) {
    lines.push(`  UNVERIFIED: ${unverified.map((r) => r.id).join(', ')}`);
    lines.push('  ⚠ UNVERIFIED는 통과가 아닙니다 — 확인하지 못한 조건입니다.');
  }
  lines.push(...renderStage4(probe));
  lines.push('');
  lines.push(`읽기 전용 가드: SQLSTATE ${probe.guard.sqlstate} 확인됨`);
  lines.push('');
  return { text: lines.join('\n'), verdict, failed, unverified };
}

/* -------------------------------------------------------------------------- */
/* 진입점                                                                     */
/* -------------------------------------------------------------------------- */

let probe;
try {
  assertTargetContainer();
  probe = runProbe();
} catch (error) {
  console.error(`수집 실패: ${error instanceof Error ? error.message : error}`);
  process.exit(3);
}

const fixture = skipFixture ? { ran: false, ok: false } : runFixtureSuite();
judgeStage3(probe, fixture);
const rendered = render(probe, fixture);

if (wantJson) {
  process.stdout.write(
    `${JSON.stringify(
      { verdict: rendered.verdict, conditions: results, probe, fixture: { ...fixture, raw: undefined } },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(rendered.text);
}

if (rendered.failed.length > 0) process.exit(1);
if (rendered.unverified.length > 0) process.exit(2);
process.exit(0);
