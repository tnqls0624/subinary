import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PATHS,
  activeTabFor,
  isTabRoot,
  isUnder,
  normalizePath,
  TAB_ROOTS,
  TODO_PATHS,
} from "./nav-tabs";

describe("normalizePath", () => {
  it("끝 슬래시를 뗀다(모바일 trailingSlash 빌드)", () => {
    expect(normalizePath("/todo/")).toBe("/todo");
    expect(normalizePath("/more/merchants/")).toBe("/more/merchants");
  });

  it("루트와 빈 값은 '/'", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });
});

describe("isUnder", () => {
  it("자기 자신과 하위 경로만 참", () => {
    expect(isUnder("/more", "/more")).toBe(true);
    expect(isUnder("/more/merchants", "/more")).toBe(true);
  });

  it("접두사만 같은 다른 경로는 거짓", () => {
    // `/ai-operations`가 `/ai` 탭을 켜면 AI 화면에 있는 것처럼 보인다.
    expect(isUnder("/ai-operations", "/ai")).toBe(false);
    expect(isUnder("/transactions-archive", "/transactions")).toBe(false);
  });
});

describe("activeTabFor — 탭별 대표 경로", () => {
  const cases: ReadonlyArray<[string, ReturnType<typeof activeTabFor>]> = [
    ["/dashboard", "home"],
    ["/transactions", "transactions"],
    ["/ai", "ai"],
    ["/budgets", "budgets"],
    ["/todo", "todo"],
    ["/more", "account"],
  ];
  for (const [path, tab] of cases) {
    it(`${path} → ${tab}`, () => {
      expect(activeTabFor(path)).toBe(tab);
    });
  }
});

describe("activeTabFor — 옮겨간 '더보기'", () => {
  it("예전 MORE_PATHS 전부가 계정(아바타) 활성으로 남는다", () => {
    // 탭이 헤더로 올라갔을 뿐 "여기는 관리 화면"이라는 표시는 사라지면 안 된다.
    for (const path of ["/household", "/cards", "/devices", "/categories"]) {
      expect(activeTabFor(path)).toBe("account");
    }
  });

  it("/more 하위 화면도 계정 활성", () => {
    for (const path of [
      "/more/merchants",
      "/more/recurring",
      "/more/notifications",
      "/more/privacy",
      "/more/password",
    ]) {
      expect(activeTabFor(path)).toBe("account");
    }
  });

  it("운영자 전용 화면도 계정 활성(/more에서만 들어간다)", () => {
    expect(activeTabFor("/ai-operations")).toBe("account");
  });
});

describe("activeTabFor — 두 곳에서 링크되는 화면", () => {
  it("/declines는 할 일이 이긴다(계정 아님)", () => {
    // /more에도 링크가 있지만 사용자가 지금 하는 일은 '처리'다.
    expect(activeTabFor("/declines")).toBe("todo");
    expect(ACCOUNT_PATHS).not.toContain("/declines");
    expect(TODO_PATHS).toContain("/declines");
  });
});

describe("activeTabFor — 어디에도 속하지 않는 화면", () => {
  it("알림함은 헤더 벨에서 들어가므로 어떤 탭도 켜지 않는다", () => {
    expect(activeTabFor("/notifications")).toBeNull();
  });
});

describe("activeTabFor — 모바일 trailingSlash", () => {
  it("끝 슬래시가 붙어도 같은 탭이 켜진다", () => {
    expect(activeTabFor("/todo/")).toBe("todo");
    expect(activeTabFor("/more/privacy/")).toBe("account");
    expect(activeTabFor("/dashboard/")).toBe("home");
  });
});

describe("isTabRoot — 뒤로가기가 앱을 닫아야 하는 지점", () => {
  it("탭 루트 5개는 참", () => {
    for (const root of TAB_ROOTS) {
      expect(isTabRoot(root)).toBe(true);
    }
    expect(TAB_ROOTS).toHaveLength(5);
  });

  it("끝 슬래시(모바일 빌드)도 같은 판정", () => {
    expect(isTabRoot("/dashboard/")).toBe(true);
    expect(isTabRoot("/ai/")).toBe(true);
  });

  it("탭이 켜지는 하위 화면은 루트가 아니다 — 여기서는 상위로 올라가야 한다", () => {
    expect(activeTabFor("/declines")).toBe("todo");
    expect(isTabRoot("/declines")).toBe(false);
    expect(isTabRoot("/transactions/abc")).toBe(false);
  });

  it("관리 화면·알림함은 루트가 아니다", () => {
    for (const path of ["/more", "/devices", "/household", "/notifications"]) {
      expect(isTabRoot(path)).toBe(false);
    }
  });
});
