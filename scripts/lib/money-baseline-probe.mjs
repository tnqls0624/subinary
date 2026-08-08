// =============================================================================
// money-baseline-probe.mjs — ADR-0027 전환 기준선 수집 프로브 (운영 DB 읽기 전용)
// -----------------------------------------------------------------------------
// ⚠️ 이 파일은 호스트에서 직접 실행되지 않는다. `snapshot-money-baseline.mjs`가
//    소스를 읽어 운영 api 컨테이너의 `node --input-type=module -`에 stdin으로
//    흘려 넣는다. 아래 import가 컨테이너 절대 경로인 이유가 그것이다.
//
//    왜 이렇게 하는가: 운영 postgres는 호스트에 포트를 노출하지 않고(5432/tcp: null)
//    `docker cp`는 운영 컨테이너 파일시스템에 쓰는 행위다. api 컨테이너에는 이미
//    `/app/packages/database/dist`가 들어 있으므로, 파일을 남기지 않고 stdin으로
//    주입하면 **ADR-0026의 집계 헬퍼를 실제 코드 그대로** 재사용할 수 있다.
//    psql로 SQL을 손으로 옮겨 적으면 그 순간 정의가 갈라진다 — 그것이 ADR-0026이
//    막으려던 바로 그 문제다.
//
// 이 프로브가 지키는 계약:
//
//  1. 읽기 전용을 **DB가 강제한다**. 모든 조회는
//     `set transaction isolation level repeatable read, read only` 트랜잭션 안에서만
//     돈다. 쓰기가 섞이면 PostgreSQL이 SQLSTATE 25006으로 거부한다(실증됨).
//     repeatable read를 함께 거는 이유는 재현성이다 — 수집 도중 워커가 새 거래를
//     승격시켜도 한 스냅샷 안의 숫자들이 서로 어긋나지 않아야 한다.
//  2. 애플리케이션 레벨 2차 가드. 실행 직전 SQL 텍스트가 SELECT/WITH로 시작하지
//     않으면 throw한다. 기존 `verification-database-guard.mjs`는 "쓰기 검증이 운영에
//     붙는 것"을 막는 반대 방향 가드라 여기서는 쓸 수 없다(allowWrite=1 강제 +
//     DB 이름 패턴 때문에 `family_memory`는 무조건 throw된다).
//  3. 지출 합계는 `@family/database`의 `spendPeriodWindow`/`notTransferCategory`를
//     **호출**해서 구한다. 같은 값을 analytics `months()`의 to_char 그룹핑으로도
//     따로 구해 교차검증한다. 두 값이 다르면 그 자체가 발견이다.
//  4. PII를 내보내지 않는다. 원문(raw_content)·가맹점명은 출력에 담지 않고 건수와
//     식별자만 남긴다(`scripts/ops/training-readiness.sql`의 규칙).
//
// 출력: stdout에 JSON 한 덩어리. 진단 메시지는 전부 stderr.
// =============================================================================

/** 컨테이너 절대 경로. 호스트의 pnpm 해석 경로와 다르다. */
const DATABASE_DIST = '/app/packages/database/dist/index.mjs';

/**
 * drizzle-orm은 pnpm 격리 때문에 bare specifier로 해석되지 않는다(/app에서
 * ERR_MODULE_NOT_FOUND). 이미지 레이아웃이 바뀌어도 견디도록 후보를 순회한다.
 */
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

const { createDbClient, schema, notTransferCategory, spendPeriodWindow } =
  await import(DATABASE_DIST);
const { and, eq, isNull, sql } = await importDrizzle();

// -----------------------------------------------------------------------------
// 읽기 전용 가드 (2차 방어선)
// -----------------------------------------------------------------------------

/** 선행 주석·공백을 걷어낸 뒤 첫 키워드를 본다. */
function assertSelectOnly(text) {
  const stripped = String(text).replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/u, '');
  if (!/^(?:select|with)\b/iu.test(stripped)) {
    throw new Error(`읽기 전용 프로브가 비-SELECT SQL을 거부했습니다: ${stripped.slice(0, 80)}`);
  }
}

/** drizzle 쿼리 빌더 전용 — `toSQL()`이 실제로 전송될 문장이다. */
async function readOnly(query) {
  assertSelectOnly(query.toSQL().sql);
  return await query;
}

