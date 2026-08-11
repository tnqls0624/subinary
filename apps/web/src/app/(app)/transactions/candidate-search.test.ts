/**
 * 취소 연결 후보 검색 — 표시용 좁히기 회귀 테스트.
 *
 * 왜 테스트하는가: 이 화면의 결함은 **"후보가 있는데 사용자가 도달할 수 없다"** 였다.
 * 서버가 상한 없이 전량을 주게 됐으니 이제 남은 도달 실패 경로는 두 개다.
 *  1. 검색이 사용자가 기억하는 단서(특히 **금액**)로 찾지 못한다 → 목록을 훑어야 하고
 *     후보가 많으면 실질적으로 100건 상한과 같아진다.
 *  2. 고른 뒤 검색어를 바꿔 그 후보가 사라졌는데 선택값이 남는다 → **화면에 보이지 않는
 *     승인에 취소가 붙는다**(금액이 조용히 틀리는 쪽의 사고다).
 */
import { describe, expect, it } from "vitest";

import {
  matchesCandidateSearch,
  retainSelection,
  type CandidateSearchFields,
} from "./candidate-search";

function candidate(
  overrides: Partial<CandidateSearchFields> = {},
): CandidateSearchFields {
  return {
    merchant: "스타벅스 강남점",
    amount: 12_000,
    remaining: 12_000,
    dateLabel: "2026. 8. 3.",
    ...overrides,
  };
}

describe("matchesCandidateSearch", () => {
  it("빈 검색어는 전부 통과시킨다 (필터를 걸지 않는다)", () => {
    expect(matchesCandidateSearch(candidate(), "")).toBe(true);
    // 공백만 입력한 상태도 "검색하지 않음"이다 — 여기서 전부 걸러 내면 목록이 빈다.
    expect(matchesCandidateSearch(candidate(), "   ")).toBe(true);
  });

  it("가맹점 부분 일치로 찾는다 (대소문자 무시)", () => {
    expect(matchesCandidateSearch(candidate(), "스타벅스")).toBe(true);
    expect(matchesCandidateSearch(candidate(), "강남")).toBe(true);
    expect(
      matchesCandidateSearch(candidate({ merchant: "GS25 역삼" }), "gs25"),
    ).toBe(true);
    expect(matchesCandidateSearch(candidate(), "이디야")).toBe(false);
  });

  it("금액으로 찾는다 — 쉼표·원화 기호가 섞여도 맞는다", () => {
    // 사용자가 화면에서 본 그대로 "12,000원"이라고 치는 것이 자연스럽다.
    expect(matchesCandidateSearch(candidate(), "12,000")).toBe(true);
    expect(matchesCandidateSearch(candidate(), "12000")).toBe(true);
    expect(matchesCandidateSearch(candidate(), "₩12,000원")).toBe(true);
    expect(matchesCandidateSearch(candidate(), "99000")).toBe(false);
  });

  it("부분 취소된 승인은 남은 잔액으로도 찾힌다", () => {
    // 화면 라벨이 "남은 금액"을 보여 주므로 그 숫자로 검색될 수 있어야 한다.
    const partial = candidate({ amount: 30_000, remaining: 15_000 });
    expect(matchesCandidateSearch(partial, "15,000")).toBe(true);
    // 원금으로도 찾힌다(문자에 찍힌 금액을 기억하는 경우).
    expect(matchesCandidateSearch(partial, "30000")).toBe(true);
  });

  it("날짜 라벨로도 찾는다", () => {
    expect(matchesCandidateSearch(candidate(), "8. 3")).toBe(true);
    expect(matchesCandidateSearch(candidate(), "2026")).toBe(true);
  });

  it("마스킹된 후보는 금액으로만 찾힌다 (가맹점이 가려져 있다)", () => {
    // 타인 summary_only 후보는 금액이 공개 대상이지만 이름은 "(비공개)"다.
    const masked = candidate({ merchant: "(비공개)" });
    expect(matchesCandidateSearch(masked, "스타벅스")).toBe(false);
    expect(matchesCandidateSearch(masked, "12000")).toBe(true);
    // 라벨 자체로도 모을 수 있어야 한다.
    expect(matchesCandidateSearch(masked, "비공개")).toBe(true);
  });

  it("숫자가 섞인 가맹점명은 텍스트로도 금액으로도 찾힌다", () => {
    const numbered = candidate({ merchant: "GS25", amount: 2_500, remaining: 2_500 });
    expect(matchesCandidateSearch(numbered, "25")).toBe(true);
    expect(matchesCandidateSearch(numbered, "2500")).toBe(true);
  });
});

describe("retainSelection", () => {
  it("선택한 후보가 목록에 남아 있으면 유지한다", () => {
    expect(retainSelection("a", ["a", "b"])).toBe("a");
  });

  it("검색어로 걸러져 사라지면 선택을 버린다", () => {
    // 유지하면 화면에 없는 승인에 연결 버튼이 살아 있게 된다.
    expect(retainSelection("a", ["b", "c"])).toBe("");
  });

  it("아직 아무것도 고르지 않은 상태를 바꾸지 않는다", () => {
    expect(retainSelection("", ["a"])).toBe("");
  });

  it("후보가 0건이면 어떤 선택도 남기지 않는다", () => {
    expect(retainSelection("a", [])).toBe("");
  });
});
