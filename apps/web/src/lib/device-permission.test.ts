import type { MemberSummary } from "@family/contracts";
import { describe, expect, it } from "vitest";

import { canManageDevice, findMyMemberId } from "./device-permission";

const member = (over: Partial<MemberSummary>): MemberSummary => ({
  memberId: "m1",
  userId: "u1",
  name: "나",
  email: "me@example.com",
  role: "member",
  status: "active",
  color: null,
  joinedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("canManageDevice — 서버 requireManageableDevice와 같은 규칙", () => {
  it("소유자는 남의 장치도 관리한다", () => {
    expect(
      canManageDevice({ role: "owner", myMemberId: "m1" }, "m2"),
    ).toBe(true);
  });

  it("소유자는 구성원 목록을 못 읽어도 판정된다(잠기지 않는다)", () => {
    expect(canManageDevice({ role: "owner", myMemberId: null }, "m2")).toBe(
      true,
    );
  });

  it("소유자가 아니면 자기 장치만 관리한다", () => {
    expect(canManageDevice({ role: "member", myMemberId: "m1" }, "m1")).toBe(
      true,
    );
    expect(canManageDevice({ role: "member", myMemberId: "m1" }, "m2")).toBe(
      false,
    );
  });

  it("admin도 소유자가 아니다 — 서버가 owner만 통과시킨다", () => {
    expect(canManageDevice({ role: "admin", myMemberId: "m1" }, "m2")).toBe(
      false,
    );
  });

  it("viewer도 자기 장치는 관리한다(서버 규칙 그대로)", () => {
    expect(canManageDevice({ role: "viewer", myMemberId: "m1" }, "m1")).toBe(
      true,
    );
  });

  it("모르면 감춘다 — 역할·내 memberId를 아직 못 읽었을 때", () => {
    expect(canManageDevice({ role: null, myMemberId: null }, "m1")).toBe(false);
    expect(canManageDevice({ role: undefined, myMemberId: null }, "m1")).toBe(
      false,
    );
  });
});

describe("findMyMemberId", () => {
  it("내 userId의 memberId를 찾는다", () => {
    expect(
      findMyMemberId([member({ memberId: "mine", userId: "u9" })], "u9"),
    ).toBe("mine");
  });

  it("가족에서 빠진 행(removed)은 세지 않는다", () => {
    expect(
      findMyMemberId(
        [member({ memberId: "old", userId: "u9", status: "removed" })],
        "u9",
      ),
    ).toBeNull();
  });

  it("목록·userId가 없으면 null", () => {
    expect(findMyMemberId(undefined, "u9")).toBeNull();
    expect(findMyMemberId([member({})], null)).toBeNull();
  });
});
