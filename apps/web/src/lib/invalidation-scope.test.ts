import { describe, expect, it } from "vitest";

import { TRANSACTION_SCOPE_KEYS } from "./invalidation-scope";

const prefixes = TRANSACTION_SCOPE_KEYS.map((k) => k[0]);

describe("TRANSACTION_SCOPE_KEYS — 실시간 힌트가 갈아엎는 범위", () => {
  it.each([
    ["결제 실패", "card-sms-declines"],
    ["가맹점", "merchants"],
    ["카드", "cards"],
  ])("%s이 빠져 있으면 새로고침해야 보인다 (%s)", (_label, prefix) => {
    expect(prefixes).toContain(prefix);
  });

  it("원래 있던 범위를 잃지 않는다", () => {
    for (const prefix of [
      "transactions",
      "analytics",
      "budgets",
      "monthly-insights",
      "card-sms-events",
      "merchant-label-candidates",
      "categories",
    ]) {
      expect(prefixes).toContain(prefix);
    }
  });

  it("중복이 없다 — 같은 접두를 두 번 무효화할 이유가 없다", () => {
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("알림 계열은 여기 없다 — activity-provider가 따로, user 스코프로 무효화한다", () => {
    expect(prefixes).not.toContain("notifications");
    expect(prefixes).not.toContain("notification-unread");
  });
});
