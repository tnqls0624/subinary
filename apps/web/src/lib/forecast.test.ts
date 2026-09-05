/**
 * 이번 달 예측 게임 — 저장된 값을 못 믿는 상황을 고정한다.
 *
 * 저장소(`play_states.state`)는 자유 jsonb라 값의 모양을 지켜 주지 않는다. 예전
 * 버전의 상태가 남아 있을 수 있고, 그때 화면이 깨지면 사용자는 게임을 다시 시작할
 * 방법조차 잃는다. 그래서 읽는 쪽이 전부 방어한다.
 */
import { describe, expect, it } from "vitest";

import {
  FORECAST_MAX_AMOUNT,
  compareForecast,
  isMonthClosed,
  isValidForecastAmount,
  parseForecastState,
} from "./forecast";

describe("parseForecastState — 못 읽는 값은 '기록 없음'이다", () => {
  it("정상 값을 읽는다", () => {
    expect(
      parseForecastState({ amount: 1_500_000, decidedAt: "2026-09-01T00:00:00Z" }),
    ).toEqual({ amount: 1_500_000, decidedAt: "2026-09-01T00:00:00Z" });
  });

  it.each([
    ["null", null],
    ["빈 객체", {}],
    ["금액이 문자열", { amount: "1500000", decidedAt: "2026-09-01T00:00:00Z" }],
    ["금액이 0", { amount: 0, decidedAt: "2026-09-01T00:00:00Z" }],
    ["금액이 음수", { amount: -100, decidedAt: "2026-09-01T00:00:00Z" }],
    ["금액이 소수", { amount: 1000.5, decidedAt: "2026-09-01T00:00:00Z" }],
    ["금액이 NaN", { amount: Number.NaN, decidedAt: "2026-09-01T00:00:00Z" }],
    ["상한 초과", { amount: FORECAST_MAX_AMOUNT + 1, decidedAt: "2026-09-01T00:00:00Z" }],
    ["시각 없음", { amount: 1_500_000 }],
    ["시각이 빈 문자열", { amount: 1_500_000, decidedAt: "" }],
  ])("%s이면 null을 준다 (던지지 않는다)", (_label, raw) => {
    expect(parseForecastState(raw as Record<string, unknown> | null)).toBeNull();
  });
});

describe("isValidForecastAmount", () => {
  it("정수 양수만 통과시킨다", () => {
    expect(isValidForecastAmount(1_500_000)).toBe(true);
    expect(isValidForecastAmount(1)).toBe(true);
  });

  it("0·음수·소수·상한초과를 막는다", () => {
    // 상한이 없으면 오타 하나(0을 더 누른)로 막대가 화면 밖으로 나간다.
    expect(isValidForecastAmount(0)).toBe(false);
    expect(isValidForecastAmount(-1)).toBe(false);
    expect(isValidForecastAmount(1.5)).toBe(false);
    expect(isValidForecastAmount(FORECAST_MAX_AMOUNT + 1)).toBe(false);
  });
});

describe("compareForecast", () => {
  it("실측 값으로 차이와 오차율을 낸다", () => {
    // 8월 실제 2,835,251원. 예상을 250만으로 적었다면.
    const r = compareForecast(2_500_000, 2_835_251);
    expect(r.diff).toBe(335_251);
    expect(r.errorRate).toBeCloseTo(0.134, 3);
    expect(r.progress).toBeCloseTo(1.134, 3);
  });

  it("예상보다 적게 쓴 경우 diff가 음수다", () => {
    const r = compareForecast(2_000_000, 229_120);
    expect(r.diff).toBe(-1_770_880);
    // 오차율은 방향 없이 크기만 — 판정을 하지 않으므로 부호는 diff가 갖는다.
    expect(r.errorRate).toBeCloseTo(0.885, 3);
  });

  it("예상이 0이면 오차율을 만들지 않는다", () => {
    // "무한% 빗나감"은 사실이 아니라 계산 사고다.
    expect(compareForecast(0, 100_000)).toEqual({
      diff: 100_000,
      errorRate: null,
      progress: 0,
    });
  });

  it("정확히 맞히면 차이가 0이다", () => {
    const r = compareForecast(1_000_000, 1_000_000);
    expect(r.diff).toBe(0);
    expect(r.errorRate).toBe(0);
  });
});

describe("isMonthClosed", () => {
  const now = new Date("2026-09-05T06:01:00Z"); // KST 2026-09-05 15:01

  it("지난달은 끝났다", () => {
    expect(isMonthClosed("2026-08", now)).toBe(true);
  });

  it("이번 달은 아직 진행 중이다", () => {
    // 월중에 "예상보다 적게 썼다"고 말하면 안 된다 — 달이 안 끝났기 때문이다.
    expect(isMonthClosed("2026-09", now)).toBe(false);
  });

  it("월이 바뀌는 자정을 KST로 판정한다", () => {
    // 2026-08-31 15:30 UTC = **2026-09-01 00:30 KST** — 9월이 시작됐고 8월은 끝났다.
    // UTC로 계산하면 아직 8월이라 "8월이 진행 중"이 되어, 이미 끝난 달의 예측을
    // 결과가 아니라 경과로 보여주게 된다.
    const kstNewMonth = new Date("2026-08-31T15:30:00Z");
    expect(isMonthClosed("2026-08", kstNewMonth)).toBe(true);
    expect(isMonthClosed("2026-09", kstNewMonth)).toBe(false);
  });

  it("연말을 넘어도 문자열 비교가 성립한다", () => {
    const jan = new Date("2027-01-10T03:00:00Z");
    expect(isMonthClosed("2026-12", jan)).toBe(true);
    expect(isMonthClosed("2027-01", jan)).toBe(false);
  });
});
