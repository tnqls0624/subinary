/* ---------------------------------------------------------------------------
 * 할 일(Inbox) 건수 — 순수 계산 (C-8)
 *
 * "처리해야 할 것이 몇 건인가"는 지금 홈 카드가, 다음 웨이브에서는 하단 탭 배지가
 * 함께 묻는다. 두 곳이 각자 세면 화면마다 숫자가 달라지고, 한쪽만 고치면 조용히
 * 어긋난다 — 그래서 **세는 규칙만** 여기 모은다.
 *
 * 이 파일은 React·React Query를 import하지 않는다(단위 테스트가 컨텍스트·네이티브
 * 모듈을 끌고 오지 않게 하려는 의도다). 쿼리 배선은 {@link ./use-todo-counts}에 있다.
 * ------------------------------------------------------------------------- */
import type {
  CardSmsDeclineGroup,
  CardSmsEventSummary,
  TransactionSummary,
} from "@family/contracts";

/**
 * 홈이 '확인이 필요한 문자'를 노출하는 기간(3일).
 *
 * 이 창은 **홈만의 결정**이다 — 홈이 오래된 백로그로 덮이지 않게 하려는 것이지,
 * 지난 문자를 처리하지 않아도 된다는 뜻이 아니다. 그래서 `/todo`는 이 창을 쓰지
 * 않고 전 기간을 보여주고, 홈은 대신 "지난 문자 N건 더 보기"로 `/todo`에 넘긴다
 * (드리프트 D-7: 3일 뒤 화면에서 사라져 거래 한 건이 영구히 유실됐다).
 */
export const HOME_SMS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 아직 조치가 필요한 결제 실패 묶음.
 *
 * 자동 해결(후속 승인 `resolvedAt`)과 사용자 확인(`dismissedAt`) **둘 다** 빠져야
 * 할 일에서 내려간다 — `resolvedAt`만 보면 정기결제를 해지한 실패는 승인이 영구히
 * 오지 않아 영원히 미해결로 남는다.
 */
export function unresolvedDeclines(
  items: readonly CardSmsDeclineGroup[] | undefined,
): CardSmsDeclineGroup[] {
  return (items ?? []).filter(
    (d) => d.resolvedAt === null && d.dismissedAt === null,
  );
}

/**
 * 확인이 필요한 거래(확인필요 + 중복의심)를 최신순 한 목록으로 합친다.
 *
 * 이미 '중복이라 제외'(`excludedAt`)한 거래는 사용자가 처리를 끝낸 것이므로 뺀다.
 * id로 중복을 제거하는 이유: 두 상태 쿼리는 서로 다른 시점에 갱신될 수 있어,
 * 상태가 막 바뀐 거래가 한쪽 캐시에는 아직 옛 상태로 남아 두 번 세어질 수 있다.
 */
export function pendingReviewTransactions(
  ...lists: ReadonlyArray<readonly TransactionSummary[] | undefined>
): TransactionSummary[] {
  const byId = new Map<string, TransactionSummary>();
  for (const list of lists) {
    for (const t of list ?? []) {
      if (t.excludedAt != null) continue;
      byId.set(t.id, t);
    }
  }
  // 승인 시각이 없는 거래(수동 입력 직후 등)는 생성 시각으로 정렬한다.
  // 무효 시각은 0으로 눕혀 맨 뒤로 보낸다 — 비교자가 NaN을 돌려주면 정렬 결과가
  // 엔진 구현에 맡겨진다.
  const at = (t: TransactionSummary) => {
    const ms = timeOf(t.approvedAt ?? t.createdAt);
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...byId.values()].sort((a, b) => at(b) - at(a));
}

/** 읽지 못한 문자를 홈 노출 창(최근) / 그 이전(지난) 으로 가른다. */
export function partitionSmsByWindow(
  events: readonly CardSmsEventSummary[] | undefined,
  now: number,
  windowMs: number = HOME_SMS_WINDOW_MS,
): { recent: CardSmsEventSummary[]; older: CardSmsEventSummary[] } {
  const cutoff = now - windowMs;
  const recent: CardSmsEventSummary[] = [];
  const older: CardSmsEventSummary[] = [];
  for (const e of events ?? []) {
    // 시각을 못 읽는 문자는 '지난' 쪽에 둔다 — 홈에서는 빠지지만 /todo에는 남아
    // 어느 쪽으로 판정하든 항목이 사라지지 않는다(사라지는 것이 최악이다).
    const at = timeOf(e.receivedAt);
    if (Number.isFinite(at) && at >= cutoff) recent.push(e);
    else older.push(e);
  }
  return { recent, older };
}

/** 할 일 3종의 건수 묶음. 합계 배지·카드 노출 판단의 단일 원천. */
export interface TodoCountBreakdown {
  /** 미해결 결제 실패 묶음 수. */
  declines: number;
  /** 확인이 필요한 거래 수(확인필요 + 중복의심, 제외 처리분 제외). */
  reviews: number;
  /** 읽지 못한 문자 수(전 기간). */
  sms: number;
}

/** 배지에 찍히는 합계. 세 소스 중 하나라도 못 읽었으면 그 축은 0으로 센다. */
export function todoTotal(counts: TodoCountBreakdown): number {
  return counts.declines + counts.reviews + counts.sms;
}

/**
 * 처리 대기 건수 표기(로딩 `…` / 에러 `—` / `N건` 또는 `N+건`).
 *
 * 못 읽은 것을 `0건`으로 쓰지 않는다 — 없는 것과 모르는 것은 다르고, 0으로 쓰면
 * 사용자는 처리할 게 없다고 읽는다.
 */
export function pendingCountText(
  loading: boolean,
  error: boolean,
  count: number,
  plus: boolean,
): string {
  if (loading) return "…";
  if (error) return "—";
  return `${count.toLocaleString("ko-KR")}${plus ? "+" : ""}건`;
}

/** ISO 시각 → epoch ms. 값이 없거나 무효면 `NaN`(정렬에서 뒤로 밀린다). */
function timeOf(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return new Date(iso).getTime();
}
