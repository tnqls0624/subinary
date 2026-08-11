/**
 * 취소 연결 후보 승인 탐색 규칙 — **단일 정의**.
 *
 * `GET /v1/transactions/:id/cancellation-candidates`가 쓰는 WHERE/ORDER BY 조각이다.
 * 서비스에 인라인하지 않고 파일로 뺀 이유는 **이 규칙이 두 벌이 되는 것을 막는 것이
 * 이 작업의 전부**이기 때문이다. 실제 Postgres 대조 테스트
 * (`cancellation-candidates.integration.test.ts`)도 이 함수를 그대로 쓴다 — 테스트가
 * 자기 사본을 들고 있으면 "테스트는 통과하는데 화면에는 안 보이는" 상태가 된다.
 *
 * ## 배경: 왜 이 엔드포인트가 필요한가
 *
 * 웹 모달이 `GET /v1/transactions?type=approval&limit=100`으로 **최근 승인 100건**만
 * 받아 통화·잔액을 클라이언트에서 걸렀다. 서버의 `MAX_LIMIT=100` 때문에 limit을
 * 올려 우회할 수도 없어, 100건 밖의 승인은 선택지에 **아예 나타나지 않았다** —
 * 사용자가 연결할 방법이 없다는 뜻이다. 승인이 100건을 넘기기 전에는 아무도 모르는
 * 종류의 결함이다(2026-08-11 실측 승인 136건).
 *
 * ## 규칙은 저장 경로(`linkCancellation`)와 맞춘다
 *
 * 목록과 저장의 규칙이 갈리면 **"보이는데 저장하면 거부되는" 후보**가 생겨 지금보다
 * 나쁘다. 그래서 여기 있는 조건은 전부 `linkCancellation`이 저장 시점에 검증하는 것과
 * 대응한다. 아래 표에 없는 조건(status 화이트리스트 등)은 **의도적으로 넣지 않았다**.
 *
 * | 조건 | 저장 경로의 대응 검증 |
 * |---|---|
 * | 같은 household | `approval.householdId !== cancellation.householdId` → 400 |
 * | `transactionType='approval'` | `approval.transactionType !== 'approval'` → 400 |
 * | 통화 일치 | `approval.currency !== cancellation.currency` → 400 |
 * | 잔액 ≥ 취소액 | `claimed.amount > remaining` → 400 |
 * | 시간 역전 제외 | (저장 경로엔 없음 — 아래 참조) |
 */
