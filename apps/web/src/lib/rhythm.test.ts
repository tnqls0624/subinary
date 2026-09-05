/**
 * 주간 리듬 — 2026-09-05 실측을 고정한다.
 *
 * 실측 요일 분포(승인 전체): 금 49 · 목 46 · 토 40 · 일 37 · 수 36 · 화 34 · 월 21.
 * 벤디스(식권) 18회는 **주말 0건**으로 평일에만 나타난다: 월2 화3 수4 목6 금3.
 */
import { describe, expect, it } from "vitest";

import {
  kstWeekday,
  merchantRhythms,
  weekdayBuckets,
  type RhythmTransaction,
} from "./rhythm";

const txn = (
  approvedAt: string | null,
  merchantNormalized: string | null = "가게",
  transactionType: "approval" | "cancellation" = "approval",
): RhythmTransaction => ({ approvedAt, transactionType, merchantNormalized });

describe("kstWeekday", () => {
  it("KST 기준 요일을 준다", () => {
    // 2026-09-05는 토요일(KST).
    expect(kstWeekday("2026-09-05T06:01:00Z")).toBe(6);
  });

  it("UTC로는 전날이지만 KST로는 당일인 시각을 바르게 센다", () => {
    // 2026-09-04 15:30 UTC = 2026-09-05 00:30 KST → 토요일.
    // 기기 타임존을 따르는 getDay()를 쓰면 해외에서 금요일로 세어진다.
    expect(kstWeekday("2026-09-04T15:30:00Z")).toBe(6);
  });

  it("잘못된 시각은 -1로 돌려보내고 던지지 않는다", () => {
    expect(kstWeekday("not-a-date")).toBe(-1);
  });
});

describe("weekdayBuckets", () => {
  it("결제가 없는 요일도 0으로 남긴다", () => {
    // 막대가 사라지면 "그 요일에 안 썼다"는 사실이 화면에서 지워진다.
    const buckets = weekdayBuckets([txn("2026-09-05T06:00:00Z")]);
    expect(buckets).toHaveLength(7);
    expect(buckets.map((b) => b.label)).toEqual([
      "일", "월", "화", "수", "목", "금", "토",
    ]);
    expect(buckets[6]?.count).toBe(1);
    expect(buckets[1]?.count).toBe(0);
  });

  it("취소 행을 세지 않는다", () => {
    // 취소는 별도 행으로 온다. 함께 세면 같은 사건이 두 번 잡힌다.
    const buckets = weekdayBuckets([
      txn("2026-09-05T06:00:00Z"),
      txn("2026-09-05T07:00:00Z", "가게", "cancellation"),
    ]);
    expect(buckets[6]?.count).toBe(1);
  });

  it("승인 시각이 없는 거래는 세지 않는다", () => {
    // 언제인지 모르는 결제를 임의의 요일에 넣으면 없는 사실을 만든다.
    expect(weekdayBuckets([txn(null)]).every((b) => b.count === 0)).toBe(true);
  });
});

describe("merchantRhythms", () => {
  // 벤디스 실측: 월2 화3 수4 목6 금3, 주말 0.
  const bendis: RhythmTransaction[] = [
    ...Array(2).fill(txn("2026-08-03T04:00:00Z", "벤디스")), // 월
    ...Array(3).fill(txn("2026-08-04T04:00:00Z", "벤디스")), // 화
    ...Array(4).fill(txn("2026-08-05T04:00:00Z", "벤디스")), // 수
    ...Array(6).fill(txn("2026-08-06T04:00:00Z", "벤디스")), // 목
    ...Array(3).fill(txn("2026-08-07T04:00:00Z", "벤디스")), // 금
  ];

  it("주말이 0인 가맹점을 평일 전용으로 표시한다", () => {
    const [r] = merchantRhythms(bendis);
    expect(r).toMatchObject({ merchant: "벤디스", total: 18, weekdayOnly: true });
    expect(r?.byWeekday).toEqual([0, 2, 3, 4, 6, 3, 0]);
  });

  it("주말에 한 번이라도 있으면 평일 전용이 아니다", () => {
    const [r] = merchantRhythms([
      ...bendis,
      txn("2026-08-08T04:00:00Z", "벤디스"), // 토
    ]);
    expect(r?.weekdayOnly).toBe(false);
  });

  it("방문이 적은 곳은 리듬을 말하지 않는다", () => {
    // 2~3회로는 요일 편향을 주장할 수 없다.
    expect(merchantRhythms([txn("2026-09-05T06:00:00Z", "한번")])).toEqual([]);
  });

  it("가맹점명이 없는 거래는 묶지 않는다", () => {
    const rows = Array(6).fill(txn("2026-09-05T06:00:00Z", null));
    expect(merchantRhythms(rows)).toEqual([]);
  });

  it("방문 많은 순으로 준다", () => {
    const rows = [
      ...bendis,
      ...Array(6).fill(txn("2026-08-05T04:00:00Z", "쿠팡")),
    ];
    expect(merchantRhythms(rows).map((r) => r.merchant)).toEqual([
      "벤디스",
      "쿠팡",
    ]);
  });
});
