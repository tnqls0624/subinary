#!/usr/bin/env node
// =============================================================================
// snapshot-money-baseline.mjs — ADR-0027 전환 기준선 스냅샷 (운영 DB 읽기 전용)
// -----------------------------------------------------------------------------
// ADR-0027 롤아웃 1단계 "관측 기준 고정". 3·4단계의 전환 조건이 전부 "delta 0건"
// 형태라, 비교 대상 기준선이 없으면 전환 후 무엇이 바뀌었는지 증명할 수 없다.
// ADR-0026이 2026-07 `812,414원/63건`을 본문에 박아 무회귀 판정에 쓴 것과 같은
// 목적이며, 이번에는 재실행 가능한 스크립트로 만든다.
//
// 이 스크립트가 지키는 계약:
//
//  1. 운영 DB에 **SELECT만** 나간다. 프로브가 모든 조회를
//     `set transaction isolation level repeatable read, read only` 안에서 돌리고,
//     매 실행 자기 가드를 SQLSTATE 25006으로 증명한 뒤에야 수집을 시작한다.
//  2. 운영 컨테이너 파일시스템에 **쓰지 않는다**. `docker cp` 대신 프로브 소스를
//     stdin으로 흘려 넣는다. `docker compose`는 아예 쓰지 않으므로 `-p` 누락으로
//     운영 스택을 교체할 위험이 구조적으로 없다.
//  3. 지출 합계는 SQL을 새로 쓰지 않고 `@family/database`의 `spendPeriodWindow`·
//     `notTransferCategory`를 **호출**해 구한다(프로브 참조). 정의가 갈라지는 것이
//     ADR-0026이 막으려던 문제 자체다.
//  4. PII를 출력하지 않는다 — 원문·가맹점명 없이 건수·합계·식별자만 남긴다.
//
// ⚠️ 관습에서 벗어난 점 둘:
//
//   (a) 기존 verify-* 스크립트는 대상 컨테이너 이름에 `family-memory-ai`가 들어가면
//       하드 거부한다(파괴적 SQL을 쓰기 때문). 이 스크립트는 반대로 **운영이 대상**
//       이므로 그 가드를 뒤집는다 — 대신 읽기 전용을 DB가 강제하게 만들었다.
//       `verification-database-guard.mjs`는 여기서 쓸 수 없다: allowWrite=1을 강제하고
//       DB 이름에 test/verify 구분자를 요구해 `family_memory`는 무조건 throw된다.
//
//   (b) 저장소의 다른 스크립트는 stdout 전용이지만 이 스크립트는 `--out`으로 JSON을
//       파일에 남길 수 있다. 기준선은 나중에 대조해야 하는 값이라 사람이 읽고 끝나면
//       의미가 없기 때문이다. 기본값은 여전히 stdout이다.
//
// 실행:
//   node scripts/snapshot-money-baseline.mjs                # 사람이 읽는 표
//   node scripts/snapshot-money-baseline.mjs --json         # 원시 JSON
//   node scripts/snapshot-money-baseline.mjs --twice        # 재현성 검증(2회 대조)
//   node scripts/snapshot-money-baseline.mjs --out base.json
// =============================================================================
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = resolve(scriptDirectory, 'lib/money-baseline-probe.mjs');

/**
 * 프로브는 api 컨테이너 안에서만 돈다 — `/app/packages/database/dist`와 node가
 * 거기 있기 때문이다. postgres 컨테이너를 지정하면 node가 없어 실패하므로,
 * 실수를 조용한 오류가 아니라 명시적 거부로 만든다.
 */
const API_CONTAINER = process.env.BASELINE_API_CONTAINER || 'family-memory-ai-api-1';

/**
 * ADR-0026이 무회귀 기준으로 박아 둔 값(`docs/adr/0026-...md:23-37`, 측정 2026-08-06).
 * 2026-08은 그날까지만 담긴 **부분 달**이라 이후 값과 같을 수 없다 — 대조는 하되
 * 불일치를 발견으로 취급하지 않는다. 닫힌 달인 2026-07만이 진짜 무회귀 기준이다.
 */
const ADR_0026_REFERENCE = {
  '2026-07': { count: 63, netAmount: 812_414, closed: true },
  '2026-08': { count: 28, netAmount: 411_089, closed: false },
};

const args = new Set(process.argv.slice(2));
const wantJson = args.has('--json');
const wantTwice = args.has('--twice');
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;

let failed = 0;
const findings = [];

function step(n, title) {
  console.error(`\n[${n}] ${title}`);
}

