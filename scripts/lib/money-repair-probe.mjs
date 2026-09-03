// =============================================================================
// money-repair-probe.mjs — ADR-0027 7단계: 금액 계약 수리 (운영 컨테이너 안에서 실행)
// -----------------------------------------------------------------------------
// ⚠️ 호스트에서 직접 실행되지 않는다. `repair-money-contract.mjs`가 소스를 읽어 운영
//    api 컨테이너의 `node --input-type=module -`에 stdin으로 흘려 넣는다.
//
// ## 재생 프로브와 무엇이 다른가
//
// `money-replay-probe.mjs`는 **읽기 전용**이다. 같은 관찰기를 돌리되 sink를 메모리로
// 갈아끼워 아무것도 쓰지 않는다. 이 프로브는 그 sink 자리에 **manifest sink**를 끼운다.
// 판정 로직은 한 줄도 베끼지 않는다 — 운영 이미지의 `@family/transaction-domain` dist에
// 있는 그 관찰기를 그대로 부른다. 베끼는 순간 게이트와 수리가 다른 답을 내기 시작한다.
//
// ## 명령
//
//   plan    관찰기를 전수 재생해 **미적용 manifest**를 적재한다. 거래는 건드리지 않는다.
//   apply   배치의 auto 행에 계약 버전 스탬프를 찍는다. 금액은 바뀌지 않는다.
//   revert  배치를 역순으로 되돌린다. 사용자가 손댄 행은 건너뛴다.
//   status  배치 현황을 집계로 낸다.
//
// ## 계약
//
//  1. **PII 없음.** 가맹점명·원문·카드번호를 출력에 담지 않는다. 식별자는 접두 8자만.
//  2. `plan`은 거래 행을 쓰지 않는다 — 쓰는 곳은 `transaction_money_repair_log`뿐이다.
//  3. `apply`는 행마다 짧은 트랜잭션 + `FOR UPDATE` + 체크섬 재확인. 낡은 manifest는
//     조용히 건너뛰고 그 사실을 숫자로 낸다.
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

const { createDbClient, schema } = await import(DATABASE_DIST);
const { sql, and, eq } = await importDrizzle();
const domain = await import(DOMAIN_DIST);

const REQUIRED = [
  'TransactionMoneyShadowObserver',
  'DrizzleFxSnapshotStore',
  'TransactionMoneyRepairManifestSink',
  'TransactionMoneyRepairService',
  'newRepairBatchId',
];
for (const name of REQUIRED) {
  if (typeof domain[name] !== 'function') {
    throw new Error(`운영 이미지의 @family/transaction-domain에 ${name}이 없습니다 — 수리 불가.`);
  }
}
const {
  TransactionMoneyShadowObserver,
  DrizzleFxSnapshotStore,
  TransactionMoneyRepairManifestSink,
  TransactionMoneyRepairService,
  newRepairBatchId,
} = domain;

/** 행의 성격에서 쓰기 경로 라벨을 유도한다(재생 프로브와 같은 규칙 — 근사다). */
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

const command = process.env.REPAIR_COMMAND ?? 'status';
const batchIdArg = process.env.REPAIR_BATCH_ID ?? null;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 필요합니다.');
  process.exit(1);
}

const { db, client } = createDbClient(databaseUrl, { max: 1 });

/** 배치 현황 집계. 금액은 합계만 — 행별 금액을 출력에 싣지 않는다. */
async function batchStatus(batchId) {
  const rows = await db.execute(sql`
    select batch_id::text as batch_id,
           count(*)::int as total,
           count(*) filter (where reason like 'repair:auto:%')::int as auto,
           count(*) filter (where reason like 'repair:review:%')::int as review,
           count(*) filter (where applied_at is not null)::int as applied,
           count(*) filter (where reverted_at is not null)::int as reverted,
           count(*) filter (where revert_blocked_reason is not null)::int as blocked,
           coalesce(sum(net_amount_delta), 0)::int as net_delta_sum,
           min(created_at)::text as created_at
    from transaction_money_repair_log
    where reason like 'repair:%' ${batchId ? sql`and batch_id = ${batchId}::uuid` : sql``}
    group by batch_id
    order by min(created_at) desc
    limit 20`);
  return rows.map((r) => ({ ...r }));
}

/** manifest의 판정 분포. `reason`의 접미가 verdict다. */
async function verdictBreakdown(batchId) {
  const rows = await db.execute(sql`
    select split_part(reason, ':', 2) as eligibility,
           split_part(reason, ':', 3) as verdict,
           count(*)::int as n,
           coalesce(sum(net_amount_delta), 0)::int as net_delta_sum
    from transaction_money_repair_log
    where batch_id = ${batchId}::uuid and reason like 'repair:%'
    group by 1, 2
    order by 3 desc`);
  return rows.map((r) => ({ ...r }));
}

try {
  let payload;

  if (command === 'plan') {
    const batchId = newRepairBatchId();
    // 계획은 한 트랜잭션에서 만든다 — 절반만 적재된 manifest는 "대상 없음"으로 오독된다.
    const stats = await db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        select id, transaction_type, source_event_id, parent_transaction_id,
               money_contract_version
        from card_transactions
        where money_contract_version < 2
        order by created_at, id`);

      const sink = new TransactionMoneyRepairManifestSink(tx, batchId);
      const observer = new TransactionMoneyShadowObserver(
        tx,
        new DrizzleFxSnapshotStore(tx),
        sink,
      );
      const byPath = {};
      for (const row of rows) {
        const path = derivePath(row);
        byPath[path] = (byPath[path] ?? 0) + 1;
        // observe는 예외를 삼킨다 — 기록이 안 들어온 건은 unrecorded로 잡힌다.
        await observer.observe(row.id, path);
      }
      const s = sink.stats();
      return { ...s, targets: rows.length, unrecorded: rows.length - s.planned, byPath };
    });
    payload = { command, ...stats, breakdown: await verdictBreakdown(batchId) };
  } else if (command === 'apply') {
    if (!batchIdArg) throw new Error('apply에는 REPAIR_BATCH_ID가 필요합니다.');
    const service = new TransactionMoneyRepairService(db);
    payload = { command, ...(await service.applyBatch(batchIdArg)) };
  } else if (command === 'revert') {
    if (!batchIdArg) throw new Error('revert에는 REPAIR_BATCH_ID가 필요합니다.');
    const service = new TransactionMoneyRepairService(db);
    payload = { command, ...(await service.revertBatch(batchIdArg)) };
  } else {
    payload = {
      command: 'status',
      batches: await batchStatus(batchIdArg),
      ...(batchIdArg ? { breakdown: await verdictBreakdown(batchIdArg) } : {}),
    };
  }

  // 남은 v1 건수는 어느 명령에서도 낸다 — 7단계의 완료 조건이 이 숫자이기 때문이다.
  const [remaining] = await db.execute(sql`
    select count(*) filter (where money_contract_version < 2)::int as v1,
           count(*)::int as total
    from card_transactions`);
  process.stdout.write(JSON.stringify({ ...payload, remaining: { ...remaining } }));
} finally {
  await client.end({ timeout: 5 });
}
