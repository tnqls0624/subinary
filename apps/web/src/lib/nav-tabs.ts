/* ---------------------------------------------------------------------------
 * 하단 탭 · 헤더 아바타 활성 판정 (IA 개편)
 *
 * 왜 순수 모듈로 뺐나: 활성 판정이 `layout.tsx` 안의 인라인 배열이라 테스트가 없었고,
 * 경로가 하나 늘 때마다 조용히 깨졌다(`/todo`·`/declines`·`/more/*`가 그랬다).
 * 판정 규칙만 여기 모으고 화면은 결과만 쓴다.
 *
 * 경로 끝 슬래시를 정규화한다 — 모바일(Capacitor) 빌드는 `trailingSlash: true`라
 * 같은 화면이 `/todo`와 `/todo/` 두 모양으로 온다(next.config.ts:34).
 * ------------------------------------------------------------------------- */

/** 하단 탭 5칸 + 헤더 아바타(account). 어디에도 속하지 않으면 `null`. */
export type TabKey =
  | "home"
  | "transactions"
  | "ai"
  | "budgets"
  | "todo"
  | "account";

/**
 * '할 일' 탭이 활성으로 취급하는 경로.
 *
 * `/declines`를 포함하는 이유: 실패한 결제는 `/todo`의 한 섹션이고, 거기서 탭해
 * 들어가는 **처리 화면**이다. `/more`에도 링크가 있지만(기록 열람) 사용자가 지금
 * 무엇을 하고 있는지는 "할 일을 처리하는 중"이 맞다.
 */
export const TODO_PATHS: ReadonlyArray<string> = ["/todo", "/declines"];

/**
 * 헤더 아바타(내 계정)가 활성으로 취급하는 관리 경로.
 *
 * 이 목록은 예전 '더보기' 탭의 `MORE_PATHS`를 그대로 물려받았다 — 탭이 헤더로
 * 올라갔을 뿐 "여기는 관리 화면"이라는 표시는 사라지면 안 된다.
 */
export const ACCOUNT_PATHS: ReadonlyArray<string> = [
  "/more",
  "/household",
  "/cards",
  "/devices",
  "/categories",
  "/ai-operations",
];

/** 끝 슬래시를 뗀 경로(루트는 `/` 유지). */
export function normalizePath(pathname: string): string {
  if (!pathname) return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** `pathname`이 `base` 자신이거나 그 하위 경로인가. */
export function isUnder(pathname: string, base: string): boolean {
  const path = normalizePath(pathname);
  const root = normalizePath(base);
  return path === root || path.startsWith(`${root}/`);
}

/**
 * 지금 화면이 어느 탭에 속하는가.
 *
 * 순서가 규칙이다 — `/declines`처럼 두 곳에서 링크되는 화면은 **먼저 일치한 쪽**이
 * 이긴다. 할 일(처리)이 계정(관리)보다 앞이다.
 */
export function activeTabFor(pathname: string): TabKey | null {
  if (isUnder(pathname, "/dashboard")) return "home";
  if (isUnder(pathname, "/transactions")) return "transactions";
  if (isUnder(pathname, "/ai")) return "ai";
  if (isUnder(pathname, "/budgets")) return "budgets";
  if (TODO_PATHS.some((p) => isUnder(pathname, p))) return "todo";
  if (ACCOUNT_PATHS.some((p) => isUnder(pathname, p))) return "account";
  return null;
}
