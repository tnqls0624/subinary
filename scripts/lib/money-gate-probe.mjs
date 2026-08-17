// =============================================================================
// money-gate-probe.mjs — ADR-0027 전환 게이트 수집 프로브 (운영 DB 읽기 전용)
// -----------------------------------------------------------------------------
// ⚠️ 호스트에서 직접 실행되지 않는다. `check-money-contract-gate.mjs`가 소스를 읽어
//    운영 api 컨테이너의 `node --input-type=module -`에 stdin으로 흘려 넣는다.
//    구조·가드·주입 방식은 `money-baseline-probe.mjs`와 **같은 관습**이다(새로 짜지
//    않았다). 다른 점은 수집 대상뿐이다: 기준선이 아니라 **전환 조건**을 잰다.
//
// 이 프로브가 지키는 계약(기준선 프로브와 동일):
//
//  1. 읽기 전용을 **DB가 강제한다**. 모든 조회가
//     `set transaction isolation level repeatable read, read only` 안에서 돌고,
//     매 실행 `where false` UPDATE로 SQLSTATE 25006을 받아 가드 생존을 증명한 뒤에만
//     수집을 시작한다.
//  2. 애플리케이션 레벨 2차 가드 — 전송 직전 SQL이 SELECT/WITH로 시작하지 않으면 throw.
//  3. 판정 로직을 새로 쓰지 않는다. 기존 파서와 새 액션 결박 추출기를 **운영 컨테이너에
//     설치된 그 코드 그대로**(`@family/card-parsers` dist) 호출한다. 여기서 규칙을
//     베껴 쓰면 "스크립트는 통과하는데 운영은 다르게 도는" 상태가 된다.
//  4. **PII를 내보내지 않는다.** 카드 문자 원문·가맹점명·발신자를 출력에 담지 않는다.
//     새 게이트가 떨어뜨리는 건은 원문 대신 **패턴 서명**(탈락 사유 · 토큰 계열 ·
//     구조 골격)만 남긴다.
//
// 출력: stdout에 JSON 한 덩어리. 진단은 stderr.
// =============================================================================

/** 컨테이너 절대 경로. 호스트의 pnpm 해석 경로와 다르다. */
const DATABASE_DIST = '/app/packages/database/dist/index.mjs';
const CARD_PARSERS_DIST = '/app/packages/card-parsers/dist/index.mjs';

/** drizzle-orm은 pnpm 격리 때문에 bare specifier로 해석되지 않는다(기준선 프로브와 동일). */
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

/**
 * 새 게이트가 운영 이미지에 실려 있어야 재생이 성립한다. 없으면 "0건 격리"가
 * **측정하지 못했다는 뜻**이 되므로 조용히 통과시키지 않고 즉시 중단한다.
 */
const parsers = await import(CARD_PARSERS_DIST);
for (const name of ['parseCardSms', 'extractActionGroundedAmount', 'compareAmountEvidence']) {
  if (typeof parsers[name] !== 'function') {
    throw new Error(
      `운영 이미지의 @family/card-parsers에 ${name}이 없습니다 — 코퍼스 재생을 할 수 없습니다.`,
    );
  }
}
const { parseCardSms, extractActionGroundedAmount, compareAmountEvidence } = parsers;

// -----------------------------------------------------------------------------
// 읽기 전용 가드 (기준선 프로브와 동일)
// -----------------------------------------------------------------------------

function assertSelectOnly(text) {
  const stripped = String(text).replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/u, '');
  if (!/^(?:select|with)\b/iu.test(stripped)) {
    throw new Error(`읽기 전용 프로브가 비-SELECT SQL을 거부했습니다: ${stripped.slice(0, 80)}`);
  }
}

function makeReadOnlyRaw(dialect) {
  return async function readOnlyRaw(tx, fragment) {
    assertSelectOnly(dialect.sqlToQuery(fragment).sql);
    return await tx.execute(fragment);
  };
}

/**
 * 읽기 전용 가드가 실제로 살아 있는지 매 실행 증명한다(기준선 프로브와 동일).
 * 아무 행도 건드리지 않는 `where false` UPDATE가 25006으로 거부돼야 통과다.
 */
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

