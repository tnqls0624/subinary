// =============================================================================
// fx-backfill-probe.mjs — 레거시 환율의 스냅샷 고정 (운영 컨테이너 안에서 실행)
// -----------------------------------------------------------------------------
// ⚠️ 호스트에서 직접 실행되지 않는다. `fixate-legacy-fx-snapshots.mjs`가 소스를 읽어
//    운영 api 컨테이너의 `node --input-type=module -`에 stdin으로 흘려 넣는다.
//    구조는 `money-gate-probe.mjs`와 같은 관습이다.
//
// 이 프로브의 계약:
//
//  1. **기본은 읽기 전용**이다. `FX_BACKFILL_APPLY=1`일 때만 쓰기를 연다. 읽기 모드는
//     `repeatable read, read only` + `where false` UPDATE 25006 자가검증을 통과해야
//     시작한다(기준선·게이트 프로브와 동일).
//  2. **환율을 새로 구하지 않는다.** 거래에 이미 적용된 `exchange_rate`를 그 기준일의
//     스냅샷으로 승격할 뿐이다. 그래서 사용자가 본 금액이 바뀌지 않는다 — 이 작업의
//     목적은 값의 교정이 아니라 **재계산해도 같은 값이 나오게 만드는 것**이다(ADR §3
//     "첫 성공 값을 불변으로 고정하고 모든 재시도가 같은 행을 참조한다").
//  3. **한 그룹에 환율이 둘 이상이면 건너뛴다.** 같은 (통화, 기준일)인데 거래마다 다른
//     환율이 적용됐다면 어느 것이 "첫 성공 값"인지 기계가 정할 수 없다. 사람이 본다.
//  4. **거래 행을 건드리지 않는다.** `fx_rate_snapshot_id` 연결과 금액 재계산은 롤아웃
//     7단계(기존 데이터 수리)의 몫이다. 여기서 하면 두 단계가 섞인다.
//  5. 삽입은 `DrizzleFxSnapshotStore.fixate`로만 한다 — 규칙을 베껴 쓰면 "스크립트는
//     통과하는데 운영은 다르게 도는" 상태가 된다.
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
if (typeof domain.DrizzleFxSnapshotStore !== 'function') {
  throw new Error(
    '운영 이미지의 @family/transaction-domain에 DrizzleFxSnapshotStore가 없습니다.',
  );
}
const { DrizzleFxSnapshotStore } = domain;

const APPLY = process.env.FX_BACKFILL_APPLY === '1';

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
    throw new Error(
      `읽기 전용 가드 자가검증 실패: SQLSTATE 25006을 기대했으나 ${observed ?? '오류 없음'}`,
    );
  }
  return { sqlstate: observed };
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 필요합니다.');
  process.exit(1);
}

const { db, client } = createDbClient(databaseUrl, { max: 1 });

/**
 * 스냅샷이 없는 외화 거래를 (통화, 기준일)로 묶는다.
 *
 * 기준일은 `approved_at`(취소는 `cancelled_at`)의 **서울 날짜**다 — 계획기의
 * `fxBaseDate`와 같은 기준이어야 고정한 스냅샷을 그대로 찾아 쓴다.
 */
const GROUPS_SQL = sql`
  select
    upper(coalesce(original_currency, currency))                                  as base_currency,
    (coalesce(approved_at, cancelled_at) at time zone 'Asia/Seoul')::date::text   as as_of_date,
    count(*)::int                                                                 as txn_count,
    count(distinct exchange_rate)::int                                            as distinct_rates,
    min(exchange_rate)                                                            as min_rate,
    max(exchange_rate)                                                            as max_rate
  from card_transactions
  where fx_rate_snapshot_id is null
    and coalesce(original_currency, currency) <> 'KRW'
    and exchange_rate is not null
    and coalesce(approved_at, cancelled_at) is not null
  group by 1, 2
  order by 2, 1`;

try {
  const guard = APPLY ? { sqlstate: 'skipped(apply)' } : await proveReadOnlyGuard(client);

  const groups = await db.transaction(async (tx) => {
    if (!APPLY) {
      await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    }
    assertSelectOnly(db.dialect.sqlToQuery(GROUPS_SQL).sql);
    return await tx.execute(GROUPS_SQL);
  });

  const planned = [];
  const skipped = [];
  for (const g of groups) {
    if (Number(g.distinct_rates) !== 1) {
      skipped.push({
        baseCurrency: g.base_currency,
        asOfDate: g.as_of_date,
        reason: 'rate_conflict',
        detail: `같은 날 환율이 ${g.distinct_rates}종 (${g.min_rate} ~ ${g.max_rate})`,
        txnCount: Number(g.txn_count),
      });
      continue;
    }
    planned.push({
      baseCurrency: g.base_currency,
      asOfDate: g.as_of_date,
      // double precision을 numeric(24,12) 문자열로. 유효숫자를 잃지 않게 지수표기를 편다.
      rate: Number(g.min_rate).toFixed(12),
      txnCount: Number(g.txn_count),
    });
  }

  const applied = [];
  if (APPLY && planned.length > 0) {
    const store = new DrizzleFxSnapshotStore(db);
    const fetchedAt = new Date();
    for (const p of planned) {
      const ref = await store.fixate(
        { baseCurrency: p.baseCurrency, asOfDate: p.asOfDate },
        p.rate,
        {
          provider: 'legacy-backfill',
          providerVersion: 'v1-exchange-rate',
          providerReference: null,
          note:
            'ADR-0027 4단계: v1 거래에 이미 적용된 exchange_rate를 그 기준일의 불변 ' +
            '스냅샷으로 승격했다. 값을 새로 구하지 않았으므로 사용자가 본 금액은 바뀌지 않는다.',
          createdBy: null,
          fetchedAt,
        },
      );
      applied.push({
        ...p,
        snapshotId: ref?.id ?? null,
        // fixate는 onConflictDoNothing + SELECT다. 이미 있던 행이면 rate가 다를 수 있다.
        storedRate: ref?.rate ?? null,
      });
    }
  }

  process.stdout.write(
    JSON.stringify({ guard, mode: APPLY ? 'apply' : 'dry-run', planned, skipped, applied }),
  );
} finally {
  await client.end({ timeout: 5 });
}
