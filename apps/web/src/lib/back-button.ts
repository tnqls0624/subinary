/* ---------------------------------------------------------------------------
 * Android 하드웨어 뒤로가기 판정 (P2)
 *
 * 증상: 탭 루트(홈·거래·예산·할 일·AI)에서 뒤로가기를 눌러도 앱이 닫히지 않았다.
 * 원인은 판정식이 `window.history.length > 1`이었던 것이다 — 탭을 한 번이라도
 * 옮기면 세션 기록이 쌓여 루트에서도 항상 참이 되고, `history.back()`이 사용자를
 * 아까 보던 탭으로 되돌린다. Android에서 뒤로가기는 "앱에서 나가는" 제스처인데
 * 앱은 영원히 탭 사이를 왕복한다.
 *
 * 그래서 판정을 **지금 어느 화면인가**로 바꾼다.
 *  - 탭 루트   → 앱 종료. 오조작 방지로 한 번 더 눌러야 닫는다(Android 관용).
 *  - 하위 화면 → 앱 안에서 온 길이 있으면 브라우저 뒤로가기(기존 동작 유지).
 *  - 하위 화면인데 온 길이 없으면(푸시 알림·초대 링크로 방금 연 화면) `history.back()`
 *    은 앱 밖으로 나가거나 아무 일도 안 한다 → 홈으로 보낸다. `PageBackHeader`가
 *    같은 상황에서 `backHref`로 미는 것과 같은 규칙이다(lib/nav-history.ts).
 *
 * 순수 함수로 뺀 이유: 실기기 없이 검증할 수 있는 부분을 최대한 넓히기 위해서다.
 * 배선(리스너 등록·`App.exitApp()`)만 `native.ts`/`native-bootstrap.tsx`에 남는다.
 * ------------------------------------------------------------------------- */

/** 뒤로가기에 대한 앱의 반응. */
export type BackAction =
  /** 브라우저 뒤로가기(앱 안 이전 화면). */
  | "back"
  /** 돌아갈 앱 화면이 없는 하위 화면 → 홈. */
  | "home"
  /** 탭 루트 1회차 — "한 번 더 누르면 닫혀요" 안내. */
  | "confirm-exit"
  /** 탭 루트 2회차(안내 유효 시간 안) — 앱 종료. */
  | "exit";

/** 종료 확인이 유효한 시간(ms). 이 시간이 지나면 다시 1회차로 돌아간다. */
export const EXIT_CONFIRM_WINDOW_MS = 2_000;

export interface BackDecisionInput {
  /** 지금 화면이 하단 탭의 루트인가(lib/nav-tabs.ts의 `isTabRoot`). */
  atTabRoot: boolean;
  /** 앱 안에서 이동해 온 기록이 있는가(lib/nav-history.ts의 `canGoBackInApp`). */
  canGoBackInApp: boolean;
  /** 마지막 종료 안내 시각(ms). 없으면 null. */
  lastExitPromptAt: number | null;
  /** 지금 시각(ms). */
  now: number;
  /** 종료 확인 유효 시간(ms). 기본 {@link EXIT_CONFIRM_WINDOW_MS}. */
  windowMs?: number;
}

/** 뒤로가기 1회에 대한 결정. */
export function decideBackAction({
  atTabRoot,
  canGoBackInApp,
  lastExitPromptAt,
  now,
  windowMs = EXIT_CONFIRM_WINDOW_MS,
}: BackDecisionInput): BackAction {
  if (!atTabRoot) return canGoBackInApp ? "back" : "home";

  // 안내가 아직 유효하면 두 번째 누름 → 종료. 시각이 미래로 보이는 이상값(시계 조정)은
  // 유효하지 않은 것으로 본다 — 실수로 앱이 닫히는 쪽보다 한 번 더 묻는 쪽이 낫다.
  if (lastExitPromptAt != null) {
    const elapsed = now - lastExitPromptAt;
    if (elapsed >= 0 && elapsed <= windowMs) return "exit";
  }
  return "confirm-exit";
}