const num = (value) => (value === null || value === undefined ? 0 : Number(value));

const bump = (map, key) => {
  map[key] = (map[key] ?? 0) + 1;
};

// -----------------------------------------------------------------------------
// 1. shadow 관측 창 — 기간·건수·판정·**커버리지**
// -----------------------------------------------------------------------------

/**
 * ADR 3단계는 "live shadow를 최소 7일이면서 50건 이상"을 요구한다. 그런데 건수만
 * 세면 **무엇을 관측했는지**가 빠진다. 6개 쓰기 경로 중 둘만 돌았고 외화·취소가
 * 한 건도 없었다면 "delta 0"은 "차이 없음"이 아니라 "표본 없음"이다. 그 구분을
 * 숫자로 남기는 것이 이 수집의 핵심이다.
 */
async function collectShadow(tx, readOnlyRaw) {
  const [totals] = await readOnlyRaw(
    tx,
    sql`select
          count(*)::int                                as rows,
          count(distinct transaction_id)::int          as distinct_transactions,
          count(distinct created_at::date)::int        as distinct_days,
          min(created_at)                              as first_at,
          max(created_at)                              as last_at
        from transaction_money_repair_log
        where applied_at is null and reason like 'shadow:%'`,
  );

  const verdictRows = await readOnlyRaw(
    tx,
    sql`select reason,
               count(*)::int as rows,
               count(*) filter (where net_amount_delta is distinct from 0)::int as nonzero_delta
        from transaction_money_repair_log
        where applied_at is null and reason like 'shadow:%'
        group by reason`,
  );

  // 경로·유형·통화 커버리지. note(jsonb)에 path/transactionType/foreign이 들어 있다.
  const coverageRows = await readOnlyRaw(
    tx,
    sql`select (note::jsonb ->> 'path')            as path,
               (note::jsonb ->> 'transactionType') as transaction_type,
               (note::jsonb ->> 'foreign')         as is_foreign,
               count(*)::int                       as rows
        from transaction_money_repair_log
        where applied_at is null and reason like 'shadow:%'
        group by 1, 2, 3`,
  );

  const byVerdict = {};
  let nonzeroDelta = 0;
  for (const row of verdictRows) {
    byVerdict[String(row.reason).replace(/^shadow:/u, '')] = num(row.rows);
    nonzeroDelta += num(row.nonzero_delta);
  }

  const byPath = {};
  const byType = {};
  let foreignRows = 0;
  for (const row of coverageRows) {
    byPath[row.path ?? 'unknown'] = (byPath[row.path ?? 'unknown'] ?? 0) + num(row.rows);
    byType[row.transaction_type ?? 'unknown'] =
      (byType[row.transaction_type ?? 'unknown'] ?? 0) + num(row.rows);
    if (row.is_foreign === 'true') foreignRows += num(row.rows);
  }

  const firstAt = totals?.first_at ? new Date(totals.first_at) : null;
  const lastAt = totals?.last_at ? new Date(totals.last_at) : null;
  const durationDays =
    firstAt && lastAt ? (lastAt.getTime() - firstAt.getTime()) / 86_400_000 : 0;

  return {
    rows: num(totals?.rows),
    distinctTransactions: num(totals?.distinct_transactions),
    distinctDays: num(totals?.distinct_days),
    firstAt: firstAt ? firstAt.toISOString() : null,
    lastAt: lastAt ? lastAt.toISOString() : null,
    durationDays: Number(durationDays.toFixed(2)),
    byVerdict,
    nonzeroDelta,
    byPath,
    byType,
    foreignRows,
  };
}

// -----------------------------------------------------------------------------
// 2. retained 카드문자 corpus 전수 재생
// -----------------------------------------------------------------------------

/**
 * 원문을 출력하지 않고도 "어떤 문구 패턴이 떨어지는가"를 설명하기 위한 서명.
 *
 * 토큰 **계열**만 본다 — 어느 카드사인지, 어느 가맹점인지, 얼마인지는 담기지 않는다.
 * 이 값이 리포트에 나가는 유일한 원문 파생 정보다.
 */
