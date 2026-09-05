/**
 * 가맹점 도감 — 2026-09-05 운영 실측을 고정한다.
 *
 * 실측: 가맹점 102곳 · 3회 이상 20곳 · 1회만 65곳 ·
 * 9월 첫 방문 3곳(셰프의아이들 09-05, 푹 TV·발트페이 09-04).
 */
import { describe, expect, it } from "vitest";

import {
  atlasBrands,
  newlyDiscovered,
  regularMerchants,
  summarizeAtlas,
  type AtlasMerchant,
} from "./atlas";

const m = (
  name: string,
  transactionCount: number,
  firstTransactionAt: string | null,
  aliasOf: string | null = null,
  netTotal = transactionCount * 1000,
): AtlasMerchant => ({
  name,
  transactionCount,
  netTotal,
  firstTransactionAt,
  aliasOf,
});

describe("summarizeAtlas", () => {
  it("별칭 행을 이중으로 세지 않는다", () => {
    // 별칭은 대표에 이미 합산돼 있다. 여기서 또 세면 "발견한 곳"이 부풀려진다.
    const items = [
      m("지에스25 영등포도림", 18, "2026-07-01T00:00:00Z"),
      m("GS25영등포도림", 0, null, "지에스25 영등포도림"),
    ];
    expect(summarizeAtlas(items).discovered).toBe(1);
  });

  it("거래가 0인 이름(별칭만 등록)은 발견으로 세지 않는다", () => {
    expect(summarizeAtlas([m("이름만", 0, null)]).discovered).toBe(0);
  });

  it("3회 이상을 단골로, 1회를 한 번만으로 센다", () => {
    const items = [
      m("쿠팡", 28, "2026-07-01T00:00:00Z"),
      m("벤디스", 18, "2026-07-02T00:00:00Z"),
      m("파리바게뜨", 3, "2026-08-01T00:00:00Z"),
      m("한번만간곳", 1, "2026-08-02T00:00:00Z"),
      m("두번간곳", 2, "2026-08-03T00:00:00Z"),
    ];
    expect(summarizeAtlas(items)).toEqual({
      discovered: 5,
      regulars: 3,
      onceOnly: 1,
    });
  });
});

describe("newlyDiscovered", () => {
  it("첫 방문이 그 달인 곳만, 최근 순으로 준다", () => {
    // 실측 9월 첫 방문 3곳.
    const items = [
      m("셰프의아이들", 1, "2026-09-05T04:00:00Z"),
      m("푹 TV", 1, "2026-09-04T11:26:00Z"),
      m("발트페이", 1, "2026-09-04T03:00:00Z"),
      // 단골이라 9월에도 방문했지만 첫 방문은 7월 — 새 발견이 아니다.
      m("쿠팡", 28, "2026-07-01T00:00:00Z"),
    ];
    expect(newlyDiscovered(items, "2026-09").map((x) => x.name)).toEqual([
      "셰프의아이들",
      "푹 TV",
      "발트페이",
    ]);
  });

  it("마지막 방문이 아니라 첫 방문으로 가른다", () => {
    // 지난달부터 다니던 단골을 "이번 달 새 발견"으로 부르면 거짓이 된다.
    const items = [m("쿠팡", 28, "2026-07-01T00:00:00Z")];
    expect(newlyDiscovered(items, "2026-09")).toEqual([]);
  });

  it("첫 방문 시각이 없으면 어느 달에도 넣지 않는다", () => {
    expect(newlyDiscovered([m("시각없음", 2, null)], "2026-09")).toEqual([]);
  });
});

describe("regularMerchants", () => {
  it("방문 많은 순으로 준다", () => {
    const items = [
      m("파리바게뜨", 5, "2026-08-01T00:00:00Z"),
      m("쿠팡", 28, "2026-07-01T00:00:00Z"),
      m("벤디스", 18, "2026-07-02T00:00:00Z"),
      m("두번", 2, "2026-08-02T00:00:00Z"),
    ];
    expect(regularMerchants(items).map((x) => x.name)).toEqual([
      "쿠팡",
      "벤디스",
      "파리바게뜨",
    ]);
  });
});

describe("atlasBrands", () => {
  it("이름이 하나뿐인 브랜드도 배지로 남긴다", () => {
    // 가맹점 정리 화면은 이름 2개 이상만 보여주지만(합칠 것이 없으면 소음),
    // 도감에서는 세븐일레븐 11회가 그 자체로 수집물이다.
    const brands = atlasBrands([m("세븐일레븐중구ENA센터", 11, "2026-07-01T00:00:00Z")]);
    expect(brands).toHaveLength(1);
    expect(brands[0]).toMatchObject({
      brand: "세븐일레븐",
      nameCount: 1,
      visitCount: 11,
    });
  });

  it("같은 브랜드의 여러 지점을 한 배지로 묶는다", () => {
    const brands = atlasBrands([
      m("지에스25 영등포도림", 11, "2026-07-01T00:00:00Z"),
      m("GS25영등포도림", 7, "2026-07-02T00:00:00Z"),
      m("지에스25여의캐", 7, "2026-07-03T00:00:00Z"),
    ]);
    expect(brands[0]).toMatchObject({ brand: "GS25", nameCount: 3, visitCount: 25 });
  });

  it("브랜드를 모르는 곳은 배지를 만들지 않는다", () => {
    // "기타" 배지는 그 안에서 아무 사실도 읽을 수 없는 덩어리가 된다.
    expect(atlasBrands([m("벤디스", 18, "2026-07-01T00:00:00Z")])).toEqual([]);
  });

  it("경쟁 브랜드를 한 배지로 합치지 않는다", () => {
    const brands = atlasBrands([
      m("씨유영등포도림", 2, "2026-07-01T00:00:00Z"),
      m("GS25영등포도림", 7, "2026-07-02T00:00:00Z"),
    ]);
    expect(brands.map((b) => b.brand).sort()).toEqual(["CU", "GS25"]);
  });
});
