/**
 * 취소 연결 후보 규칙 — 실제 Postgres 대조 검증.
 *
 * ## 이 테스트가 지키는 것
 *
 * 이 결함은 **데이터가 쌓이면 조용히 발생**하는 종류다. 승인이 100건을 넘길 때까지
 * 아무도 모르고, 넘긴 뒤에는 오래된 결제의 취소를 **연결할 방법 자체가 없다**(옛 웹
 * 모달이 최근 100건만 받아 걸렀고 서버 `MAX_LIMIT=100`이 상한이라 우회도 불가).
 * 그래서 핵심 케이스는 **"승인 150건 중 가장 오래된 것이 후보에 들어오는가"**다.
 *
 * 순수 유닛으로는 증명할 수 없는 것을 여기서 본다:
 *  1. **상한 부재** — 150건을 넣고 오래된 쪽이 실제로 돌아오는가(LIMIT이 끼면 실패).
 *  2. **NULL 정렬/비교** — `approved_at IS NULL` 승인이 SQL 3치 논리로 조용히
 *     탈락하지 않는가(실측 데이터에 존재한다).
 *  3. **enum 비교** — `transaction_type = $1`이 파라미터 추론으로 실제 동작하는가.
 *  4. **부분 취소 잔액** — `amount - cancelled_amount` 산술이 DB에서 맞는가.
 *
 * 검증 대상은 **운영이 쓰는 그 함수**(`cancellationCandidateFilter`)다. 테스트가 규칙
 * 사본을 들고 있으면 "테스트는 통과하는데 화면에는 안 보이는" 상태가 되므로 절대 복사
 * 하지 않는다.
 *
 * DB가 필요하므로 `CANCELLATION_CANDIDATES_TEST_DATABASE_URL`이 있을 때만 돈다
 * (CI 기본 skip). 격리 스택 예시:
 *   docker compose -p fma-verify -f docker-compose.yml up -d postgres
 *   CANCELLATION_CANDIDATES_TEST_DATABASE_URL=postgres://family:family_dev_pw@localhost:5432/family_memory \
 *     pnpm --filter @family/api test
 *
 * ⚠️ 운영 DB를 절대 가리키지 말 것 — 자기 전용 스키마를 drop/create 한다.
 * 운영 테이블은 건드리지 않지만(전용 스키마 + `search_path`), drop 대상이 있는 DB다.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { schema } from '@family/database';

import {
  cancellationCandidateFilter,
  cancellationCandidateOrder,
  type CancellationForCandidates,
} from './cancellation-candidates';

const DATABASE_URL = process.env.CANCELLATION_CANDIDATES_TEST_DATABASE_URL;

/**
 * 전용 스키마에 `card_transactions`의 **후보 규칙이 읽는 열만** 복사한다.
 *
 * `search_path`를 이 스키마로 두면 drizzle이 내보내는 무자격 `"card_transactions"`가
 * 여기로 해석된다 — 덕분에 운영 테이블의 FK 사슬(household → member → device →
 * card_sms_events)을 세우지 않고도 **운영 규칙 그대로**를 돌릴 수 있다.
 * enum 열은 실제 enum 타입으로 만든다(text로 두면 위 3번을 검증하지 못한다).
 */
const TEST_SCHEMA = 'cancel_candidates_check';

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const OTHER_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** 취소 기준값: 2026-08-11 12:00Z에 일어난 10,000원 취소. */
const CANCELLATION: CancellationForCandidates = {
  householdId: HOUSEHOLD,
  amount: 10_000,
  currency: 'KRW',
  cancelledAt: new Date('2026-08-11T12:00:00.000Z'),
};

/** 후보 삽입용 최소 필드. */
interface Seed {
  label: string;
  householdId?: string;
  memberId?: string;
  transactionType?: 'approval' | 'cancellation';
  amount: number;
  cancelledAmount?: number;
  currency?: string;
  approvedAt?: Date | null;
  createdAt?: Date;
  visibility?: 'private' | 'household' | 'summary_only';
}