function patternSignature(content) {
  const flags = [];
  if (/한도/u.test(content)) flags.push('한도');
  if (/누적|누계/u.test(content)) flags.push('누적');
  if (/잔액/u.test(content)) flags.push('잔액');
  if (/할인|혜택|쿠폰|이벤트|적립|캐시백/u.test(content)) flags.push('판촉');
  if (/청구|예정/u.test(content)) flags.push('청구예고');
  if (/취소|환불/u.test(content)) flags.push('취소');
  if (/거절|실패|부족/u.test(content)) flags.push('거절');
  if (/해외|USD|EUR|JPY/u.test(content)) flags.push('해외');
  const amountTokens = (content.match(/[0-9][0-9,]*\s*원/gu) ?? []).length;
  const lines = content.split(/\r?\n/u).filter((line) => line.trim() !== '').length;
  return `${flags.length ? flags.join('+') : '단순'}|금액토큰${amountTokens}|줄${lines}`;
}

/**
 * 운영에 남아 있는 카드 문자 전수를 기존 파서와 새 게이트로 동시에 재생한다.
 *
 * ADR 3단계의 두 조건을 한 번에 잰다:
 *  - "retained 카드문자 corpus 전수 재생"
 *  - "기존 정상 승인의 신규 격리 0건"
 *
 * **"기존 정상 승인"의 정의 — 두 번 고쳐 잡았다.**
 *
 * 처음에는 "`parse_status='parsed'`이고 approval 거래가 있는 건" 전부로 잡았다.
 * 그러면 운영 170건 중 8건이 "새 게이트 L0 실패"로 잡히는데, 확인해 보니 **그 8건은
 * 기존 파서도 금액을 못 뽑은 건**이었다(수동 입력 2 · 사람 검토 6). 오늘도 자동
 * 승격되지 않고 사람 손을 거치는 건이므로, 게이트를 켜서 `parse_failed` 대신
 * `quarantined` 라벨이 붙는 것은 **"기존 정상 승인의 신규 격리"가 아니다.**
 * ADR 조건이 지키려는 것은 *오늘 자동으로 잘 승격되는 승인이 격리로 떨어지는 일*이다.
 *
 * 그래서 모집단을 **L0가 실제로 금액을 만든 건**(`legacy.amount !== undefined`)으로
 * 좁힌다. 제외된 건은 버리지 않고 `humanSourced`로 따로 세어 남긴다 — 모집단을
 * 조용히 줄이면 그것대로 게이트를 무력화하는 짓이다.
 *
 * 금액 비교도 **파서 대 파서**로 한다. 저장된 `card_transactions.amount`와 비교하면
 * 외화 거래에서 반드시 어긋난다(파서는 원통화 minor units, 저장값은 환산된 KRW).
 * 실제로 USD 22.00 건이 `2200 vs 32713`으로 잡혔는데 이는 파서 오류가 아니라
 * 비교 기준의 오류였다. 사람이 검토에서 금액을 고친 건도 같은 이유로 저장값과
 * 갈릴 수 있다. 이 조건이 묻는 것은 **파서가 같은 금액을 내는가**다.
 */
