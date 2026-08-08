#!/usr/bin/env node

/**
 * 카드 문자 멱등 키 관측 보고 (P0-9 요구사항 4).
 *
 * ## 이 스크립트가 답하는 질문 하나
 *
 * **"`eventId`를 언제 필수화해도 되는가?"**
 *
 * 지금 계약은 멱등 키를 선택값으로 두고 있고, 그건 임시 상태다. 없으면 서버가 창으로
 * 추측해야 하고 추측은 반드시 한쪽으로 틀린다. 그렇다고 지금 필수로 바꾸면 이미 배포된
 * MacroDroid·단축어 설정이 전부 끊긴다 — 카드 문자는 이 서비스의 유일한 데이터 유입
 * 경로라 그건 이 버그보다 나쁘다.
 *
 * 그래서 필수화는 **관측으로만** 결정할 수 있다: 최근 유입에서 키 없는 수집이 사라졌고,
 * 창 추측이 실제로 무언가를 버리고 있지 않다면 그때 바꾼다. 이 스크립트가 그 수치를 뽑는다.
 *
 * ## 읽는 법
 *
 * - `client` 비율이 100%에 가까워지고 **`derived_window`가 0에 수렴**하면 필수화 후보다.
 * - 전체 비율이 아니라 **장치별 표**가 판단 근거다. 전체가 99%여도 남은 1%가 어느
 *   사용자의 유일한 수집 경로면 필수화는 그 사용자의 수집을 끊는다.
 * - `fingerprint_window` 억제가 계속 잡히면 창이 넓거나(오판) 특정 장치가 재시도 루프에
 *   빠진 것이다. 원문은 `card_sms_ingest_suppressions`에 남아 있으므로 되살릴 수 있다.
 *
 * ## 실행
 *
 *   DATABASE_URL=postgres://... node scripts/report-card-sms-idempotency.mjs [--days 30]
 *
 * 읽기 전용이다(SELECT만). 원문·가맹점은 출력하지 않는다 — 집계 수치만 찍는다.
 */
import { argv, env, exit } from 'node:process';

import { createDbClient } from '../packages/database/dist/index.mjs';

const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 필요합니다.');
  exit(1);
}

const daysArgumentIndex = argv.indexOf('--days');
const days =
  daysArgumentIndex >= 0 ? Number.parseInt(argv[daysArgumentIndex + 1] ?? '', 10) : 30;
if (!Number.isInteger(days) || days <= 0) {
  console.error('--days 는 양의 정수여야 합니다.');
  exit(1);
}

// Drizzle이 아니라 원본 postgres.js 태그를 쓴다 — 순수 집계 조회라 스키마 매퍼가
// 필요 없고, 값은 태그가 파라미터로 바인딩한다(문자열 보간 없음).
const { client } = createDbClient(databaseUrl);

/** @param {number} value @param {number} total */
function percent(value, total) {
  if (!total) return '  0.0%';
  return `${((value / total) * 100).toFixed(1).padStart(5)}%`;
}

try {
  // key_source가 NULL인 행은 0050 적용 이전이라 판별 불가다. 비율 계산에서 빼야
  // "키 없는 수집이 줄고 있다"를 마이그레이션 이전 행이 희석하지 않는다.
  const [totals] = await client`
    SELECT
      count(*) FILTER (WHERE key_source IS NULL)                 AS unknown_legacy,
      count(*) FILTER (WHERE key_source = 'client')              AS keyed,
      count(*) FILTER (WHERE key_source = 'derived_received_at') AS derived_time,
      count(*) FILTER (WHERE key_source = 'derived_window')      AS derived_window
    FROM card_sms_events
    WHERE received_at > now() - make_interval(days => ${days})
  `;

  const keyed = Number(totals.keyed);
  const derivedTime = Number(totals.derived_time);
  const derivedWindow = Number(totals.derived_window);
  const classified = keyed + derivedTime + derivedWindow;

  console.log(`\n=== 카드 문자 멱등 키 출처 (최근 ${days}일) ===`);
  console.log(`  판별 대상           ${String(classified).padStart(8)}`);
  console.log(
    `  client              ${String(keyed).padStart(8)}  ${percent(keyed, classified)}  ← 목표: 100%`,
  );
  console.log(
    `  derived_received_at ${String(derivedTime).padStart(8)}  ${percent(derivedTime, classified)}`,
  );
  console.log(
    `  derived_window      ${String(derivedWindow).padStart(8)}  ${percent(derivedWindow, classified)}  ← 0이 되어야 필수화 가능`,
  );
  console.log(
    `  (0050 이전 행)      ${String(Number(totals.unknown_legacy)).padStart(8)}  판별 불가`,
  );

  const suppressions = await client`
    SELECT reason, key_source,
           count(*) AS row_count, coalesce(sum(attempts), 0) AS attempt_count,
           count(DISTINCT device_id) AS device_count
    FROM card_sms_ingest_suppressions
    WHERE last_seen_at > now() - make_interval(days => ${days})
    GROUP BY 1, 2 ORDER BY attempt_count DESC
  `;

  console.log(`\n=== 중복 판정으로 보관된 시도 (최근 ${days}일) ===`);
  if (suppressions.length === 0) {
    console.log('  없음');
  } else {
    console.log('  사유                 키 출처               행수    시도    장치');
    for (const row of suppressions) {
      console.log(
        `  ${String(row.reason).padEnd(20)} ${String(row.key_source).padEnd(20)}` +
          `${String(row.row_count).padStart(5)}${String(row.attempt_count).padStart(8)}` +
          `${String(row.device_count).padStart(8)}`,
      );
    }
    console.log(
      '\n  ⚠️ fingerprint_window 는 창 추측으로 버린 건이다 — 그중 일부는 별개 결제일 수',
    );
    console.log(
      '     있다. 원문이 card_sms_ingest_suppressions 에 남아 있으므로 되살릴 수 있다.',
    );
  }

  // 필수화는 전체 비율이 아니라 **끊길 장치가 있느냐**로 결정된다.
  const devices = await client`
    SELECT device_id,
           count(*) FILTER (WHERE key_source = 'client')      AS keyed,
           count(*) FILTER (WHERE key_source LIKE 'derived%') AS derived,
           max(received_at)                                   AS last_event_at
    FROM card_sms_events
    WHERE received_at > now() - make_interval(days => ${days})
      AND key_source IS NOT NULL
    GROUP BY 1
    HAVING count(*) FILTER (WHERE key_source LIKE 'derived%') > 0
    ORDER BY derived DESC
    LIMIT 20
  `;

  console.log(`\n=== 아직 키를 안 보내는 장치 (최근 ${days}일, 상위 20) ===`);
  if (devices.length === 0) {
    console.log('  없음 — 필수화 후보 조건 충족');
  } else {
    for (const row of devices) {
      console.log(
        `  ${row.device_id}  키있음 ${String(row.keyed).padStart(5)}  ` +
          `키없음 ${String(row.derived).padStart(5)}  최종 ${new Date(row.last_event_at).toISOString()}`,
      );
    }
    console.log(
      '\n  이 장치들이 0이 되기 전에 eventId를 필수화하면 위 장치의 수집이 즉시 끊긴다.',
    );
  }
  console.log('');
} finally {
  await client.end({ timeout: 5 });
}