/**
 * raw `sql` 조각 전용.
 * `tx.execute()`는 즉시 실행되는 Promise라 `toSQL()`이 없다. 그래서 dialect로 먼저
 * 렌더링해 **실제로 전송될 문장**을 검사한 뒤에만 실행한다.
 */
function makeReadOnlyRaw(dialect) {
  return async function readOnlyRaw(tx, fragment) {
    assertSelectOnly(dialect.sqlToQuery(fragment).sql);
    return await tx.execute(fragment);
  };
}

// -----------------------------------------------------------------------------
// 시간 축 — Asia/Seoul은 서머타임이 없는 UTC+9 고정이라 오프셋 산술이 안전하다.
// -----------------------------------------------------------------------------

const SEOUL_OFFSET_HOURS = 9;

/** 'YYYY-MM' 버킷의 서울 기준 [from, to) 를 UTC 인스턴트로 만든다. */
function seoulMonthRange(bucket) {
  const [year, month] = bucket.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1, -SEOUL_OFFSET_HOURS));
  const to = new Date(Date.UTC(year, month, 1, -SEOUL_OFFSET_HOURS));
  return { from, to };
}

const num = (value) => (value === null || value === undefined ? 0 : Number(value));

// -----------------------------------------------------------------------------
// 수집
// -----------------------------------------------------------------------------

/** ADR-0026 공식 모집단 6조건 중 기간을 뺀 코어. status 조건은 의도적으로 없다. */
function officialSpendCore(householdId) {
  return [
    eq(schema.cardTransactions.householdId, householdId),
    eq(schema.cardTransactions.transactionType, 'approval'),
    isNull(schema.cardTransactions.excludedAt),
    notTransferCategory(),
    eq(schema.cardTransactions.currency, 'KRW'),
  ];
}

async function collectOverview(tx) {
  const rows = await readOnlyRaw(
    tx,
    sql`select
      (select count(*) from households)::int as households,
      (select count(*) from household_members)::int as members,
      (select count(*) from card_transactions)::int as transactions,
      (select count(*) from card_sms_events)::int as events,
      (select count(distinct currency) from card_transactions)::int as currencies`,
  );
  const row = rows[0] ?? {};
  return {
    households: num(row.households),
    members: num(row.members),
    cardTransactions: num(row.transactions),
    cardSmsEvents: num(row.events),
    distinctCurrencies: num(row.currencies),
  };
}

/**
 * 항목 1 — 가구·월별 공식 지출.
 * 월 버킷은 데이터에서 뽑고, 합계는 `spendPeriodWindow` 헬퍼를 월마다 호출해 구한다.
 */
async function collectMonthlySpend(tx) {
  const households = await readOnlyRaw(
    tx,
    sql`select id::text as id from households order by created_at, id`,
  );
  const buckets = await readOnlyRaw(
    tx,
    sql`select distinct to_char(
          coalesce(approved_at, created_at) at time zone 'Asia/Seoul', 'YYYY-MM'
        ) as bucket
        from card_transactions
        where transaction_type = 'approval'
        order by 1`,
  );

  const rows = [];
  for (const household of households) {
    for (const { bucket } of buckets) {
      const { from, to } = seoulMonthRange(bucket);
      // 반드시 `tx` 빌더여야 한다 — `db`로 만들면 트랜잭션 밖 커넥션으로 나가
      // read only 가드와 repeatable read 스냅샷을 둘 다 벗어난다(max:1이라 교착도 난다).
      const query = tx
        .select({
          count: sql`count(*)::int`,
          netAmount: sql`coalesce(sum(${schema.cardTransactions.netAmount}), 0)::bigint`,
          approvedAmount: sql`coalesce(sum(${schema.cardTransactions.amount}), 0)::bigint`,
          cancelledAmount: sql`coalesce(sum(${schema.cardTransactions.cancelledAmount}), 0)::bigint`,
        })
        .from(schema.cardTransactions)
        .where(and(...officialSpendCore(household.id), spendPeriodWindow(from, to)));

      const [result] = await readOnly(query);
      if (num(result?.count) === 0) continue;
      rows.push({
        householdId: household.id,
        month: bucket,
        count: num(result.count),
        netAmount: num(result.netAmount),
        approvedAmount: num(result.approvedAmount),
        cancelledAmount: num(result.cancelledAmount),
      });
    }
  }
  return rows;
}

