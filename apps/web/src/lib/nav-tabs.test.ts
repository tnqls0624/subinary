import { describe, expect, it } from "vitest";

import { activeTabFor, isTabRoot, isUnder, normalizePath, parentTabHref, PRIMARY_TABS, TAB_ROOTS } from "./nav-tabs";

describe("path boundaries", () => {
  it("normalizes Capacitor trailing slashes without changing root", () => {
    expect(normalizePath("/more/privacy/")).toBe("/more/privacy");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });

  it("does not classify unrelated prefix matches", () => {
    expect(isUnder("/more/privacy", "/more")).toBe(true);
    expect(isUnder("/ai-operations", "/ai")).toBe(false);
    for (const path of ["/assets-archive", "/plans", "/transactions-archive", "/unknown"]) {
      expect(activeTabFor(path)).toBeNull();
    }
    // 연결 화면만 자산 탭이다 — 이름이 비슷한 다른 전체 메뉴 경로까지 끌려가지 않는다.
    expect(activeTabFor("/more/connections-archive")).toBe("all");
  });
});

describe("simplified primary destinations", () => {
  it("keeps the agreed order, routes and labels", () => {
    expect(PRIMARY_TABS.map(({ href, label }) => [href, label])).toEqual([
      ["/dashboard", "홈"], ["/transactions", "가계부"], ["/assets", "자산"], ["/more", "전체"],
    ]);
    expect(TAB_ROOTS).toHaveLength(4);
    for (const tab of PRIMARY_TABS) {
      expect(activeTabFor(tab.href)).toBe(tab.key);
      expect(isTabRoot(tab.href + "/")).toBe(true);
    }
  });

  it.each([
    ["/cards", "assets"], ["/cards/abc/", "assets"], ["/assets/accounts", "assets"],
    ["/assets/loan-import/", "assets"],
    ["/budgets", "ledger"], ["/ledger/analysis/", "ledger"], ["/ledger/weekly-review", "ledger"],
    ["/transactions/abc", "ledger"],
    ["/plan/housing", "assets"], ["/plan/funding/", "assets"],
    ["/todo", "ledger"], ["/declines", "ledger"], ["/ai/", "all"],
    ["/ai-operations", "all"], ["/household", "all"],
    ["/devices", "all"], ["/categories", "all"], ["/notifications", null],
    ["/more/merchants", "all"], ["/more/recurring", "ledger"],
    ["/more/category-rules", "all"], ["/more/privacy/", "all"],
    ["/more/notifications", "all"], ["/more/password", "all"],
    ["/more/connections", "assets"], ["/more/connections/", "assets"],
  ])("preserves legacy route %s under %s", (path, expected) => {
    expect(activeTabFor(path)).toBe(expected);
    expect(isTabRoot(path)).toBe(false);
  });
});

describe("cold-entry parent destinations", () => {
  it("keeps failed payments inside their existing task flow", () => {
    expect(parentTabHref("/declines/")).toBe("/todo");
    expect(parentTabHref("/todo")).toBe("/transactions");
  });

  it("makes 전체 a tab root and keeps housing secondary (ADR-0037)", () => {
    expect(isTabRoot("/more")).toBe(true);
    expect(isTabRoot("/plan")).toBe(false);
    expect(parentTabHref("/plan")).toBe("/assets");
    expect(parentTabHref("/more/privacy")).toBe("/more");
    expect(parentTabHref("/household")).toBe("/more");
    expect(parentTabHref("/notifications")).toBe("/dashboard");
  });

  it("treats the connection screens as part of assets, matching their default back destination", () => {
    // 결정 ①(2026-11-06): 주소는 전체 아래지만 자산 탭에 불이 켜지고, 콜드 진입의 뒤로가기도 자산으로 간다.
    expect(activeTabFor("/more/connections")).toBe("assets");
    expect(parentTabHref("/more/connections")).toBe("/assets");
    expect(parentTabHref("/more/connections/")).toBe("/assets");
    expect(isTabRoot("/more/connections")).toBe(false);
    // 전체 메뉴 자체와 다른 하위 화면은 그대로 전체다.
    expect(activeTabFor("/more")).toBe("all");
    expect(parentTabHref("/more/privacy")).toBe("/more");
  });

  it("returns a cold loan-import deep link to assets without making it an exit root", () => {
    expect(parentTabHref("/assets/loan-import/")).toBe("/assets");
    expect(isTabRoot("/assets/loan-import/")).toBe(false);
  });

  it("all legacy subpages reach a primary destination without a loop", () => {
    for (const path of ["/declines", "/cards", "/budgets", "/ledger/analysis", "/todo", "/ai", "/more/privacy", "/plan/housing", "/more/connections"]) {
      const visited = new Set<string>();
      let current = path;
      while (!isTabRoot(current)) {
        expect(visited.has(current)).toBe(false);
        visited.add(current);
        current = parentTabHref(current);
      }
      expect(visited.size).toBeLessThanOrEqual(2);
    }
  });

  it("unknown cold-entry routes have a safe existing fallback", () => {
    expect(parentTabHref("/unknown")).toBe("/dashboard");
  });
});