async function collectCorpusReplay(tx, readOnlyRaw) {
  const events = await readOnlyRaw(
    tx,
    sql`select e.id,
               e.sender,
               e.raw_content,
               e.received_at,
               e.parse_status,
               e.amount              as stored_amount,
               e.currency            as stored_currency,
               t.id                  as transaction_id,
               t.transaction_type    as transaction_type,
               t.amount              as transaction_amount,
               t.excluded_at         as excluded_at
        from card_sms_events e
        left join card_transactions t on t.source_event_id = e.id
        order by e.received_at`,
  );

  const templateRows = await readOnlyRaw(
    tx,
    sql`select fingerprint from card_sms_templates`,
  );
  const recipeFingerprints = new Set(templateRows.map((row) => String(row.fingerprint)));

  const byVerdict = {};
  const byStatus = {};
  const byScope = {};
  let routed = 0;
  let unrouted = 0;

  // "오늘 자동으로 잘 승격되는 승인"만 모집단이다(위 주석의 정의).
  const healthy = {
    /** approval 거래가 있는 parsed 이벤트 전부(모집단 후보). */
    promotedApprovals: 0,
    /** 그중 L0가 금액을 만든 건 = 게이트 조건의 실제 모집단. */
    population: 0,
    /** L0가 금액을 못 만든 건(수동 입력·사람 검토) — 오늘도 자동 승격이 아니다. */
    humanSourced: 0,
    /** 모집단 중 새 게이트가 같은 금액으로 확정. */
    resolvedSameAmount: 0,
    /** 모집단 중 새 게이트가 확정했으나 **기존 파서와** 금액이 다름. */
    resolvedDifferentAmount: 0,
    /** 모집단 중 새 게이트가 확정 실패 = 신규 격리 후보. */
    notResolved: 0,
    rescuableByRecipe: 0,
  };
  const quarantineSignatures = {};
  const amountDeltaSignatures = {};
  const quarantineStatuses = {};

  for (const event of events) {
    const content = String(event.raw_content ?? '');
    const input = {
      sender: String(event.sender ?? ''),
      content,
      receivedAt: new Date(event.received_at),
    };

    const legacy = parseCardSms(input);
    const record = compareAmountEvidence(input, legacy);
    const candidate = record.candidate ?? extractActionGroundedAmount(content);

    if (record.routed) {
      routed += 1;
      bump(byVerdict, record.verdict);
    } else {
      unrouted += 1;
    }
    bump(byStatus, candidate.status);
    if (candidate.status === 'resolved') bump(byScope, candidate.scope ?? 'unknown');

    const isHealthyApproval =
      event.parse_status === 'parsed' &&
      event.transaction_id !== null &&
      event.transaction_type === 'approval';
    if (!isHealthyApproval) continue;
    healthy.promotedApprovals += 1;

    // L0가 금액을 만들지 않은 건은 오늘도 자동 승격이 아니다 — 모집단 밖.
    if (legacy.amount === undefined) {
      healthy.humanSourced += 1;
      continue;
    }

    healthy.population += 1;
    if (candidate.status !== 'resolved') {
      healthy.notResolved += 1;
      bump(quarantineSignatures, patternSignature(content));
      bump(quarantineStatuses, candidate.status);
      // 지문이 레시피로 등록돼 있으면 L1이 살릴 수 있다(그래도 L0 실패는 사실이다).
      if (typeof parsers.templateFingerprint === 'function') {
        const fingerprint = parsers.templateFingerprint(input.sender, content);
        if (recipeFingerprints.has(fingerprint)) healthy.rescuableByRecipe += 1;
      }
      continue;
    }

    // 게이트가 확정했더라도 **기존 파서와 금액이 다르면** 전환 조건 위반이다
    // ("기존 정상 KRW 결과의 금액 delta 0건"의 파서 쪽 대응물).
    // 비교 대상은 저장값이 아니라 `legacy.amount`다 — 저장값은 외화 환산·사람 교정을
    // 거친 뒤의 값이라 파서 정확도의 근거가 될 수 없다(위 주석 참조).
    if (Number(candidate.amount) !== Number(legacy.amount)) {
      healthy.resolvedDifferentAmount += 1;
      bump(amountDeltaSignatures, patternSignature(content));
    } else {
      healthy.resolvedSameAmount += 1;
    }
  }

  return {
    events: events.length,
    routed,
    unrouted,
    byVerdict,
    byStatus,
    byScope,
    healthy,
    quarantineSignatures,
    quarantineStatuses,
    amountDeltaSignatures,
    recipeFingerprints: recipeFingerprints.size,
  };
}

// -----------------------------------------------------------------------------
// 3. 4단계 사전 검토 — 환율 스냅샷 / 수리 manifest 규모
// -----------------------------------------------------------------------------

/**
 * enforce 시 외화 거래는 `(원통화, 기준일, 계약버전)` 스냅샷이 있어야 계산된다.
 * 스냅샷이 없는 기준일이 남아 있으면 그 거래는 전부 계산 실패로 검토에 빠진다.
 */
