/**
 * 거래 귀속 표시 규칙 — 2026-09-05 실측 사고를 고정한다.
 *
 * 홈 최근 거래가 카드 **소유자**를 쓰고 거래 목록이 `is_shared`를 읽어, 같은 거래가
 * 화면마다 다른 사람으로 보였다(공용 카드 88건 1,458,011원). 사용자에게는 "홈 최근
 * 거래에 한 사람 것만 나온다"로 드러났다 — 공용 카드 소유자가 한 명이었다.
 */
import { describe, expect, it } from "vitest";

import {
  attributedMemberId,
  attributedMemberName,
  sharedCardIdSet,
} from "./transaction-attribution";

const CARDS = [
  { id: "shared-card", isShared: true }, // 공룡카드 — 소유자 김유진
  { id: "private-card", isShared: false }, // 네이버 현대카드
];
const shared = sharedCardIdSet(CARDS);

describe("attributedMemberId", () => {
  it("공용 카드 결제는 사람에게 귀속시키지 않는다", () => {
    // 실측 사고의 핵심: 이 거래를 카드 소유자(김유진)로 표시하면 실제로 쓴 사람의
    // 내역이 화면에서 사라진다.
    expect(
      attributedMemberId({ cardId: "shared-card", memberId: "soobeen" }, shared),
    ).toBeNull();
  });

  it("비공용 카드는 카드 소유자가 아니라 거래의 구성원을 쓴다", () => {
    // 서버 집계(analytics/members)가 member_id를 정본으로 쓴다. 화면이 소유자를
    // 우선하면 통계와 목록이 서로 다른 사람을 말한다.
    expect(
      attributedMemberId(
        { cardId: "private-card", memberId: "soobeen" },
        shared,
      ),
    ).toBe("soobeen");
  });

  it("카드 미연결 거래는 그대로 거래의 구성원이다", () => {
    // 공용 판정 대상이 아니다(실측 7건).
    expect(
      attributedMemberId({ cardId: null, memberId: "soobeen" }, shared),
    ).toBe("soobeen");
  });

  it("공용 카드가 하나도 없으면 아무것도 공용이 되지 않는다", () => {
    const none = sharedCardIdSet([{ id: "private-card", isShared: false }]);
    expect(
      attributedMemberId({ cardId: "private-card", memberId: "u1" }, none),
    ).toBe("u1");
  });
});

describe("attributedMemberName", () => {
  const names = new Map([["soobeen", "이수빈"]]);

  it("공용은 이름 대신 '공용'이다", () => {
    expect(attributedMemberName(null, names)).toBe("공용");
  });

  it("이름을 찾으면 그 이름", () => {
    expect(attributedMemberName("soobeen", names)).toBe("이수빈");
  });

  it("이름을 못 찾아도 빈 값을 만들지 않는다", () => {
    expect(attributedMemberName("unknown", names)).toBe("구성원");
  });
});
