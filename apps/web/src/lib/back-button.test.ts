import { describe, expect, it } from "vitest";

import {
  EXIT_CONFIRM_WINDOW_MS,
  decideBackAction,
  type BackDecisionInput,
} from "./back-button";

const base: BackDecisionInput = {
  atTabRoot: false,
  canGoBackInApp: false,
  lastExitPromptAt: null,
  now: 1_000_000,
};

describe("decideBackAction — 탭 루트", () => {
  it("첫 누름은 종료하지 않고 안내한다", () => {
    expect(
      decideBackAction({ ...base, atTabRoot: true, canGoBackInApp: true }),
    ).toBe("confirm-exit");
  });

  it("안내 유효 시간 안의 두 번째 누름은 종료", () => {
    expect(
      decideBackAction({
        ...base,
        atTabRoot: true,
        lastExitPromptAt: base.now - 500,
      }),
    ).toBe("exit");
  });

  it("경계값(정확히 유효 시간)은 종료로 본다", () => {
    expect(
      decideBackAction({
        ...base,
        atTabRoot: true,
        lastExitPromptAt: base.now - EXIT_CONFIRM_WINDOW_MS,
      }),
    ).toBe("exit");
  });

  it("유효 시간이 지나면 다시 안내부터", () => {
    expect(
      decideBackAction({
        ...base,
        atTabRoot: true,
        lastExitPromptAt: base.now - EXIT_CONFIRM_WINDOW_MS - 1,
      }),
    ).toBe("confirm-exit");
  });

  it("미래 시각(시계 조정)은 무효로 보고 다시 묻는다", () => {
    expect(
      decideBackAction({
        ...base,
        atTabRoot: true,
        lastExitPromptAt: base.now + 5_000,
      }),
    ).toBe("confirm-exit");
  });

  it("탭 루트에서는 앱 안 이동 기록이 있어도 뒤로 가지 않는다(이것이 원래 버그)", () => {
    expect(
      decideBackAction({
        ...base,
        atTabRoot: true,
        canGoBackInApp: true,
        lastExitPromptAt: null,
      }),
    ).not.toBe("back");
  });
});

describe("decideBackAction — 하위 화면", () => {
  it("앱 안에서 온 길이 있으면 브라우저 뒤로가기(기존 동작 유지)", () => {
    expect(decideBackAction({ ...base, canGoBackInApp: true })).toBe("back");
  });

  it("딥링크로 방금 연 화면은 홈으로 — back()은 앱 밖으로 나가거나 무반응이다", () => {
    expect(decideBackAction({ ...base, canGoBackInApp: false })).toBe("home");
  });

  it("하위 화면에서는 종료 안내 상태와 무관하다", () => {
    expect(
      decideBackAction({
        ...base,
        canGoBackInApp: true,
        lastExitPromptAt: base.now,
      }),
    ).toBe("back");
  });
});
