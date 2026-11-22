import type { DeviceSecretResponse, DeviceSummary } from "@family/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 문자 수집 설정 마법사 정적 렌더 — 2026-11-05 HIG 검수 4단계에서 바꾼 것을 고정한다.
 * ① 연결 열쇠는 이 창에서 한 번만 보인다: 열쇠를 챙기기 전에는 닫기(X·Esc·'닫기')가 바로 닫지 않고,
 *    바깥을 눌러도 닫히지 않는다. ② 2단계는 자동화 앱의 칸마다 복사 버튼이 있다(전체 복사는 보조).
 * 열쇠·주소는 모두 합성값이다. node 환경이라 Radix 포털이 그려지지 않아 창 모듈은 내용을 그대로 펼치는
 * 대역으로 바꾸고, 창이 받은 닫기 처리기를 붙잡아 직접 불러 본다.
 */

const captured: {
  onOpenChange?: (open: boolean) => void;
  onInteractOutside?: (event: { preventDefault: () => void }) => void;
  /** 확인 시트는 상태로 열려 정적 렌더에서 열 수 없다 — 문구를 보려면 대역이 강제로 펼친다. */
  forceAlertOpen?: boolean;
} = {};

vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  type Props = { children?: ReactNode };
  const block = ({ children }: Props) => h("div", null, children);
  return {
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: Props & { open: boolean; onOpenChange: (open: boolean) => void }) => {
      captured.onOpenChange = onOpenChange;
      return open ? h("div", { "data-dialog": "" }, children) : null;
    },
    DialogContent: ({
      children,
      onInteractOutside,
    }: Props & {
      onInteractOutside?: (event: { preventDefault: () => void }) => void;
    }) => {
      captured.onInteractOutside = onInteractOutside;
      return h("div", null, children);
    },
    DialogHeader: block,
    DialogFooter: block,
    DialogTitle: ({ children }: Props) => h("h2", null, children),
    DialogDescription: ({ children }: Props) => h("p", null, children),
  };
});
vi.mock("@/components/ui/alert-dialog", async () => {
  const { createElement: h } = await import("react");
  type Props = { children?: ReactNode };
  const block = ({ children }: Props) => h("div", null, children);
  return {
    AlertDialog: ({ open, children }: Props & { open: boolean }) =>
      open || captured.forceAlertOpen
        ? h("div", { "data-alert": "" }, children)
        : null,
    AlertDialogContent: block,
    AlertDialogHeader: block,
    AlertDialogFooter: block,
    AlertDialogTitle: ({ children }: Props) => h("h2", null, children),
    AlertDialogDescription: ({ children }: Props) => h("p", null, children),
    AlertDialogAction: ({
      children,
      variant,
    }: Props & { variant?: string }) =>
      h("button", { "data-variant": variant }, children),
    AlertDialogCancel: ({ children }: Props) => h("button", null, children),
  };
});
vi.mock("@/lib/api-client", () => ({
  API_BASE_URL: "https://api.example.test",
  ApiError: class extends Error {},
  api: { mobileEvents: { pingWithCollectToken: vi.fn() } },
}));
vi.mock("@/lib/queries", () => ({ useDevices: () => ({}) }));

import { CollectSetupWizard } from "./collect-setup-wizard";

// 가짜 열쇠는 엔트로피가 낮은 값으로 둔다 — 그럴듯한 문자열은 CI gitleaks(generic-api-key)가 비밀로 잡는다.
const KEY = "k".repeat(32);

function device(changes: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: "d-1",
    householdId: "h-1",
    memberId: "m-1",
    name: "엄마 휴대폰",
    platform: "android",
    status: "active",
    lastSeenAt: null,
    firstEventAt: null,
    lastEventAt: null,
    createdAt: "2026-11-05T00:00:00.000Z",
    ...changes,
  };
}

function issued(): DeviceSecretResponse {
  return {
    device: device(),
    deviceId: "d-1",
    secret: "synthetic-secret",
    algorithm: "HMAC-SHA256",
    signingRecipe: "",
    collectToken: KEY,
  };
}

