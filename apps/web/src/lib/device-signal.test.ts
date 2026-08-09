/* ---------------------------------------------------------------------------
 * Signal Doctor 판정 테스트.
 *
 * 핵심 회귀: **인증 성공(lastSeenAt)을 문자 수신으로 읽지 않는 것.** 예전 화면은
 * lastSeenAt 하나만 보고 "마지막 수신"이라고 표시해, 자동화의 문자 트리거가 죽어도
 * 정상으로 보였다(진단 D-2). 그 상태가 다시 healthy로 판정되면 이 테스트가 깨진다.
 * ------------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import type { DeviceSummary } from "@family/contracts";

import {
  COLLECTION_GAP_HOURS,
  diagnoseDeviceSignal,
  isSetupComplete,
} from "./device-signal";

const NOW = new Date("2026-08-09T12:00:00.000Z").getTime();

function device(overrides: Partial<DeviceSummary>): DeviceSummary {
  return {
    id: "d1",
    householdId: "h1",
    memberId: "m1",
    name: "엄마 휴대폰",
    platform: "android",
    status: "active",
    lastSeenAt: null,
    firstEventAt: null,
    lastEventAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function hoursAgo(hours: number): string {
  return new Date(NOW - hours * 3600_000).toISOString();
}

describe("diagnoseDeviceSignal", () => {
  it("아무 신호도 없으면 인증 실패로 본다", () => {
    const d = diagnoseDeviceSignal(device({}), NOW);
    expect(d.state).toBe("never_authenticated");
    expect(d.hints.length).toBeGreaterThan(0);
  });

  it("인증은 됐는데 문자가 없으면 '트리거가 안 걸림'이다 — healthy가 아니다", () => {
    const d = diagnoseDeviceSignal(
      device({ lastSeenAt: hoursAgo(0.1) }),
      NOW,
    );
    expect(d.state).toBe("authenticated_no_sms");
  });

  it("최근에 문자를 받았으면 정상", () => {
    const d = diagnoseDeviceSignal(
      device({
        lastSeenAt: hoursAgo(0.1),
        firstEventAt: hoursAgo(48),
        lastEventAt: hoursAgo(2),
      }),
      NOW,
    );
    expect(d.state).toBe("healthy");
  });

  it("받다가 끊기면(공백 임계 초과) stalled", () => {
    const d = diagnoseDeviceSignal(
      device({
        lastSeenAt: hoursAgo(0.1),
        firstEventAt: hoursAgo(200),
        lastEventAt: hoursAgo(COLLECTION_GAP_HOURS + 1),
      }),
      NOW,
    );
    expect(d.state).toBe("stalled");
  });

  it("임계 직전은 아직 정상 — 경계에서 겁주지 않는다", () => {
    const d = diagnoseDeviceSignal(
      device({
        lastSeenAt: hoursAgo(0.1),
        firstEventAt: hoursAgo(200),
        lastEventAt: hoursAgo(COLLECTION_GAP_HOURS - 1),
      }),
      NOW,
    );
    expect(d.state).toBe("healthy");
  });

  it("깨진 시각 문자열에 흔들리지 않는다", () => {
    const d = diagnoseDeviceSignal(
      device({
        lastSeenAt: hoursAgo(0.1),
        firstEventAt: hoursAgo(10),
        lastEventAt: "not-a-date",
      }),
      NOW,
    );
    expect(d.state).toBe("healthy");
  });
});

describe("isSetupComplete", () => {
  it("문자를 한 번이라도 받아야 완주다(인증만으로는 아니다)", () => {
    expect(isSetupComplete(device({ lastSeenAt: hoursAgo(1) }))).toBe(false);
    expect(isSetupComplete(device({ firstEventAt: hoursAgo(1) }))).toBe(true);
  });
});