/**
 * 항목 1b — 교차검증. analytics `months()`가 쓰는 to_char 그룹핑으로 같은 값을 구한다.
 * `spendPeriodWindow`의 "approvedAt 우선, NULL이면 createdAt 구제"와 등가여야 한다.
 */
async function collectMonthlySpendCrosscheck(tx) {
  const rows = await readOnlyRaw(
    tx,
    sql`select
          t.household_id::text as household_id,
          to_char(coalesce(t.approved_at, t.created_at) at time zone 'Asia/Seoul', 'YYYY-MM') as month,
          count(*)::int as count,
          coalesce(sum(t.net_amount), 0)::bigint as net_amount
        from card_transactions t
        where t.transaction_type = 'approval'
          and t.excluded_at is null
          and t.currency = 'KRW'
          and not exists (
            select 1 from expense_categories ec
            where ec.id = t.category_id and ec.is_transfer
          )
        group by 1, 2
        order by 1, 2`,
  );
  return rows.map((row) => ({
    householdId: row.household_id,
    month: row.month,
    count: num(row.count),
    netAmount: num(row.net_amount),
  }));
}

/**
 * 항목 1d — 공식 합계의 분해.
 *
 * 왜 필요한가: ADR-0026 기준값과 지금 값이 다를 때 "얼마나 다른가"만으로는 아무것도
 * 판정할 수 없다. 공식 합계는 `전체 승인 − 제외분 − 자산이동분`이므로 세 축을 함께
 * 남겨 두면 다음 대조 때 delta를 요인별로 귀속시킬 수 있다. 제외 시각 분포까지 남기는
 * 이유는 "언제 제외됐는가"가 그 delta가 전환 탓인지 사용자 행위 탓인지를 가르기 때문이다.
 */
async function collectSpendReconciliation(tx) {
  const rows = await readOnlyRaw(
    tx,
    sql`select
          to_char(coalesce(t.approved_at, t.created_at) at time zone 'Asia/Seoul', 'YYYY-MM') as month,
          count(*)::int as total_count,
          coalesce(sum(t.net_amount), 0)::bigint as total_net,
          count(*) filter (where t.excluded_at is not null)::int as excluded_count,
          coalesce(sum(t.net_amount) filter (where t.excluded_at is not null), 0)::bigint as excluded_net,
          count(*) filter (
            where t.excluded_at is null
              and exists (select 1 from expense_categories ec where ec.id = t.category_id and ec.is_transfer)
          )::int as transfer_count,
          coalesce(sum(t.net_amount) filter (
            where t.excluded_at is null
              and exists (select 1 from expense_categories ec where ec.id = t.category_id and ec.is_transfer)
          ), 0)::bigint as transfer_net
        from card_transactions t
        where t.transaction_type = 'approval' and t.currency = 'KRW'
        group by 1
        order by 1`,
  );

  const exclusions = await readOnlyRaw(
    tx,
    sql`select
          to_char(coalesce(approved_at, created_at) at time zone 'Asia/Seoul', 'YYYY-MM') as month,
          to_char(excluded_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') as excluded_on,
          count(*)::int as count,
          coalesce(sum(net_amount), 0)::bigint as net_amount
        from card_transactions
        where transaction_type = 'approval' and currency = 'KRW' and excluded_at is not null
        group by 1, 2
        order by 1, 2`,
  );

  return {
    byMonth: rows.map((row) => ({
      month: row.month,
      totalCount: num(row.total_count),
      totalNet: num(row.total_net),
      excludedCount: num(row.excluded_count),
      excludedNet: num(row.excluded_net),
      transferCount: num(row.transfer_count),
      transferNet: num(row.transfer_net),
    })),
    exclusionTimeline: exclusions.map((row) => ({
      month: row.month,
      excludedOn: row.excluded_on,
      count: num(row.count),
      netAmount: num(row.net_amount),
    })),
  };
}

/**
 * 항목 1c — 공개범위 분해.
 * `visibilityScope(actor)`는 actor에 따라 결과가 달라져 기준선의 주 수치로 쓸 수 없다.
 * 대신 visibility별로 쪼개 두면 전환 후 actor별 화면 값을 재구성해 대조할 수 있다.
 */
