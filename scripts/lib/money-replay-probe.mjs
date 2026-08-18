// =============================================================================
// money-replay-probe.mjs — 기존 거래 전수 재생 (운영 DB 읽기 전용)
// -----------------------------------------------------------------------------
// ⚠️ 호스트에서 직접 실행되지 않는다. `replay-money-contract.mjs`가 소스를 읽어 운영
//    api 컨테이너의 `node --input-type=module -`에 stdin으로 흘려 넣는다.
//
// ## 왜 필요한가 — shadow는 "새로 쓰인 것"만 본다
//
// `TransactionMoneyShadowObserver.observe()`는 쓰기 **직후**에 불린다. 그래서 관측
// 표본은 shadow 배포 이후 손댄 거래로 제한되고, 쓰지 않는 경로(수동 입력·취소 연결)와
// 오래된 거래는 영원히 표본에 들어오지 않는다. 게이트의 G2b/G4가 UNVERIFIED로 남는
// 구조적 이유가 이것이다 — **기다린다고 채워지지 않는다.**
//
// 재생은 같은 관찰기를 **기존 행 전체**에 돌린다. 쓰기를 흉내 내지 않고, 이미 커밋된
// 행을 새 계약으로 다시 계획해 대조한다. 관찰기가 원래 그렇게 만들어져 있다
// (`shadow-observer.ts` 머리주석: "커밋된 행을 다시 읽으면 경로마다 다른 중간 상태를
// 흉내 낼 필요가 없다").
//
// ## 계약
//
//  1. **읽기 전용**. `repeatable read, read only` + `where false` UPDATE 25006 자가검증.
//     쓰기는 sink 교체로 막는다 — 관찰기는 sink에만 쓴다.
//  2. **판정 로직을 베끼지 않는다.** 운영 이미지의 `@family/transaction-domain` dist에
//     있는 그 관찰기를 그대로 부른다.
//  3. **경로 라벨은 행의 성격에서 유도한다.** 어느 코드가 그 행을 만들었는지는 DB에
//     남아 있지 않다. 그래서 라벨은 근사이며, 리포트는 라벨별 집계와 **전체 delta**를
//     따로 낸다 — 판정의 근거는 후자다.
//  4. **PII 없음.** 가맹점명·원문·카드번호를 담지 않는다.
// =============================================================================
const DATABASE_DIST = '/app/packages/database/dist/index.mjs';
const DOMAIN_DIST = '/app/packages/transaction-domain/dist/index.mjs';

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
const domain = await import(DOMAIN_DIST);
for (const name of ['TransactionMoneyShadowObserver', 'DrizzleFxSnapshotStore']) {
  if (typeof domain[name] !== 'function') {
    throw new Error(`운영 이미지의 @family/transaction-domain에 ${name}이 없습니다 — 재생 불가.`);
  }
}
const { TransactionMoneyShadowObserver, DrizzleFxSnapshotStore } = domain;

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
      await tx`update card_transactions set memo = memo where false`;
    });
  } catch (error) {
    observed = error?.code ?? null;
  }
  if (observed !== '25006') {
    throw new Error(`읽기 전용 가드 자가검증 실패: 25006을 기대했으나 ${observed ?? '오류 없음'}`);
  }
  return { sqlstate: observed };
}

/**
 * 행의 성격에서 쓰기 경로 라벨을 유도한다.
 *
 * DB에 provenance가 없으므로 이것은 **근사**다. 판정의 근거로 쓰지 않고, 어느 성격의
 * 행이 재생됐는지 보이기 위한 분해로만 쓴다.
 */
function derivePath(row) {
  if (row.transaction_type === 'cancellation') {
    if (row.source_event_id === null) return 'api_manual_fields';
    return row.parent_transaction_id === null
      ? 'worker_promotion_cancellation'
      : 'api_link_cancellation';
  }
  if (row.source_event_id === null) return 'api_manual_fields';
  return 'worker_promotion_approval';
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
      select id, transaction_type, source_event_id, parent_transaction_id,
             coalesce(original_currency, currency) as currency
      from card_transactions
      order by created_at, id`;
    assertSelectOnly(db.dialect.sqlToQuery(listSql).sql);
    const rows = await tx.execute(listSql);

    // sink를 메모리로 바꾸면 관찰기는 아무것도 쓰지 않는다 — 관찰기가 쓰는 곳은 여기뿐이다.
    const records = [];
    const memorySink = {
      async record(record) {
        records.push(record);
      },
    };
    const observer = new TransactionMoneyShadowObserver(
      tx,
      new DrizzleFxSnapshotStore(tx),
      memorySink,
    );

    const byPath = {};
    const pathOf = new Map();
    for (const row of rows) {
      const path = derivePath(row);
      byPath[path] = (byPath[path] ?? 0) + 1;
      pathOf.set(row.id, path);
      // observe는 예외를 삼킨다 — 기록이 안 들어온 건은 아래에서 "미기록"으로 센다.
      await observer.observe(row.id, path);
    }

    const byVerdict = {};
    const byPathVerdict = {};
    let nonzeroDelta = 0;
    let foreign = 0;
    const deltaSamples = [];
    for (const r of records) {
      byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
      const key = `${r.path}/${r.verdict}`;
      byPathVerdict[key] = (byPathVerdict[key] ?? 0) + 1;
      if (r.foreign) foreign += 1;
      if (r.netAmountDelta !== 0 && r.netAmountDelta !== null && r.netAmountDelta !== undefined) {
        nonzeroDelta += 1;
        if (deltaSamples.length < 20) {
          // PII 없음: 식별자 접두 8자 + 분류 + delta만.
          deltaSamples.push({
            transactionId: String(r.transactionId).slice(0, 8),
            path: r.path,
            verdict: r.verdict,
            type: r.transactionType,
            foreign: Boolean(r.foreign),
            netAmountDelta: r.netAmountDelta,
            failureReason: r.failureReason ?? null,
          });
        }
      }
    }

    const failureReasons = {};
    for (const r of records) {
      if (r.failureReason) {
        failureReasons[r.failureReason] = (failureReasons[r.failureReason] ?? 0) + 1;
      }
    }

    return {
      totalRows: rows.length,
      recorded: records.length,
      unrecorded: rows.length - records.length,
      byPath,
      byVerdict,
      byPathVerdict,
      failureReasons,
      nonzeroDelta,
      foreign,
      deltaSamples,
    };
  });

  process.stdout.write(JSON.stringify({ guard, ...payload }));
} finally {
  await client.end({ timeout: 5 });
}
