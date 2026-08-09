import { describe, expect, it } from "vitest";

import type {
  CardSmsDeclineGroup,
  CardSmsEventSummary,
  TransactionSummary,
} from "@family/contracts";

import {
  HOME_SMS_WINDOW_MS,
  partitionSmsByWindow,
  pendingCountText,
  pendingReviewTransactions,
  todoTotal,
  unresolvedDeclines,
} from "./todo-counts";

/** 테스트 기준 시각(고정) — 3일 창 경계를 재현 가능하게 만든다. */
const NOW = new Date("2026-08-09T12:00:00.000Z").getTime();

function decline(over: Partial<CardSmsDeclineGroup> = {}): CardSmsDeclineGroup {
  return {
    merchant: "OO피트니스",
    amount: 99_000,
    currency: "KRW",
    reason: "lost_or_stolen",
    issuer: "국민",
    maskedCardNumber: "1234",
    attempts: 7,
    firstAttemptAt: "2026-08-01T06:00:00.000Z",
    lastAttemptAt: "2026-08-07T06:00:00.000Z",
    resolvedAt: null,
    dismissedAt: null,
    ...over,
  };
}

function txn(over: Partial<TransactionSummary> = {}): TransactionSummary {
  return {
    id: "t1",
    householdId: "h1",
    memberId: "m1",
    cardId: null,
    transactionType: "approval",
    status: "pending_review",
    amount: 10_000,
    cancelledAmount: 0,
    netAmount: 10_000,
    currency: "KRW",
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    merchantRaw: "스타벅스",
    merchantNormalized: "스타벅스",
    categoryId: null,
    categorySlug: null,
    approvedAt: "2026-08-08T03:00:00.000Z",
    cancelledAt: null,
    installmentMonths: null,
    parentTransactionId: null,
    visibility: "household",
    memo: null,
    masked: false,
    excludedAt: null,
    createdAt: "2026-08-08T03:00:10.000Z",
    ...over,
  };
}

function sms(over: Partial<CardSmsEventSummary> = {}): CardSmsEventSummary {
  return {
    id: "e1",
    eventId: "ev1",
    sender: "15881688",
    receivedAt: "2026-08-09T00:00:00.000Z",
    parseStatus: "parse_failed",
    issuer: null,
    transactionType: null,
    amount: null,
    currency: null,
    merchantRaw: null,
    occurredAt: null,
    installmentMonths: null,
    confidence: null,
    parseError: "no rule matched",
    createdAt: "2026-08-09T00:00:01.000Z",
    ...over,
  };
}

describe("unresolvedDeclines", () => {
  it("자동 해결·사용자 확인이 모두 없는 묶음만 남긴다", () => {
    const items = [
      decline({ merchant: "미해결" }),
      decline({ merchant: "자동해결", resolvedAt: "2026-08-08T00:00:00.000Z" }),
      decline({ merchant: "확인함", dismissedAt: "2026-08-08T00:00:00.000Z" }),
    ];
    expect(unresolvedDeclines(items).map((d) => d.merchant)).toEqual(["미해결"]);
  });

  it("목록이 아직 없으면 빈 배열", () => {
    expect(unresolvedDeclines(undefined)).toEqual([]);
  });
});

describe("pendingReviewTransactions", () => {
  it("확인필요·중복의심을 합치고 제외 처리분은 뺀다", () => {
    const result = pendingReviewTransactions(
      [txn({ id: "a" }), txn({ id: "b", excludedAt: "2026-08-08T00:00:00.000Z" })],
      [txn({ id: "c", status: "duplicate_suspected" })],
    );
    expect(result.map((t) => t.id).sort()).toEqual(["a", "c"]);
  });

  it("두 목록에 같은 거래가 걸쳐 있어도 한 번만 센다", () => {
    // 상태가 막 바뀐 거래는 한쪽 캐시에 옛 상태로 남아 두 목록에 동시에 나올 수 있다.
    const result = pendingReviewTransactions(
      [txn({ id: "same" })],
      [txn({ id: "same", status: "duplicate_suspected" })],
    );
    expect(result).toHaveLength(1);
  });

  it("최신순으로 정렬한다(승인 시각 없으면 생성 시각)", () => {
    const result = pendingReviewTransactions([
      txn({ id: "old", approvedAt: "2026-08-01T00:00:00.000Z" }),
      txn({ id: "new", approvedAt: "2026-08-09T00:00:00.000Z" }),
      txn({
        id: "mid",
        approvedAt: null,
        createdAt: "2026-08-05T00:00:00.000Z",
      }),
    ]);
    expect(result.map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("시각이 무효해도 목록에서 빠지지 않는다", () => {
    const result = pendingReviewTransactions([
      txn({ id: "broken", approvedAt: "not-a-date", createdAt: "not-a-date" }),
      txn({ id: "ok" }),
    ]);
    expect(result.map((t) => t.id)).toEqual(["ok", "broken"]);
  });
});

describe("partitionSmsByWindow", () => {
  it("홈 창(3일) 안팎으로 가른다", () => {
    const { recent, older } = partitionSmsByWindow(
      [
        sms({ id: "today", receivedAt: "2026-08-09T09:00:00.000Z" }),
        sms({ id: "2일전", receivedAt: "2026-08-07T12:00:00.000Z" }),
        sms({ id: "5일전", receivedAt: "2026-08-04T12:00:00.000Z" }),
      ],
      NOW,
    );
    expect(recent.map((e) => e.id)).toEqual(["today", "2일전"]);
    expect(older.map((e) => e.id)).toEqual(["5일전"]);
  });

  it("경계(정확히 3일 전)는 홈에 남긴다", () => {
    const at = new Date(NOW - HOME_SMS_WINDOW_MS).toISOString();
    const { recent, older } = partitionSmsByWindow([sms({ receivedAt: at })], NOW);
    expect(recent).toHaveLength(1);
    expect(older).toHaveLength(0);
  });

  it("수신 시각을 읽을 수 없는 문자는 '지난' 쪽에 두어 /todo에서 살린다", () => {
    const { recent, older } = partitionSmsByWindow(
      [sms({ id: "broken", receivedAt: "not-a-date" })],
      NOW,
    );
    expect(recent).toHaveLength(0);
    expect(older.map((e) => e.id)).toEqual(["broken"]);
  });

  it("목록이 아직 없으면 양쪽 다 빈 배열", () => {
    expect(partitionSmsByWindow(undefined, NOW)).toEqual({
      recent: [],
      older: [],
    });
  });
});

describe("todoTotal", () => {
  it("세 소스의 합계를 낸다", () => {
    expect(todoTotal({ declines: 1, reviews: 4, sms: 9 })).toBe(14);
  });

  it("모두 0이면 0(홈 카드가 숨는 조건)", () => {
    expect(todoTotal({ declines: 0, reviews: 0, sms: 0 })).toBe(0);
  });
});

describe("pendingCountText", () => {
  it("로딩과 에러를 0건으로 쓰지 않는다", () => {
    expect(pendingCountText(true, false, 0, false)).toBe("…");
    expect(pendingCountText(false, true, 0, false)).toBe("—");
  });

  it("스캔 상한에 걸리면 N+건으로 표기한다", () => {
    expect(pendingCountText(false, false, 100, true)).toBe("100+건");
    expect(pendingCountText(false, false, 3, false)).toBe("3건");
  });
});