async function collectVisibilityBreakdown(tx) {
  const rows = await readOnlyRaw(
    tx,
    sql`select
          t.household_id::text as household_id,
          to_char(coalesce(t.approved_at, t.created_at) at time zone 'Asia/Seoul', 'YYYY-MM') as month,
          t.visibility::text as visibility,
          count(*)::int as count,
          coalesce(sum(t.net_amount), 0)::bigint as net_amount
        from card_transactions t
        where t.transaction_type = 'approval'
          and t.excluded_at is null
          and t.currency = 'KRW'
          and not exists (
            select 1 from expense_categories ec
            where ec.id = t.category_id and ec.is_transfer
          )
        group by 1, 2, 3
        order by 1, 2, 3`,
  );
  return rows.map((row) => ({
    householdId: row.household_id,
    month: row.month,
    visibility: row.visibility,
    count: num(row.count),
    netAmount: num(row.net_amount),
  }));
}

/**
 * 항목 2 — 외화 인벤토리.
 * D-3(수동·검토 경로의 KRW 저장 계약 우회)은 `currency <> 'KRW'`로, D-1(승격일 환율)
 * 후보는 `original_currency IS NOT NULL`로 센다.
 *
 * 승격 경로는 간접 신호로만 근사한다 — `card_transactions`에 경로/파서 티어 컬럼이
 * 없기 때문이다(파서 티어는 워커 로그에만 남는다). 이 한계는 기준선 문서에 명시한다.
 */
async function collectForeignCurrency(tx) {
  const byCurrency = await readOnlyRaw(
    tx,
    sql`select
          currency,
          transaction_type::text as transaction_type,
          count(*)::int as count,
          coalesce(sum(net_amount), 0)::bigint as net_amount
        from card_transactions
        group by 1, 2
        order by 1, 2`,
  );

  const [flags] = await readOnlyRaw(
    tx,
    sql`select
          count(*) filter (where currency <> 'KRW')::int as non_krw_stored,
          count(*) filter (where original_currency is not null)::int as has_original,
          count(*) filter (where original_currency is not null and exchange_rate is null)::int as original_without_rate,
          count(*) filter (where original_currency is not null and original_amount is null)::int as original_without_amount,
          count(*) filter (where currency <> 'KRW' and original_currency is null)::int as non_krw_without_original
        from card_transactions`,
  );

  // 간접 경로 신호. 신뢰도는 문서에 등급으로 적는다.
  const byPath = await readOnlyRaw(
    tx,
    sql`select
          case
            when e.event_id like 'manual-%' then 'manual_fields'
            when d.name = '수동 입력' then 'manual_text'
            when fb.event_id is not null then 'human_review'
            else 'worker_auto'
          end as path,
          count(*)::int as count,
          count(*) filter (where t.original_currency is not null)::int as foreign_count,
          count(*) filter (where t.currency <> 'KRW')::int as non_krw_count
        from card_transactions t
        join card_sms_events e on e.id = t.source_event_id
        left join registered_devices d on d.id = e.device_id
        left join (
          select distinct target_id as event_id
          from feedback_events
          where target_type = 'card-sms-parse' and source = 'human_confirmed'
        ) fb on fb.event_id = e.id::text
        group by 1
        order by 1`,
  );

  return {
    byCurrency: byCurrency.map((row) => ({
      currency: row.currency,
      transactionType: row.transaction_type,
      count: num(row.count),
      netAmount: num(row.net_amount),
    })),
    flags: {
      nonKrwStored: num(flags?.non_krw_stored),
      hasOriginalCurrency: num(flags?.has_original),
      originalWithoutRate: num(flags?.original_without_rate),
      originalWithoutAmount: num(flags?.original_without_amount),
      nonKrwWithoutOriginal: num(flags?.non_krw_without_original),
    },
    byPromotionPath: byPath.map((row) => ({
      path: row.path,
      count: num(row.count),
      foreignCount: num(row.foreign_count),
      nonKrwCount: num(row.non_krw_count),
    })),
  };
}

/** 항목 3 — 미연결 취소(D-2). 종류는 cancellation인데 부모가 없는 행. */
async function collectUnlinkedCancellations(tx) {
  const [totals] = await readOnlyRaw(
    tx,
    sql`select
          count(*) filter (where transaction_type = 'cancellation')::int as cancellations,
          count(*) filter (where transaction_type = 'cancellation' and parent_transaction_id is null)::int as unlinked,
          coalesce(sum(amount) filter (where transaction_type = 'cancellation' and parent_transaction_id is null), 0)::bigint as unlinked_amount
        from card_transactions`,
  );
  const byStatus = await readOnlyRaw(
    tx,
    sql`select status::text as status, count(*)::int as count
        from card_transactions
        where transaction_type = 'cancellation' and parent_transaction_id is null
        group by 1 order by 1`,
  );
  return {
    cancellations: num(totals?.cancellations),
    unlinked: num(totals?.unlinked),
    unlinkedAmount: num(totals?.unlinked_amount),
    unlinkedByStatus: byStatus.map((row) => ({ status: row.status, count: num(row.count) })),
  };
}