function ok(message) {
  console.error(`  ✓ ${message}`);
}

function fail(message, extra) {
  failed += 1;
  findings.push(message);
  console.error(`  ✗ ${message}`);
  if (extra !== undefined) {
    console.error(`    상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
}

function note(message) {
  findings.push(message);
  console.error(`  ⚠ ${message}`);
}

const won = (value) => `${Number(value).toLocaleString('ko-KR')}원`;

/** 컨테이너가 살아 있고 이름이 우리가 의도한 것인지 먼저 확인한다. */
function assertTargetContainer() {
  if (/postgres/u.test(API_CONTAINER)) {
    throw new Error(
      `프로브는 api 컨테이너에서 실행됩니다(node + @family/database dist 필요). 대상: ${API_CONTAINER}`,
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

/** 프로브 소스를 stdin으로 주입해 실행하고 JSON을 회수한다. */
function runProbe() {
  const source = readFileSync(PROBE_PATH, 'utf8');
  const stdout = execFileSync(
    'docker',
    ['exec', '-i', API_CONTAINER, 'node', '--input-type=module', '-'],
    { input: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    throw new Error(`프로브가 JSON을 반환하지 않았습니다: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(trimmed);
}

/** 측정 시각처럼 매번 달라지는 값이 없는 payload라 본문 전체를 그대로 해시한다. */
function digest(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function renderReport(snapshot) {
  const {
    overview,
    monthlySpend,
    monthlySpendCrosscheck,
    spendReconciliation,
    visibilityBreakdown,
    foreignCurrency,
    unlinkedCancellations,
    d4Suspects,
    integrity,
  } = snapshot;

  const lines = [];
  lines.push('# ADR-0027 금액 계약 기준선 스냅샷');
  lines.push('');
  lines.push(
    `대상: household ${overview.households}개 · 구성원 ${overview.members}명 · ` +
      `card_transactions ${overview.cardTransactions}행 · card_sms_events ${overview.cardSmsEvents}행`,
  );
  lines.push('');

  lines.push('## 1. 가구·월별 공식 지출 (ADR-0026 정의)');
  lines.push('');
  lines.push('| household | 월 | 건수 | 순지출 | 승인액 | 취소액 |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const row of monthlySpend) {
    lines.push(
      `| ${row.householdId.slice(0, 8)} | ${row.month} | ${row.count} | ${won(row.netAmount)} | ` +
        `${won(row.approvedAmount)} | ${won(row.cancelledAmount)} |`,
    );
  }
  lines.push('');

  lines.push('## 1d. 공식 합계 분해 (전체 승인 − 제외 − 자산이동)');
  lines.push('');
  lines.push('| 월 | 전체 승인 | 제외분 | 자산이동분 | = 공식 |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const row of spendReconciliation.byMonth) {
    const official = row.totalNet - row.excludedNet - row.transferNet;
    lines.push(
      `| ${row.month} | ${row.totalCount}건 ${won(row.totalNet)} | ` +
        `${row.excludedCount}건 ${won(row.excludedNet)} | ` +
        `${row.transferCount}건 ${won(row.transferNet)} | ${won(official)} |`,
    );
  }
  lines.push('');
  if (spendReconciliation.exclusionTimeline.length > 0) {
    lines.push('제외가 적용된 시각(전환 delta를 사용자 행위와 구분하는 축):');
    lines.push('');
    lines.push('| 거래 월 | 제외된 날 | 건수 | 순액 |');
    lines.push('| --- | --- | ---: | ---: |');
    for (const row of spendReconciliation.exclusionTimeline) {
      lines.push(
        `| ${row.month} | ${row.excludedOn} | ${row.count} | ${won(row.netAmount)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## 1c. 공개범위 분해 (같은 모집단)');
  lines.push('');
  lines.push('| 월 | visibility | 건수 | 순지출 |');
  lines.push('| --- | --- | ---: | ---: |');
  for (const row of visibilityBreakdown) {
    lines.push(`| ${row.month} | ${row.visibility} | ${row.count} | ${won(row.netAmount)} |`);
  }
  lines.push('');

  lines.push('## 2. 외화 인벤토리');
  lines.push('');
  lines.push('| currency | 종류 | 건수 | 순액 |');
  lines.push('| --- | --- | ---: | ---: |');
  for (const row of foreignCurrency.byCurrency) {
    lines.push(
      `| ${row.currency} | ${row.transactionType} | ${row.count} | ${won(row.netAmount)} |`,
    );
  }
  lines.push('');
  const f = foreignCurrency.flags;
  lines.push(`- KRW 아닌 통화로 저장된 행(D-3): **${f.nonKrwStored}건**`);
  lines.push(`- 원통화 정보 보유(D-1 후보): **${f.hasOriginalCurrency}건**`);
  lines.push(`- 원통화는 있는데 환율 결측: ${f.originalWithoutRate}건`);
  lines.push(`- 원통화는 있는데 원금액 결측: ${f.originalWithoutAmount}건`);
  lines.push(`- KRW 아닌데 원통화 정보 없음: ${f.nonKrwWithoutOriginal}건`);
  lines.push('');
  lines.push('| 승격 경로(간접 신호) | 건수 | 외화 | 비KRW |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const row of foreignCurrency.byPromotionPath) {
    lines.push(`| ${row.path} | ${row.count} | ${row.foreignCount} | ${row.nonKrwCount} |`);
  }
  lines.push('');

  lines.push('## 3. 미연결 취소 (D-2)');
  lines.push('');
  lines.push(`- 취소 행 전체: ${unlinkedCancellations.cancellations}건`);
  lines.push(
    `- 부모 미연결: **${unlinkedCancellations.unlinked}건** / ${won(unlinkedCancellations.unlinkedAmount)}`,
  );
  for (const row of unlinkedCancellations.unlinkedByStatus) {
    lines.push(`  - status=${row.status}: ${row.count}건`);
  }
  lines.push('');

  lines.push('## 4. D-4 의심 후보');
  lines.push('');
  lines.push(`- 스캔한 승인: ${d4Suspects.approvalsScanned}건`);
  lines.push(`- 강한 의심(채택된 금액의 인접 문맥이 판촉/한도): **${d4Suspects.strong}건**`);
  lines.push(`- 약한 의심(채택 지점은 깨끗하나 원문에 판촉/한도 금액이 따로 있음): **${d4Suspects.weak}건**`);
  lines.push(`- 원문에 \`N원\` 토큰 없음(외화 표기·수동 합성 이벤트): **${d4Suspects.noAmountToken}건**`);
  lines.push(`- 비거래 문맥 승격(출금·입금·이체·송금 문맥인데 approval): **${d4Suspects.nonTransactionContext}건**`);
  lines.push('');

  lines.push('## 5. 취소 연결 무결성 · v2 불변식 사전 위반');
  lines.push('');
  lines.push('| 항목 | 건수 |');
  lines.push('| --- | ---: |');
  lines.push(`| 자식 취소를 가진 승인 | ${integrity.approvalsWithChildren} |`);
  lines.push(`| cancelled_amount ≠ 자식 취소 합 | ${integrity.cancelledAmountMismatch} |`);
  lines.push(`| 승인 net_amount ≠ amount − cancelled_amount | ${integrity.netAmountViolation} |`);
  lines.push(`| 취소 net_amount ≠ 0 | ${integrity.cancellationNetViolation} |`);
  lines.push(`| currency ≠ KRW | ${integrity.nonKrwViolation} |`);
  lines.push(`| 음수 금액 | ${integrity.negativeAmountViolation} |`);
  lines.push(`| 취소-승인 통화 불일치 | ${integrity.parentCurrencyMismatch} |`);
  lines.push('');

  // 교차검증 결과는 리포트 본문이 아니라 판정 로그에 남긴다.
  void monthlySpendCrosscheck;
  return lines.join('\n');
}

/** 항목 1과 1b가 같은 값인지 — 다르면 헬퍼와 analytics 그룹핑의 정의가 갈라진 것이다. */
function crosscheckMonthly(snapshot) {
  const key = (row) => `${row.householdId}|${row.month}`;
  const helper = new Map(snapshot.monthlySpend.map((row) => [key(row), row]));
  const grouped = new Map(snapshot.monthlySpendCrosscheck.map((row) => [key(row), row]));

  const keys = new Set([...helper.keys(), ...grouped.keys()]);
  let mismatches = 0;
  for (const k of keys) {
    const a = helper.get(k);
    const b = grouped.get(k);
    if (!a || !b) {
      fail(`교차검증: ${k}가 한쪽에만 존재`, { helper: a ?? null, grouped: b ?? null });
      mismatches += 1;
      continue;
    }
    if (a.count !== b.count || a.netAmount !== b.netAmount) {
      fail(`교차검증 불일치: ${k}`, { helper: a, grouped: b });
      mismatches += 1;
    }
  }
  if (mismatches === 0) {
    ok(`spendPeriodWindow 순회 = analytics to_char 그룹핑 (${keys.size}개 버킷 전부 일치)`);
  }
}

/** ADR-0026 고정값과 대조한다. 다르면 억지로 맞추지 않고 발견으로 남긴다. */
function compareWithAdr0026(snapshot) {
  for (const [month, expected] of Object.entries(ADR_0026_REFERENCE)) {
    const rows = snapshot.monthlySpend.filter((row) => row.month === month);
    const actual = rows.reduce(
      (acc, row) => ({ count: acc.count + row.count, netAmount: acc.netAmount + row.netAmount }),
      { count: 0, netAmount: 0 },
    );
    if (actual.count === expected.count && actual.netAmount === expected.netAmount) {
      ok(`${month}: ADR-0026 기준값과 동일 (${expected.count}건 / ${won(expected.netAmount)})`);
      continue;
    }

    const delta =
      `기준 ${expected.count}건/${won(expected.netAmount)} → ` +
      `현재 ${actual.count}건/${won(actual.netAmount)} ` +
      `(Δ ${actual.count - expected.count}건 / ${won(actual.netAmount - expected.netAmount)})`;

    if (!expected.closed) {
      // 부분 달을 이후 시점과 비교하면 당연히 다르다. 발견으로 세지 않는다.
      console.error(`  · ${month}: 진행 중인 달이라 대조 대상 아님 — ${delta}`);
      continue;
    }

    note(`${month}: ADR-0026 기준값과 다름 — ${delta}`);
    explainMonthlyDelta(snapshot, month);
  }
}

/**
 * 닫힌 달의 delta는 반드시 요인으로 설명돼야 한다.
 * 공식 합계 = 전체 승인 − 제외분 − 자산이동분이므로 세 축을 그대로 보여 준다.
 */
function explainMonthlyDelta(snapshot, month) {
  const row = snapshot.spendReconciliation?.byMonth?.find((entry) => entry.month === month);
  if (!row) return;
  console.error(
    `    분해: 전체 승인 ${row.totalCount}건/${won(row.totalNet)} ` +
      `− 제외 ${row.excludedCount}건/${won(row.excludedNet)} ` +
      `− 자산이동 ${row.transferCount}건/${won(row.transferNet)}`,
  );
  const timeline = (snapshot.spendReconciliation?.exclusionTimeline ?? []).filter(
    (entry) => entry.month === month,
  );
  for (const entry of timeline) {
    console.error(
      `    제외 시각: ${entry.excludedOn} — ${entry.count}건 / ${won(entry.netAmount)}`,
    );
  }
}

function main() {
  step(0, `대상 확인 — ${API_CONTAINER}`);
  assertTargetContainer();
  ok('api 컨테이너 실행 중');

  step(1, '프로브 실행 (읽기 전용 가드 자가검증 포함)');
  const snapshot = runProbe();
  if (snapshot.guard?.sqlstate !== '25006') {
    fail('읽기 전용 가드 자가검증이 25006을 보고하지 않았습니다', snapshot.guard);
  } else {
    ok('읽기 전용 가드 실증 — READ ONLY 트랜잭션이 UPDATE를 25006으로 거부');
  }

  const { guard, ...payload } = snapshot;
  void guard;

  step(2, '집계 정의 교차검증');
  crosscheckMonthly(payload);

  step(3, 'ADR-0026 고정 기준값 대조');
  compareWithAdr0026(payload);

  if (wantTwice) {
    step(4, '재현성 검증 — 2회 실행 대조');
    const { guard: _second, ...again } = runProbe();
    const first = digest(payload);
    const second = digest(again);
    if (first === second) {
      ok(`두 실행 결과 동일 (sha256:${first})`);
    } else {
      fail('두 실행 결과가 다릅니다', { first, second });
    }
  }

  const report = renderReport(payload);
  const serialized = JSON.stringify(payload, null, 2);

  if (outPath) {
    writeFileSync(outPath, `${serialized}\n`, 'utf8');
    console.error(`\n  → JSON 저장: ${outPath}`);
  }

  console.error('\n────────────────────────────────────────');
  console.error(`요약: 실패 ${failed} · 특이사항 ${findings.length}`);
  console.error(`본문 해시: sha256:${digest(payload)}`);
  console.error('────────────────────────────────────────');

  // 리포트/JSON은 stdout — 리다이렉트로 그대로 파일에 담을 수 있게 진단과 분리한다.
  process.stdout.write(wantJson ? `${serialized}\n` : `${report}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(`\n예기치 못한 오류: ${error?.message ?? error}`);
  process.exit(1);
}