describe.skipIf(!DATABASE_URL)('취소 연결 후보 규칙 — 실제 Postgres', () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  /** label → id. 결과를 사람이 읽을 수 있는 이름으로 되돌린다. */
  const idByLabel = new Map<string, string>();
  const labelById = new Map<string, string>();

  const seeds: Seed[] = [];

  // 승인 150건 — 하루 간격으로 과거로 거슬러 올라간다. 100건 상한이 있으면
  // `old-149`(가장 오래된 것)가 후보에서 빠진다.
  for (let index = 0; index < 150; index += 1) {
    const at = new Date(CANCELLATION.cancelledAt!.getTime() - (index + 1) * 86_400_000);
    seeds.push({
      label: `old-${index}`,
      // 전액 취소 후보가 여러 건이면 정렬 검증이 흐려지므로 금액을 조금씩 벌린다.
      amount: 10_000 + index,
      approvedAt: at,
      createdAt: at,
    });
  }

  // 경계 케이스.
  seeds.push(
    // 정확히 취소액과 같은 잔액 — 전액 취소의 가장 흔한 모양(정렬 1순위여야 한다).
    { label: 'exact-match', amount: 10_000, approvedAt: new Date('2026-08-10T00:00:00Z') },
    // 부분 취소돼 잔액이 남은 승인 — 여전히 후보여야 한다(놓치기 쉬운 케이스).
    {
      label: 'partial-remaining',
      amount: 30_000,
      cancelledAmount: 15_000,
      approvedAt: new Date('2026-08-09T00:00:00Z'),
    },
    // 부분 취소로 잔액이 취소액보다 적어진 승인 — 빠져야 한다.
    {
      label: 'partial-insufficient',
      amount: 30_000,
      cancelledAmount: 25_000,
      approvedAt: new Date('2026-08-09T00:00:00Z'),
    },
    // 전액 취소된 승인(잔액 0) — status 조건 없이 잔액 조건만으로 빠져야 한다.
    {
      label: 'fully-cancelled',
      amount: 20_000,
      cancelledAmount: 20_000,
      approvedAt: new Date('2026-08-08T00:00:00Z'),
    },
    // 승인시각 미상(파서가 못 뽑음) — `created_at` 폴백으로 살아 있어야 한다.
    {
      label: 'null-approved-at',
      amount: 12_000,
      approvedAt: null,
      createdAt: new Date('2026-08-07T00:00:00Z'),
    },
    // 승인시각 미상 + 수신도 취소 이후 — 빠져야 한다(폴백이 무조건 통과가 아니다).
    {
      label: 'null-approved-at-future',
      amount: 12_000,
      approvedAt: null,
      createdAt: new Date('2026-08-20T00:00:00Z'),
    },
    // 취소보다 뒤에 승인된 것 — 취소가 승인보다 앞설 수 없으므로 빠져야 한다.
    { label: 'after-cancellation', amount: 50_000, approvedAt: new Date('2026-08-12T00:00:00Z') },
    // 통화 불일치 — minor units 비교가 무의미하므로 빠져야 한다.
    {
      label: 'usd',
      amount: 50_000,
      currency: 'USD',
      approvedAt: new Date('2026-08-05T00:00:00Z'),
    },
    // 취소 행은 후보가 아니다.
    {
      label: 'another-cancellation',
      transactionType: 'cancellation',
      amount: 10_000,
      approvedAt: new Date('2026-08-05T00:00:00Z'),
    },
    // 다른 household — 절대 새어서는 안 된다.
    {
      label: 'other-household',
      householdId: OTHER_HOUSEHOLD,
      amount: 10_000,
      approvedAt: new Date('2026-08-05T00:00:00Z'),
    },
    // 타인의 private — 공개범위에서 빠져야 한다(금액·이름 모두 노출 금지).
    {
      label: 'other-private',
      memberId: OTHER_MEMBER,
      visibility: 'private',
      amount: 11_000,
      approvedAt: new Date('2026-08-04T00:00:00Z'),
    },
    // 타인의 summary_only — 금액은 공개 대상이라 후보에 남는다(가맹점만 가려진다).
    {
      label: 'other-summary-only',
      memberId: OTHER_MEMBER,
      visibility: 'summary_only',
      amount: 13_000,
      approvedAt: new Date('2026-08-03T00:00:00Z'),
    },
    // 본인의 private — 본인 행이므로 후보다.
    {
      label: 'own-private',
      visibility: 'private',
      amount: 14_000,
      approvedAt: new Date('2026-08-02T00:00:00Z'),
    },
  );

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, {
      max: 1,
      // 무자격 테이블명이 전용 스키마로 해석되게 한다(운영 테이블 보호).
      connection: { search_path: `${TEST_SCHEMA}, public` },
      onnotice: () => {},
    });
    db = drizzle(sql);

    await sql.unsafe(`drop schema if exists ${TEST_SCHEMA} cascade`);
    await sql.unsafe(`create schema ${TEST_SCHEMA}`);
    await sql.unsafe(
      `create type ${TEST_SCHEMA}.txn_type as enum ('approval', 'cancellation')`,
    );
    await sql.unsafe(
      `create type ${TEST_SCHEMA}.card_visibility as enum ('private', 'household', 'summary_only')`,
    );
    await sql.unsafe(`
      create table ${TEST_SCHEMA}.card_transactions (
        id uuid primary key default gen_random_uuid(),
        household_id uuid not null,
        member_id uuid not null,
        transaction_type ${TEST_SCHEMA}.txn_type not null,
        amount integer not null,
        cancelled_amount integer not null default 0,
        currency text not null default 'KRW',
        approved_at timestamptz,
        created_at timestamptz not null default now(),
        visibility ${TEST_SCHEMA}.card_visibility not null default 'household'
      )
    `);

    for (const seed of seeds) {
      // 시각은 ISO 문자열로 넘긴다 — Date 객체는 파라미터 타입이 unknown으로 서술될 때
      // 드라이버가 직렬화하지 못한다(`::timestamptz` 캐스트로 타입을 못박는다).
      const createdAt = seed.createdAt ?? seed.approvedAt ?? new Date('2026-08-01T00:00:00Z');
      // INSERT는 **스키마를 명시**한다. `search_path`에 맡기면 ADR-0027 §1 아키텍처
      // 가드(`scanMoneyWriteViolations`)가 이 줄을 "금액 도메인 밖의 card_transactions
      // 쓰기"로 세어 위반 수가 늘어난다 — 그 지표는 enforce 준비도의 유일한 객관
      // 수치라 테스트 시드가 오염시켜서는 안 된다. 실제로도 이 쓰기는 운영 테이블이
      // 아니라 자기 전용 스키마로 가므로 명시하는 쪽이 사실에 맞다.
      // (SELECT는 운영 규칙 함수가 무자격 이름을 내보내므로 `search_path`를 쓴다.)
      const [row] = await sql`
        insert into ${sql.unsafe(TEST_SCHEMA)}.card_transactions
          (household_id, member_id, transaction_type, amount, cancelled_amount,
           currency, approved_at, created_at, visibility)
        values (
          ${seed.householdId ?? HOUSEHOLD}::uuid,
          ${seed.memberId ?? ACTOR}::uuid,
          ${seed.transactionType ?? 'approval'}::${sql.unsafe(TEST_SCHEMA)}.txn_type,
          ${seed.amount},
          ${seed.cancelledAmount ?? 0},
          ${seed.currency ?? 'KRW'},
          ${seed.approvedAt ? seed.approvedAt.toISOString() : null}::timestamptz,
          ${createdAt.toISOString()}::timestamptz,
          ${seed.visibility ?? 'household'}::${sql.unsafe(TEST_SCHEMA)}.card_visibility
        )
        returning id
      `;
      idByLabel.set(seed.label, row!.id as string);
      labelById.set(row!.id as string, seed.label);
    }
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`drop schema if exists ${TEST_SCHEMA} cascade`);
      await sql.end({ timeout: 5 });
    }
  });

  /** 운영 규칙 그대로 후보를 뽑아 라벨 배열로 돌려준다(정렬 순서 유지). */
  async function candidateLabels(
    cancellation: CancellationForCandidates = CANCELLATION,
    actor: string = ACTOR,
  ): Promise<string[]> {
    const rows = await db
      .select({ id: schema.cardTransactions.id })
      .from(schema.cardTransactions)
      .where(cancellationCandidateFilter(cancellation, actor))
      .orderBy(...cancellationCandidateOrder(cancellation));
    return rows.map((r) => labelById.get(r.id) ?? r.id);
  }

  it('승인 150건 중 **가장 오래된 것**도 후보에 들어온다 (상한 없음)', async () => {
    const labels = await candidateLabels();

    // 이 한 줄이 이 작업의 핵심 증거다 — 100건 상한이 끼면 여기서 실패한다.
    expect(labels).toContain('old-149');
    expect(labels).toContain('old-100');
    // 150건 전부 + 경계 통과분. 잘리지 않았음을 개수로도 고정한다.
    expect(labels.filter((l) => l.startsWith('old-'))).toHaveLength(150);
  });

  it('전액 취소(잔액이 취소액과 정확히 같은 승인)를 맨 위에 올린다', async () => {
    const labels = await candidateLabels();

    // exact-match(잔액 10,000)와 old-0(10,000)이 정확히 일치 그룹이다.
    // 그 그룹이 앞쪽을 차지하고, 그 안에서는 최신순이어야 한다.
    const exactGroup = ['exact-match', 'old-0'];
    expect(exactGroup).toContain(labels[0]);
    expect(exactGroup).toContain(labels[1]);
    // old-0(8/10 12:00)이 exact-match(8/10 00:00)보다 최신이므로 먼저 온다.
    expect(labels.slice(0, 2)).toEqual(['old-0', 'exact-match']);
  });

  it('부분 취소된 승인은 잔액이 남아 있으면 여전히 후보다', async () => {
    const labels = await candidateLabels();

    // 30,000 - 15,000 = 15,000 ≥ 10,000 → 후보.
    expect(labels).toContain('partial-remaining');
    // 30,000 - 25,000 = 5,000 < 10,000 → 제외.
    expect(labels).not.toContain('partial-insufficient');
    // 잔액 0 → 제외(status 조건 없이 잔액만으로 걸러진다).
    expect(labels).not.toContain('fully-cancelled');
  });

  it('승인시각이 NULL이어도 수신시각으로 판정해 조용히 탈락시키지 않는다', async () => {
    const labels = await candidateLabels();

    expect(labels).toContain('null-approved-at');
    // 다만 폴백이 무조건 통과는 아니다 — 수신도 취소 이후면 제외한다.
    expect(labels).not.toContain('null-approved-at-future');
  });

  it('통화 불일치·시간 역전·취소 행은 후보에서 빠진다', async () => {
    const labels = await candidateLabels();

    expect(labels).not.toContain('usd');
    expect(labels).not.toContain('after-cancellation');
    expect(labels).not.toContain('another-cancellation');
  });

  it('다른 household와 타인의 private은 절대 새지 않는다', async () => {
    const labels = await candidateLabels();

    expect(labels).not.toContain('other-household');
    expect(labels).not.toContain('other-private');
    // 타인 summary_only는 금액이 공개 대상이라 후보로 남는다(가맹점만 가려진다).
    expect(labels).toContain('other-summary-only');
    // 본인 private은 본인 행이므로 후보다.
    expect(labels).toContain('own-private');
  });

  it('취소 시각을 모르면 시간 조건을 걸지 않는다 (전부 후보로 둔다)', async () => {
    const labels = await candidateLabels({ ...CANCELLATION, cancelledAt: null });

    // 취소보다 "뒤"라고 판단할 근거가 없으므로 잘라 내지 않는다 — 사람이 고른다.
    expect(labels).toContain('after-cancellation');
    expect(labels).toContain('null-approved-at-future');
    // 통화·잔액 조건은 그대로 적용된다.
    expect(labels).not.toContain('usd');
    expect(labels).not.toContain('fully-cancelled');
  });

  it('타인이 아닌 다른 구성원 시점에서는 자기 기준으로 공개범위가 다시 계산된다', async () => {
    const labels = await candidateLabels(CANCELLATION, OTHER_MEMBER);

    // OTHER_MEMBER 관점: 자기 private은 보이고, ACTOR의 private은 보이지 않는다.
    expect(labels).toContain('other-private');
    expect(labels).not.toContain('own-private');
  });
});