async function collectFx(tx, readOnlyRaw) {
  const [snapshots] = await readOnlyRaw(
    tx,
    sql`select count(*)::int as total,
               count(distinct base_currency)::int as currencies,
               count(distinct as_of_date)::int as dates
        from fx_rate_snapshots`,
  );

  const [foreign] = await readOnlyRaw(
    tx,
    sql`select count(*)::int as total,
               count(*) filter (where fx_rate_snapshot_id is null)::int as without_snapshot,
               count(distinct original_currency)::int as currencies
        from card_transactions
        where original_currency is not null and upper(original_currency) <> 'KRW'`,
  );

  // 스냅샷이 필요한 (통화, 기준일) 조합 — 승인시각이 없으면 수신시각으로 떨어진다.
  const needed = await readOnlyRaw(
    tx,
    sql`select upper(original_currency) as currency,
               count(distinct (coalesce(approved_at, created_at) at time zone 'Asia/Seoul')::date)::int as base_dates
        from card_transactions
        where original_currency is not null and upper(original_currency) <> 'KRW'
        group by 1`,
  );

  return {
    snapshots: {
      total: num(snapshots?.total),
      currencies: num(snapshots?.currencies),
      dates: num(snapshots?.dates),
    },
    foreignTransactions: {
      total: num(foreign?.total),
      withoutSnapshot: num(foreign?.without_snapshot),
      currencies: num(foreign?.currencies),
    },
    neededBaseDates: needed.map((row) => ({
      currency: row.currency,
      baseDates: num(row.base_dates),
    })),
  };
}

/**
 * 7단계 "기존 데이터 수리"가 손댈 규모. 배치를 돌리기 전에 몇 가구 · 몇 행인지
 * 알아야 한다. v1로 남아 있는 행 전부가 후보이고, 그중 실제로 값이 달라질 후보는
 * shadow가 이미 판정한 것들이다.
 */
async function collectRepairScale(tx, readOnlyRaw) {
  const [versions] = await readOnlyRaw(
    tx,
    sql`select count(*) filter (where money_contract_version = 1)::int as v1,
               count(*) filter (where money_contract_version >= 2)::int as v2,
               count(distinct household_id)::int as households
        from card_transactions`,
  );

  const [observed] = await readOnlyRaw(
    tx,
    sql`select count(distinct transaction_id)::int as shadow_observed
        from transaction_money_repair_log
        where applied_at is null and reason like 'shadow:%'`,
  );

  const perHousehold = await readOnlyRaw(
    tx,
    sql`select household_id::text as household_id, count(*)::int as rows
        from card_transactions
        where money_contract_version = 1
        group by 1 order by 2 desc`,
  );

  const [applied] = await readOnlyRaw(
    tx,
    sql`select count(*)::int as applied_rows
        from transaction_money_repair_log
        where applied_at is not null`,
  );

  return {
    v1Rows: num(versions?.v1),
    v2Rows: num(versions?.v2),
    households: num(versions?.households),
    shadowObservedTransactions: num(observed?.shadow_observed),
    unobservedV1Rows: num(versions?.v1) - num(observed?.shadow_observed),
    appliedRepairRows: num(applied?.applied_rows),
    perHousehold: perHousehold.map((row) => ({
      household: row.household_id.slice(0, 8),
      rows: num(row.rows),
    })),
  };
}

// -----------------------------------------------------------------------------
// 실행
// -----------------------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 필요합니다.');
  process.exit(1);
}

const { db, client } = createDbClient(databaseUrl, { max: 1 });
const readOnlyRaw = makeReadOnlyRaw(db.dialect);

try {
  const guard = await proveReadOnlyGuard(client);

  const payload = await db.transaction(async (tx) => {
    // 트랜잭션의 첫 문장이어야 한다(기준선 프로브와 동일).
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    return {
      shadow: await collectShadow(tx, readOnlyRaw),
      corpus: await collectCorpusReplay(tx, readOnlyRaw),
      fx: await collectFx(tx, readOnlyRaw),
      repair: await collectRepairScale(tx, readOnlyRaw),
    };
  });

  process.stdout.write(JSON.stringify({ guard, ...payload }));
} finally {
  await client.end({ timeout: 5 });
}
