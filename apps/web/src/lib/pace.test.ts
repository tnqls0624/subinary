/**
 * 이번 달 페이스 구간 계산 — 경계를 고정한다.
 *
 * 날짜 경계는 하루에 한 번만 틀리는 종류의 버그를 만든다(자정·말일·연말). 시스템
 * 시계로는 그 순간을 재현할 수 없어 `now`를 주입받고 여기서 고정한다.
 */
import { describe, expect, it } from "vitest";

import {
  currentPacePair,
  lastDayOfMonth,
  paceDelta,
  paceRange,
} from "./pace";

describe("paceRange", () => {
  it("월초부터 기준일 다음 0시까지를 담는다", () => {
    // 실측 비교에 쓰는 구간: 2026-09-01 ~ 09-05.
    expect(paceRange(2026, 9, 5)).toEqual({
      month: "2026-09",
      throughDay: 5,
      from: "2026-09-01T00:00:00+09:00",
      // 기준일 23:59:59가 아니라 **다음 날 0시**다 — 그 1초 사이 거래가 빠지면 안 된다.
      to: "2026-09-06T00:00:00+09:00",
      truncated: false,
    });
  });

  it("말일을 넘어가면 그 달 마지막 날로 줄이고 사실을 표시한다", () => {
    // 3/31의 "지난달 같은 날"은 2/31이라 존재하지 않는다.
    const r = paceRange(2026, 2, 31);
    expect(r.throughDay).toBe(28);
    expect(r.to).toBe("2026-03-01T00:00:00+09:00");
    // 화면이 "비교 기간이 다르다"를 말할 수 있어야 한다.
    expect(r.truncated).toBe(true);
  });

  it("윤년 2월은 29일까지다", () => {
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(paceRange(2028, 2, 31).throughDay).toBe(29);
  });

  it("12월은 다음 해 1월로 넘어간다", () => {
    expect(paceRange(2026, 12, 31).to).toBe("2027-01-01T00:00:00+09:00");
  });
});

describe("currentPacePair", () => {
  it("오늘까지와 지난달 같은 날까지를 만든다", () => {
    // 2026-09-05 15:01 KST = 06:01 UTC
    const { current, previous } = currentPacePair(
      new Date("2026-09-05T06:01:00Z"),
    );
    expect(current.month).toBe("2026-09");
    expect(current.throughDay).toBe(5);
    expect(previous.month).toBe("2026-08");
    expect(previous.throughDay).toBe(5);
  });

  it("KST 자정 직후에도 그날 날짜를 쓴다", () => {
    // 2026-09-05 00:30 KST = 2026-09-04 15:30 UTC.
    // UTC 날짜로 계산하면 하루 전(4일)이 되어 비교가 어긋난다.
    const { current } = currentPacePair(new Date("2026-09-04T15:30:00Z"));
    expect(current.month).toBe("2026-09");
    expect(current.throughDay).toBe(5);
  });

  it("1월이면 지난달은 작년 12월이다", () => {
    const { previous } = currentPacePair(new Date("2027-01-10T03:00:00Z"));
    expect(previous.month).toBe("2026-12");
  });

  it("3월 31일의 지난달은 2월 28일까지로 줄어든다", () => {
    const { previous } = currentPacePair(new Date("2026-03-31T03:00:00Z"));
    expect(previous.month).toBe("2026-02");
    expect(previous.throughDay).toBe(28);
    expect(previous.truncated).toBe(true);
  });
});

describe("paceDelta", () => {
  it("실측 값으로 차이와 비율을 낸다", () => {
    // 9월 1~5일 229,120원 vs 8월 1~5일 412,089원
    const { diff, ratio } = paceDelta(229_120, 412_089);
    expect(diff).toBe(-182_969);
    expect(ratio).toBeCloseTo(-0.444, 3);
  });

  it("지난달이 0이면 비율을 만들지 않는다", () => {
    // "무한% 증가"는 사실이 아니라 계산 사고다.
    expect(paceDelta(50_000, 0)).toEqual({ diff: 50_000, ratio: null });
  });

  it("둘 다 0이면 차이도 0이고 비율은 없다", () => {
    expect(paceDelta(0, 0)).toEqual({ diff: 0, ratio: null });
  });
});
