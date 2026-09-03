// =============================================================================
// parser-gate-probe.mjs — ADR-0027 6단계: 파서 게이트 전수 재생 (운영 DB 읽기 전용)
// -----------------------------------------------------------------------------
// ⚠️ 호스트에서 직접 실행되지 않는다. `check-parser-gate.mjs`가 소스를 읽어 운영
//    worker 컨테이너의 `node --input-type=module -`에 stdin으로 흘려 넣는다.
//
// ## 왜 필요한가 — corpus 통과는 절반의 증거다
//
// `action-amount.shadow.test.ts`가 코퍼스 58건으로 전환 조건 네 개를 지킨다(기존 금액
// delta 0 · span 불변식 · positive 100% 일치 · D-4 negative 교정). 하지만 그 코퍼스는
// **사람이 고른 표본**이다. ADR 3단계는 "retained 카드문자 corpus를 전수 재생"하라고
// 요구한다 — 실제로 이 집에 온 문자 전체가 게이트를 통과해야 한다.
//
// 4단계에서 배운 것과 같은 함정이다: **표본이 0이어도 delta는 0이다.** 코퍼스에 없는
// 레이아웃이 운영에 있으면 게이트를 켠 뒤에야 알게 된다.
//
// ## 게이트 판정 기준 (ADR 롤아웃 3단계 전환 조건)
//
//   1. 기존 정상 KRW 결과의 금액 delta 0건       → `amount_differs`(정상 승인) 0
//   2. 설명되지 않은 외화 delta 0건               → 외화 `amount_differs` 0
//   3. 기존 정상 승인 신규 격리 0건                → `new_missing`(정상 승인) 0
//   4. D-4 negative 통과 100%                     → 코퍼스 테스트가 담당(여기 밖)
//
// `new_rejects_legacy`는 **위반이 아니다.** 신규가 판촉·한도·잔액을 걸러낸 것이고,
// 그게 이 게이트의 목적이다. 다만 그 건이 실제로 비거래인지는 사람이 봐야 하므로
// 식별자 접두와 상태만 표본으로 남긴다.
//
// ## 계약
//
//  1. **읽기 전용**. `repeatable read, read only` + `where false` UPDATE 25006 자가검증.
//  2. **판정 로직을 베끼지 않는다.** 운영 이미지의 `@family/card-parsers` dist에 있는
//     `parseCardSms`와 `compareAmountEvidence`를 그대로 부른다.
//  3. **PII 없음.** 원문·가맹점명·카드번호를 출력에 담지 않는다. 식별자는 접두 8자만.
// =============================================================================
const DATABASE_DIST = '/app/packages/database/dist/index.mjs';
const PARSERS_DIST = '/app/packages/card-parsers/dist/index.mjs';

const DRIZZLE_CANDIDATES = [
  '/app/packages/database/node_modules/drizzle-orm/index.js',
  '/app/node_modules/.pnpm/node_modules/drizzle-orm/index.js',
  '/app/node_modules/drizzle-orm/index.js',
];

async function importDrizzle() {
  const failures = [];
  for (const candidate of DRIZZLE_CANDIDATES) {
    try {
      return await import(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error?.code ?? error?.message ?? error}`);
    }
  }
  throw new Error(`drizzle-orm을 찾지 못했습니다.\n${failures.join('\n')}`);
}

const { createDbClient } = await import(DATABASE_DIST);
const { sql } = await importDrizzle();
const parsers = await import(PARSERS_DIST);
for (const name of ['parseCardSms', 'compareAmountEvidence', 'summarizeAmountShadow']) {
  if (typeof parsers[name] !== 'function') {
    throw new Error(`운영 이미지의 @family/card-parsers에 ${name}이 없습니다 — 재생 불가.`);
  }
}
const { parseCardSms, compareAmountEvidence, summarizeAmountShadow } = parsers;

function assertSelectOnly(text) {
  const stripped = String(text).replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/u, '');
  if (!/^(?:select|with)\b/iu.test(stripped)) {
    throw new Error(`읽기 전용 프로브가 비-SELECT SQL을 거부했습니다: ${stripped.slice(0, 80)}`);
  }
}

async function proveReadOnlyGuard(client) {
  let observed = null;
  try {
    await client.begin(async (tx) => {
      await tx`set transaction read only`;
      await tx`update card_sms_events set parse_error = parse_error where false`;
    });
  } catch (error) {
    observed = error?.code ?? null;
  }
  if (observed !== '25006') {
    throw new Error(`읽기 전용 가드 자가검증 실패: 25006을 기대했으나 ${observed ?? '오류 없음'}`);
  }
  return { sqlstate: observed };
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 필요합니다.');
  process.exit(1);
}

const { db, client } = createDbClient(databaseUrl, { max: 1 });

try {
  const guard = await proveReadOnlyGuard(client);

  const payload = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);

    const listSql = sql`
      select id, sender, raw_content, received_at, parse_status,
             transaction_type, amount, currency
      from card_sms_events
      order by received_at, id`;
    assertSelectOnly(db.dialect.sqlToQuery(listSql).sql);
    const rows = await tx.execute(listSql);

    const records = [];
    const byTier = {};
    const byStatus = {};
    const violations = [];
    const rejectSamples = [];
    let storedDelta = 0;

    for (const row of rows) {
      const input = {
        sender: row.sender,
        content: row.raw_content,
        receivedAt: new Date(row.received_at),
      };
      // legacy는 **게이트를 끈** 결과다. 게이트가 배포된 뒤 그냥 부르면 게이트
      // 결과끼리 비교하게 되어 이 재생이 항상 `same`을 보고한다.
      const legacy = parseCardSms(input, { actionGate: false });
      const record = compareAmountEvidence(input, legacy);
      records.push(record);

      const status = record.candidate.status;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      const tier = record.candidate.scope ?? 'none';
      byTier[tier] = (byTier[tier] ?? 0) + 1;

      // 저장값과 재생값이 다르면 파서가 그 사이 바뀐 것이다 — 게이트 판정 전에
      // 알아야 한다(재생 기준이 저장 기준과 어긋난 상태에서 켜면 안 된다).
      if (row.amount !== null && legacy.amount !== undefined && row.amount !== legacy.amount) {
        storedDelta += 1;
      }

      if (!record.routed) continue;

      // 게이트 위반: 기존이 정상 승인/취소로 읽은 건을 신규가 놓치거나 다르게 읽음.
      const legacyIsTransaction =
        row.parse_status === 'parsed' &&
        (row.transaction_type === 'approval' || row.transaction_type === 'cancellation');
      if (legacyIsTransaction && (record.verdict === 'new_missing' || record.verdict === 'amount_differs')) {
        violations.push({
          id: String(row.id).slice(0, 8),
          verdict: record.verdict,
          status,
          tier,
          type: row.transaction_type,
          foreign: row.currency !== 'KRW',
          legacyAmount: record.legacyAmount ?? null,
          newAmount: record.candidate.amount ?? null,
          discarded: (record.candidate.discarded ?? []).map((d) => d.reason),
        });
      }

      if (record.verdict === 'new_rejects_legacy' && rejectSamples.length < 20) {
        rejectSamples.push({
          id: String(row.id).slice(0, 8),
          status,
          parseStatus: row.parse_status,
          type: row.transaction_type ?? null,
          legacyAmount: record.legacyAmount ?? null,
        });
      }
    }

    return {
      summary: summarizeAmountShadow(records),
      byTier,
      byStatus,
      storedDelta,
      violations,
      rejectSamples,
    };
  });

  process.stdout.write(JSON.stringify({ guard, ...payload }));
} finally {
  await client.end({ timeout: 5 });
}
