import { describe, expect, it } from "vitest";

import { safeInternalPath } from "./safe-redirect";

describe("safeInternalPath — 오픈 리다이렉트 차단", () => {
  it.each([
    ["절대 URL(https)", "https://evil.com"],
    ["절대 URL(http)", "http://evil.com/join"],
    ["프로토콜 상대 URL", "//evil.com"],
    ["프로토콜 상대 URL + 경로", "//evil.com/dashboard"],
    ["백슬래시 프로토콜 상대", "/\\evil.com"],
    ["백슬래시 두 개", "\\\\evil.com"],
    ["백슬래시 혼합", "/\\/evil.com"],
    ["경로 안 백슬래시", "/dashboard\\@evil.com"],
    ["javascript 스킴", "javascript:alert(1)"],
    ["대소문자 섞인 javascript 스킴", "JaVaScRiPt:alert(1)"],
    ["data 스킴", "data:text/html,<script>alert(1)</script>"],
    ["스킴 축약형", "http:/evil.com"],
    ["백틱 없는 상대경로", "dashboard"],
    ["빈 문자열", ""],
    ["공백만", "   "],
    ["앞 공백으로 스킴 숨기기", " javascript:alert(1)"],
    ["개행으로 스킴 숨기기", "\n/\n/evil.com"],
    ["탭 삽입", "/\t/evil.com"],
    ["널 문자", "/dashboard\u0000"],
    ["사용자 정보 트릭", "https://app.example.com@evil.com"],
  ])("%s 는 거부한다", (_label, input) => {
    expect(safeInternalPath(input)).toBeNull();
  });

  it("null/undefined 는 거부한다", () => {
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
  });
});

describe("safeInternalPath — 앱 내부 경로 허용", () => {
  it.each([
    ["단순 경로", "/dashboard", "/dashboard"],
    ["루트", "/", "/"],
    ["쿼리 포함", "/join?token=abc123", "/join?token=abc123"],
    [
      "인코딩된 쿼리 값 보존",
      "/join?token=a%2Fb%3Dc",
      "/join?token=a%2Fb%3Dc",
    ],
    ["해시 포함", "/more#notifications", "/more#notifications"],
    ["여러 세그먼트", "/household/members", "/household/members"],
    [
      "쿼리 + 해시",
      "/transactions?month=2026-08#top",
      "/transactions?month=2026-08#top",
    ],
  ])("%s 는 통과시킨다", (_label, input, expected) => {
    expect(safeInternalPath(input)).toBe(expected);
  });

  it("경로 정규화 결과를 돌려준다(상위 이동은 오리진 안에서 접힌다)", () => {
    // `..`로는 오리진 밖으로 나갈 수 없다 — URL 파서가 루트에서 멈춘다.
    expect(safeInternalPath("/../../etc/passwd")).toBe("/etc/passwd");
  });

  it("초대 복귀 링크(실제 사용 형태)를 통과시킨다", () => {
    const token = "0123456789abcdef";
    const returnTo = `/join?token=${encodeURIComponent(token)}`;
    expect(safeInternalPath(returnTo)).toBe(returnTo);
  });
});
