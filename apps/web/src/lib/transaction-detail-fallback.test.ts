import { describe, expect, it } from "vitest";

import {
  detailFallbackCopy,
  detailFallbackReason,
} from "./transaction-detail-fallback";

describe("detailFallbackReason — 없는 것/막힌 것/오류 구분", () => {
  it("403은 '막힌 것'(그 가족의 구성원이 아님)", () => {
    expect(detailFallbackReason({ status: 403 })).toBe("forbidden");
  });

  it("404는 '없는 것'(삭제됐거나 남의 비공개)", () => {
    expect(detailFallbackReason({ status: 404 })).toBe("missing");
  });

  it("400(uuid가 아닌 id)도 사용자에게는 '없는 것'과 같다", () => {
    expect(detailFallbackReason({ status: 400 })).toBe("missing");
  });

  it.each([500, 502, 503, 0])("%s는 일시적 오류로 본다", (status) => {
    expect(detailFallbackReason({ status })).toBe("error");
  });

  it("status가 없는 에러(네트워크 단절 등)는 오류", () => {
    expect(detailFallbackReason(new Error("network"))).toBe("error");
    expect(detailFallbackReason(null)).toBe("error");
    expect(detailFallbackReason(undefined)).toBe("error");
    expect(detailFallbackReason("boom")).toBe("error");
  });
});

describe("detailFallbackCopy — 지어내지 않는 문구", () => {
  it("일시적 오류만 재시도를 권한다", () => {
    expect(detailFallbackCopy("error").retryable).toBe(true);
    expect(detailFallbackCopy("missing").retryable).toBe(false);
    expect(detailFallbackCopy("forbidden").retryable).toBe(false);
  });

  it("404 문구는 '삭제됐다'고 단정하지 않는다 — 서버가 남의 비공개도 404로 감춘다", () => {
    const copy = detailFallbackCopy("missing");
    expect(copy.description).toContain("삭제됐거나");
    expect(copy.description).toContain("비공개");
  });

  it("세 이유의 제목이 서로 다르다(같으면 구분한 의미가 없다)", () => {
    const titles = (["forbidden", "missing", "error"] as const).map(
      (r) => detailFallbackCopy(r).title,
    );
    expect(new Set(titles).size).toBe(3);
  });
});
