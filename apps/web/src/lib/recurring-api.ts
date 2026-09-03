/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 정기 지출 Radar API (C-5)
 *
 * **2026-09-03에 `lib/`로 올렸다.** 원래는 `/more/recurring` 옆에 있었다 — 그 화면
 * 하나만 쓰는 동안은 공유 지점(`queries.ts`)의 충돌 비용을 피하는 편이 나았다. 금액
 * 레이어 S2에서 홈도 `/upcoming`을 쓰게 되면서 그 이유가 사라졌고, 화면 옆에 두면
 * 홈이 `../more/recurring/`을 거슬러 올라가 import하는 모양이 된다.
 *
 * `queries.ts`에 합치지는 않는다 — 그 파일은 여전히 여러 작업이 동시에 만지는 지점이고,
 * 이 모듈은 정기 지출 전용이라 독립 파일이 경계로서 더 정확하다. 공용
 * `apiFetch`(인증·에러 변환·네이티브 헤더)는 그대로 통과시켜 요청 규약이 갈라지지
 * 않게 한다 — 여기서 fetch를 새로 짜면 401 재시도·토큰 헤더가 두 벌이 된다.
 * ------------------------------------------------------------------------- */
import type {
  RecurringDecisionResponse,
  RecurringRecomputeResponse,
  RecurringSeriesListResponse,
  RecurringUpcomingResponse,
} from "@family/contracts";

import { apiFetch } from "@/lib/api-client";

export const recurringQueryKey = (householdId: string | null) =>
  ["recurring-series", householdId] as const;

export function fetchRecurringSeries(
  accessToken: string | null,
  householdId: string,
): Promise<RecurringSeriesListResponse> {
  return apiFetch<RecurringSeriesListResponse>(
    `/v1/recurring/series?householdId=${encodeURIComponent(householdId)}`,
    { accessToken },
  );
}

/** "정기 결제 맞음 / 아님". 이 확정은 재계산이 지우지 않는다(근거 교집합으로 이어진다). */
export function decideRecurringSeries(
  accessToken: string | null,
  seriesId: string,
  decision: "confirmed" | "rejected",
): Promise<RecurringDecisionResponse> {
  return apiFetch<RecurringDecisionResponse>(
    `/v1/recurring/series/${seriesId}/decision`,
    { method: "POST", accessToken, body: { decision } },
  );
}

/** 후보 재계산. 별칭을 정리한 뒤 한 번 돌리면 후보가 현재 가맹점 신원과 맞는다. */
export function recomputeRecurringSeries(
  accessToken: string | null,
  householdId: string,
): Promise<RecurringRecomputeResponse> {
  return apiFetch<RecurringRecomputeResponse>(`/v1/recurring/recompute`, {
    method: "POST",
    accessToken,
    body: { householdId },
  });
}

export const recurringUpcomingQueryKey = (
  householdId: string | null,
  until: string,
) => ["recurring-upcoming", householdId, until] as const;

/**
 * 예정 정기 지출 + 합계 (금액 레이어 S1).
 *
 * `until`을 호출부가 정하는 이유: 목록은 "이번 달 남은 것", 홈은 "앞으로 나갈 돈"으로
 * 창이 다르다. 서버가 기본값을 정하면 두 화면이 같은 합계를 말하는지 알 수 없다.
 * 그래서 창은 화면이 정하고 서버는 받은 값을 그대로 되돌려준다.
 */
export function fetchRecurringUpcoming(
  accessToken: string | null,
  householdId: string,
  until: string,
): Promise<RecurringUpcomingResponse> {
  const params = new URLSearchParams({ householdId, until });
  return apiFetch<RecurringUpcomingResponse>(
    `/v1/recurring/upcoming?${params.toString()}`,
    { accessToken },
  );
}

/** 이번 달 마지막 순간(KST). 목록 상단 "이번 달 남은 정기"의 창. */
export function endOfMonthKst(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  // 다음 달 1일 00:00 KST에서 1ms 뺀다 = 이번 달 마지막 순간.
  const nextMonth = Date.UTC(year, month + 1, 1) - 9 * 60 * 60 * 1000;
  return new Date(nextMonth - 1).toISOString();
}