/**
 * 항목 4 — D-4 의심 후보. 확정이 아니라 **후보 집계**다.
 *
 * 판정 기준을 왜 이렇게 잡았는가:
 *   처음에는 "원문 어딘가에 판촉/한도/누적 토큰이 있고 첫 금액 토큰을 채택"으로 쟀더니
 *   승인 126건 중 46건이 걸렸다. 원인은 `누적`이었다 — 카드 문자 관용구라 문자 **끝**에
 *   "누적 N원"으로 붙고, 첫 토큰은 멀쩡한 승인액이다. "원문 어딘가"는 신호가 아니다.
 *   D-4의 실제 실패 모드는 **채택된 금액 자체가 판촉/한도 문맥에 들어 있는 것**이다.
 *
 *  · strong — 첫 금액 토큰의 **인접 문맥**(앞 12자~뒤 8자)에 판촉/한도 토큰이 있고
 *    그 값이 실제로 채택됐다. `base.parser.ts:30`의 AMOUNT_RE가 비-global match라
 *    첫 매치를 무조건 고르는 것과 결합하면 ADR-0027 D-4 그 자체다.
 *  · weak — 채택 지점은 깨끗하지만 원문에 금액 토큰이 2개 이상이고 판촉/한도 문맥이
 *    따로 있다. 지금은 우연히 맞았을 뿐 ADR-0027 §5가 요구하는 결정적 근거는 없다.
 *  · nonTransactionContext — 별도 축. 원문에 `출금|입금|이체|송금` 같은 비카드 이동
 *    문맥이 있는데 approval로 승격됐다. §5 규칙 1(실제 거래 액션과 결박)의 위반 후보다.
 *
 * 원문·가맹점명은 출력하지 않는다. 건수와 식별자만 남긴다.
 */
async function collectD4Suspects(tx) {
  const promoRe = '(할인|혜택|쿠폰|이벤트|결제\\s*시|이용한도|잔여한도|누적|누계|청구예정)';
  const nonCardRe = '(출금|입금|이체|송금)';
  const rows = await readOnlyRaw(
    tx,
    sql`with tokens as (
          select
            t.id::text as transaction_id,
            e.id::text as event_id,
            t.amount,
            e.raw_content as body,
            substring(e.raw_content from '[0-9][0-9,]*\\s*원') as first_token,
            (select count(*) from regexp_matches(e.raw_content, '[0-9][0-9,]*\\s*원', 'g'))::int as amount_tokens
          from card_transactions t
          join card_sms_events e on e.id = t.source_event_id
          where t.transaction_type = 'approval'
        ),
        scored as (
          select
            transaction_id,
            event_id,
            amount,
            amount_tokens,
            nullif(replace(substring(first_token from '[0-9][0-9,]*'), ',', ''), '')::bigint as first_value,
            -- 첫 금액 토큰을 감싼 좁은 창만 본다. '누적 N원'처럼 문자 끝에 붙는
            -- 관용구가 채택 지점과 무관하다는 것을 이 창이 구분해 준다.
            substring(
              body
              from greatest(1, strpos(body, first_token) - 12)
              for length(first_token) + 20
            ) as adopted_window,
            body ~ ${promoRe} as body_has_promo,
            body ~ ${nonCardRe} as body_has_non_card
          from tokens
        )
        select
          transaction_id,
          event_id,
          amount_tokens,
          (first_value = amount) as took_first_token,
          body_has_non_card as non_transaction_context,
          case
            -- 원문에 'N원' 토큰이 아예 없는데 승격됐다. 외화 표기(USD 22.00)이거나
            -- 수동 입력 합성 이벤트다. §5의 amount span을 만들 근거가 원문에 없는 축.
            when first_value is null then 'no_amount_token'
            when first_value = amount and adopted_window ~ ${promoRe} then 'strong'
            when body_has_promo and amount_tokens >= 2 then 'weak'
            else 'clear'
          end as verdict
        from scored
        order by event_id`,
  );

  const suspects = rows.filter((row) => row.verdict !== 'clear');
  return {
    approvalsScanned: rows.length,
    strong: suspects.filter((row) => row.verdict === 'strong').length,
    weak: suspects.filter((row) => row.verdict === 'weak').length,
    noAmountToken: suspects.filter((row) => row.verdict === 'no_amount_token').length,
    nonTransactionContext: rows.filter((row) => row.non_transaction_context === true).length,
    // 원문 없이 추적만 가능하도록 식별자만 남긴다.
    suspectEventIds: rows
      .filter((row) => row.verdict !== 'clear' || row.non_transaction_context === true)
      .map((row) => ({
        eventId: row.event_id,
        transactionId: row.transaction_id,
        verdict: row.verdict,
        amountTokens: num(row.amount_tokens),
        tookFirstToken: row.took_first_token === true,
        nonTransactionContext: row.non_transaction_context === true,
      })),
  };
}