import { and, asc, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { schema, visibilityScope } from '@family/database';

/** 후보 탐색에 필요한 취소 행의 최소 형태(테스트가 리터럴로 만들 수 있게 좁게 잡는다). */
export interface CancellationForCandidates {
  householdId: string;
  /** minor units 정수. 잔액 비교의 기준값. */
  amount: number;
  currency: string;
  /** 취소 시각. 문자에서 못 뽑으면 NULL이다 — 그때는 시간 조건을 걸지 않는다. */
  cancelledAt: Date | null;
}

/**
 * 승인이 취소보다 **앞선다**는 조건. 취소가 승인보다 먼저 일어날 수는 없다.
 *
 * `approvedAt`이 NULL인 승인(문자에서 승인시각을 못 뽑은 경우)을 그냥 비교하면 SQL
 * 3치 논리상 `NULL < x`가 항상 false여서 **말없이 후보에서 빠진다.** 그게 정확히 이
 * 작업이 없애려는 종류의 고장이라, `createdAt`(문자 수신 시각)으로 폴백한다.
 * `spendPeriodWindow`·`list()`의 기간 필터가 같은 이유로 같은 모양을 쓴다.
 * 실측(2026-08)에 `approved_at IS NULL` 승인이 존재한다.
 *
 * COALESCE를 SQL 표현식으로 만들면 드라이버가 컬럼 타입을 몰라 Date 바인딩이 깨지므로
 * 컬럼 기반 OR로 표현한다(저장소 관습).
 */
function approvedBefore(cancelledAt: Date): SQL {
  return or(
    lt(schema.cardTransactions.approvedAt, cancelledAt),
    and(
      isNull(schema.cardTransactions.approvedAt),
      lt(schema.cardTransactions.createdAt, cancelledAt),
    ),
  ) as SQL;
}

/**
 * 후보 승인 WHERE 조각.
 *
 * **status 화이트리스트를 두지 않는다.** 옛 클라이언트 필터는
 * `approved`/`partially_cancelled`만 남겼는데, 그러면 `pending_review`(신뢰도 낮게
 * 파싱된 승인)·`duplicate_suspected` 승인이 후보에서 빠져 **역시 연결 불가**가 된다.
 * 둘 다 실재하는 결제다. 그리고 `cancelled` 승인은 잔액이 0이라 아래 잔액 조건이
 * 이미 걸러 내므로, status 조건은 있어야 할 이유가 없고 없애면 도달 범위만 넓어진다.
 * 저장 경로도 status를 보지 않는다 — 규칙이 한 벌로 맞는다.
 *
 * `excludedAt`(합계 제외 확정)도 걸지 않는다. 제외된 승인의 취소도 연결돼야 순지출
 * 이력이 맞고, 저장 경로 역시 막지 않는다. 화면에서 "제외됨"으로 표시할 뿐이다.
 */
export function cancellationCandidateFilter(
  cancellation: CancellationForCandidates,
  actorMemberId: string,
): SQL {
  const conditions: SQL[] = [
    eq(schema.cardTransactions.householdId, cancellation.householdId),
    // 공개범위는 반드시 공용 헬퍼로 — 이 조건이 복붙되다 한 곳에서 누락돼 타인의
    // private 거래가 노출된 사고가 있었다(2026-08). 새로 짜지 않는다.
    visibilityScope(actorMemberId),
    eq(schema.cardTransactions.transactionType, 'approval'),
    // amount는 minor units라 통화가 다르면 뺄셈·비교 자체가 무의미하다(USD 취소를
    // KRW 승인에 연결하는 등). 저장 경로도 같은 이유로 400을 낸다.
    eq(schema.cardTransactions.currency, cancellation.currency),
    // 잔액(승인액 - 기누적 취소액) ≥ 취소액. **부분 취소된 승인도 잔액이 남아 있으면
    // 여전히 후보다** — 여기서 "이미 연결된 승인 제외"로 단순화하면 부분 취소가
    // 두 번째 취소를 붙일 곳을 잃는다.
    sql`${schema.cardTransactions.amount} - ${schema.cardTransactions.cancelledAmount} >= ${cancellation.amount}`,
  ];

  if (cancellation.cancelledAt) {
    conditions.push(approvedBefore(cancellation.cancelledAt));
  }

  return and(...conditions) as SQL;
}

/**
 * 후보 정렬 — **정확히 같은 금액이 먼저, 그다음 최신순**.
 *
 * 전체 취소(가장 흔한 경우)는 취소액이 승인 잔액과 정확히 같다. 그 후보를 맨 위로
 * 올리면 사용자가 목록을 훑지 않아도 첫 항목이 답인 경우가 대부분이다. 나머지는
 * 최신순 — 오래된 결제의 취소일수록 아래로 가지만, **잘려서 사라지지는 않는다**
 * (LIMIT이 없다. 그게 이 작업의 핵심이다).
 *
 * PostgreSQL은 `ORDER BY <boolean> DESC`에서 true를 먼저 놓는다.
 * `coalesce(approvedAt, createdAt)`는 두 컬럼만 쓰므로 Date 바인딩 문제가 없다.
 */
export function cancellationCandidateOrder(
  cancellation: CancellationForCandidates,
): SQL[] {
  return [
    desc(
      sql`(${schema.cardTransactions.amount} - ${schema.cardTransactions.cancelledAmount}) = ${cancellation.amount}`,
    ) as SQL,
    desc(
      sql`coalesce(${schema.cardTransactions.approvedAt}, ${schema.cardTransactions.createdAt})`,
    ) as SQL,
    // 동일 시각 묶음의 순서를 고정한다(정렬이 흔들리면 화면이 매번 다르게 보인다).
    asc(schema.cardTransactions.id) as SQL,
  ];
}

/**
 * 저장 경로가 쓰는 공개범위 판정 — {@link cancellationCandidateFilter}의
 * `visibilityScope()`와 **같은 규칙을 한 행에 대해** 적용한다.
 *
 * 왜 여기에 두나: 목록은 SQL로, 저장은 TS로 거르므로 표현이 다를 수밖에 없다.
 * 두 표현을 각자 두면 "후보엔 없는데 저장은 되는" 비대칭이 생긴다 — 실제로
 * 그 상태였고, 타인의 `private` 승인에 UUID만 알면 연결(쓰기)이 됐다.
 * 같은 파일에 나란히 두어 한쪽만 고치는 일을 어렵게 만든다.
 *
 * 역할 예외는 없다. `visibilityScope()`가 owner/admin을 봐주지 않으므로
 * 여기서만 열면 "볼 수 없는 거래를 고칠 수 있다"가 된다.
 */
export function actorCanSeeApproval(
  approval: { memberId: string; visibility: string },
  actorMemberId: string,
): boolean {
  if (approval.memberId === actorMemberId) return true;
  return approval.visibility !== 'private';
}
