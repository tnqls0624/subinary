import { beforeEach, describe, expect, it } from "vitest";

import {
  canGoBackInApp,
  noteInAppNavigation,
  resetInAppNavigations,
} from "./nav-history";

describe("canGoBackInApp", () => {
  beforeEach(() => {
    resetInAppNavigations();
  });

  it("앱을 막 연 상태에서는 거짓(뒤로 갈 앱 화면이 없다)", () => {
    expect(canGoBackInApp()).toBe(false);
  });

  it("첫 화면 1회만 그린 상태(딥링크로 연 화면)도 거짓", () => {
    // 푸시 알림으로 /declines를 바로 열면 여기까지가 전부다 → backHref로 밀어야 한다.
    noteInAppNavigation();
    expect(canGoBackInApp()).toBe(false);
  });

  it("앱 안에서 한 번이라도 이동했으면 참", () => {
    noteInAppNavigation(); // /todo 진입
    noteInAppNavigation(); // /todo → /declines
    expect(canGoBackInApp()).toBe(true);
  });
});