/**
 * 항목 5 — 취소 연결 무결성 + ADR-0027 v2 불변식 사전 위반.
 * 여기 숫자는 전환의 목표가 0으로 만드는 것이므로 "감소 기대" 항목이다.
 */
async function collectIntegrity(tx) {
  const [row] = await readOnlyRaw(
    tx,
    sql`with child_sums as (
          select parent_transaction_id as parent_id, sum(amount)::bigint as child_total, count(*)::int as child_count
          from card_transactions
          where transaction_type = 'cancellation' and parent_transaction_id is not null
          group by 1
        )
        select
          (select count(*) from child_sums)::int as approvals_with_children,
          (select count(*)
             from card_transactions a
             left join child_sums c on c.parent_id = a.id
            where a.transaction_type = 'approval'
              and a.cancelled_amount <> coalesce(c.child_total, 0))::int as cancelled_amount_mismatch,
          (select count(*) from card_transactions
            where transaction_type = 'approval' and net_amount <> amount - cancelled_amount)::int as net_amount_violation,
          (select count(*) from card_transactions
            where transaction_type = 'cancellation' and net_amount <> 0)::int as cancellation_net_violation,
          (select count(*) from card_transactions where currency <> 'KRW')::int as non_krw_violation,
          (select count(*) from card_transactions where amount < 0 or net_amount < 0 or cancelled_amount < 0)::int as negative_amount_violation,
          (select count(*) from card_transactions a
             join card_transactions b on b.id = a.parent_transaction_id
            where a.transaction_type = 'cancellation' and a.currency <> b.currency)::int as parent_currency_mismatch`,
  );
  return {
    approvalsWithChildren: num(row?.approvals_with_children),
    cancelledAmountMismatch: num(row?.cancelled_amount_mismatch),
    netAmountViolation: num(row?.net_amount_violation),
    cancellationNetViolation: num(row?.cancellation_net_violation),
    nonKrwViolation: num(row?.non_krw_violation),
    negativeAmountViolation: num(row?.negative_amount_violation),
    parentCurrencyMismatch: num(row?.parent_currency_mismatch),
  };
}

/**
 * 읽기 전용 가드가 실제로 살아 있는지 매 실행 증명한다.
 * 아무 행도 건드리지 않는 `where false` UPDATE를 시도해 25006이 나와야 통과다.
 * 나오지 않으면 이 프로브는 운영에 붙을 자격이 없으므로 즉시 중단한다.
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
    // 트랜잭션의 첫 문장이어야 한다. repeatable read는 수집 중 승격이 끼어들어도
    // 항목 간 숫자가 어긋나지 않게 한다(재현성 검증의 전제).
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);

    // max:1 커넥션이라 순차 실행이다. 병렬로 바꾸면 같은 커넥션을 다투게 된다.
    return {
      overview: await collectOverview(tx),
      monthlySpend: await collectMonthlySpend(tx),
      monthlySpendCrosscheck: await collectMonthlySpendCrosscheck(tx),
      spendReconciliation: await collectSpendReconciliation(tx),
      visibilityBreakdown: await collectVisibilityBreakdown(tx),
      foreignCurrency: await collectForeignCurrency(tx),
      unlinkedCancellations: await collectUnlinkedCancellations(tx),
      d4Suspects: await collectD4Suspects(tx),
      integrity: await collectIntegrity(tx),
    };
  });

  process.stdout.write(JSON.stringify({ guard, ...payload }));
} finally {
  await client.end({ timeout: 5 });
}