function render(
  props: Partial<Parameters<typeof CollectSetupWizard>[0]> = {}
): string {
  return renderToStaticMarkup(
    <CollectSetupWizard
      open
      onOpenChange={vi.fn()}
      device={device()}
      issued={issued()}
      {...props}
    />
  );
}

beforeEach(() => {
  captured.onOpenChange = undefined;
  captured.onInteractOutside = undefined;
  captured.forceAlertOpen = false;
});

describe("수집 설정 마법사 — 열쇠를 챙기기 전 닫기", () => {
  it("1단계의 보조 버튼은 '닫기'다('나중에 할게요' 아님)", () => {
    const html = render({ initialStep: 1 });
    expect(html).toContain(">닫기</button>");
    expect(html).not.toContain("나중에 할게요");
    // 확인 시트는 닫으려 할 때만 뜬다.
    expect(html).not.toContain("닫으면 토큰을 다시 볼 수 없어요");
  });

  it("방금 받은 열쇠를 챙기기 전에는 X·Esc로 바로 닫지 않는다", () => {
    const onOpenChange = vi.fn();
    render({ initialStep: 1, onOpenChange });
    captured.onOpenChange?.(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("열쇠가 있는 동안 바깥을 눌러도 닫히지 않는다", () => {
    render({ initialStep: 1 });
    const preventDefault = vi.fn();
    captured.onInteractOutside?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });

  it("열쇠가 없는 '설정 계속하기'는 묻지 않고 닫는다", () => {
    const onOpenChange = vi.fn();
    render({ initialStep: 2, issued: null, onOpenChange });
    captured.onOpenChange?.(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const preventDefault = vi.fn();
    captured.onInteractOutside?.({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("닫기 확인에서 남는 쪽은 '계속 설정하기', 위험한 쪽은 '토큰 없이 닫기'다 — '닫기'로 남지 않는다", () => {
    captured.forceAlertOpen = true;
    const html = render({ initialStep: 1 });
    expect(html).toContain("닫으면 토큰을 다시 볼 수 없어요");
    expect(html).toContain(">계속 설정하기</button>");
    expect(html).toContain('data-variant="destructive">토큰 없이 닫기</button>');
    expect(html).not.toContain(">계속하기</button>");
    // 확인 시트 안에서 '닫기'라는 버튼은 위험한 쪽에도 남는 쪽에도 없다.
    const alert = html.slice(html.indexOf("data-alert"));
    expect(alert).not.toContain(">닫기</button>");
  });

  it("첫 문자를 받은 기기를 '설정 계속하기'로 열었으면 묻지 않고 닫는다", () => {
    const onOpenChange = vi.fn();
    render({
      issued: null,
      device: device({ firstEventAt: "2026-11-05T05:31:00.000Z" }),
      onOpenChange,
    });
    captured.onOpenChange?.(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("수집 설정 마법사 — 2단계 칸마다 복사", () => {
  it("주소·헤더 이름/값·본문마다 복사 버튼이 있고 전체 복사는 보조로 남는다", () => {
    const html = render({ initialStep: 2 });
    for (const name of [
      "주소(URL)",
      "Authorization 헤더 이름",
      "Authorization 헤더 값",
      "Content-Type 헤더 값",
      "X-Event-Id 헤더 값",
      "X-Sender 헤더 값",
      "본문",
    ]) {
      expect(html).toContain(`aria-label="${name} 복사"`);
    }
    expect(html).toContain("설정 전체 복사하기");
    // 요청 방식은 앱에서 고르는 값이라 복사 버튼이 없다.
    expect(html).not.toContain('aria-label="요청 방식 복사"');
    // 열쇠는 Authorization 값 한 곳에만 보인다.
    expect(html.split(KEY).length - 1).toBe(1);
  });

  it("열쇠가 없는 '설정 계속하기'에서는 Authorization 값(자리표시자)에 복사 버튼이 없다", () => {
    const html = render({ initialStep: 2, issued: null });
    // 자리표시자를 자동화 앱에 붙이면 이미 넣어 둔 진짜 열쇠를 덮어써 수집이 멈춘다.
    expect(html).not.toContain('aria-label="Authorization 헤더 값 복사"');
    expect(html).toContain("Bearer (등록할 때 받은 토큰)");
    expect(html).toContain("이미 넣었다면 그대로 두세요");
    // 다른 칸은 그대로 복사할 수 있다.
    expect(html).toContain('aria-label="Authorization 헤더 이름 복사"');
    expect(html).toContain('aria-label="주소(URL) 복사"');
    expect(html).toContain('aria-label="X-Sender 헤더 값 복사"');
  });

  it("1단계 머리글과 주 버튼은 같은 말('준비')이고, 직접 연동을 '앱'이라 부르지 않는다", () => {
    const android = render({ initialStep: 1 });
    expect(android).toContain("① MacroDroid 앱을 준비해 주세요");
    expect(android).toContain(">준비했어요</button>");
    expect(android).not.toContain("설치했어요");

    const other = render({
      initialStep: 1,
      device: device({ platform: "other" }),
    });
    expect(other).toContain("① 문자를 보낼 도구를 준비해 주세요");
    expect(other).not.toContain("직접 연동 앱");
  });

  it("버튼 문구는 동사형이고 날짜는 'M월 D일 오후 h:mm'으로 쓴다", () => {
    const step2 = render({ initialStep: 2 });
    expect(step2).toContain("연결 확인하기");
    expect(step2).not.toContain(">연결 테스트<");

    const done = render({
      issued: null,
      device: device({ firstEventAt: "2026-11-05T05:31:00.000Z" }),
    });
    expect(done).toMatch(/11월 5일 오후 2:31/);
    expect(done).not.toMatch(/2026\. ?11\. ?0?5\./);
  });
});

describe("수집 설정 마법사 — 토큰 재발급", () => {
  // 예전에 문자를 받은 적이 있는 기기(2026-11-22 실제 상황: 7월에 첫 문자, 11월 6일에 마지막 문자).
  const connected = () =>
    device({
      platform: "ios",
      firstEventAt: "2026-07-18T11:52:00.000Z",
      lastEventAt: "2026-11-06T08:55:00.000Z",
    });

  it("⋯ 메뉴에서 재발급하면 새 토큰과 '토큰 복사'만 먼저 보인다", () => {
    const html = render({ reissued: true, initialStep: 2, device: connected() });
    expect(html).toContain("토큰을 재발급했어요");
    expect(html).toContain(`Bearer ${KEY}`);
    expect(html).toContain("토큰 복사</button>");
    expect(html).toContain("URL의 콘텐츠 가져오기");
    expect(html).toContain(">처음부터 설정하기</button>");
    // 예전 첫 문자를 보고 성공 화면을 띄우지 않는다 — 그러면 토큰이 한 번도 보이지 않았다.
    expect(html).not.toContain("연결이 끝났어요");
    // 처음 설정용 칸별 안내는 접혀 있다. 토큰은 한 곳에만 보인다.
    expect(html).not.toContain("설정 전체 복사하기");
    expect(html.split(KEY).length - 1).toBe(1);
  });

  it("토큰을 복사하기 전에는 닫기 전에 묻는다", () => {
    const onOpenChange = vi.fn();
    render({ reissued: true, initialStep: 2, device: connected(), onOpenChange });
    captured.onOpenChange?.(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("설정 도중 마법사 안에서 재발급해도, 예전 문자가 있다고 성공 화면을 띄우지 않는다", () => {
    const html = render({ initialStep: 2, device: connected() });
    expect(html).not.toContain("연결이 끝났어요");
    expect(html).toContain("연결하는 중 2/3");
    expect(html).toContain(`Bearer ${KEY}`);
  });
});
