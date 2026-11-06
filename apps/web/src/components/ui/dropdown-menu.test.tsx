/**
 * 공용 드롭다운은 터치·펜을 손을 뗄 때 연다(2026-11-06 사용자 지적: 값 고르기 줄에 스크롤하려고 손가락을 대면
 * 메뉴가 바로 열린다 — "거래 상세만이 아니고 전체적으로 다 그래").
 *
 * node 환경이라 브라우저 이벤트를 흉내 낼 수 없다. 그래서
 * - 열지 말지는 순수 함수(dropdownOpensAt)로,
 * - 실제 연결은 정적 렌더에서 트리거가 받는 핸들러(우리 처리 + Radix 처리)를 붙잡아 가짜 이벤트로 불러 보고,
 * - '열린 모달 메뉴는 바깥 pointerdown에서 먼저 닫힌다'는 설치된 Radix 소스로 확인한다.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  dropdownOpensAt,
  type DropdownPress,
} from "./dropdown-menu";

function opens(press: DropdownPress, disabled = false): boolean {
  return dropdownOpensAt(press, { disabled });
}

describe("dropdownOpensAt — 언제 메뉴를 여는가", () => {
  it("마우스는 지금처럼 누르는 순간 연다 — click에서는 따로 열지 않는다", () => {
    expect(opens({ moment: "pointerdown", pointerType: "mouse" })).toBe(true);
    expect(opens({ moment: "click", pointerType: null, detail: 1 })).toBe(
      false
    );
    expect(opens({ moment: "click", pointerType: "mouse", detail: 1 })).toBe(
      false
    );
  });

  it("터치·펜은 누를 때 열지 않고 손을 뗀 click에서 연다 — 손가락을 대고 밀면 click이 오지 않는다", () => {
    for (const pointerType of ["touch", "pen"]) {
      expect(opens({ moment: "pointerdown", pointerType })).toBe(false);
      expect(opens({ moment: "click", pointerType, detail: 1 })).toBe(true);
    }
  });

  it("키보드가 만드는 click(detail 0)으로는 열지 않는다 — Radix가 keydown에서 이미 토글했다", () => {
    expect(opens({ moment: "click", pointerType: "touch", detail: 0 })).toBe(
      false
    );
    expect(opens({ moment: "click", pointerType: null, detail: 0 })).toBe(
      false
    );
  });

  it("미뤄 둔 누름 없이 온 click으로는 열지 않는다", () => {
    expect(opens({ moment: "click", pointerType: null, detail: 1 })).toBe(
      false
    );
  });

  it("잠겨 있으면 어느 순간에도 열지 않는다", () => {
    for (const pointerType of ["touch", "pen", "mouse"]) {
      expect(opens({ moment: "pointerdown", pointerType }, true)).toBe(false);
      expect(opens({ moment: "click", pointerType, detail: 1 }, true)).toBe(
        false
      );
    }
  });
});

/** 트리거 버튼이 받는 이벤트의 필요한 부분(우리 처리와 Radix 처리가 읽는 값). */
type FakeEvent = {
  pointerType: string;
  detail: number;
  key: string;
  button: number;
  ctrlKey: boolean;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
  defaultPrevented: boolean;
  preventDefault(): void;
};

function fakeEvent(init: Partial<FakeEvent>): FakeEvent {
  return {
    pointerType: "",
    detail: 0,
    key: "",
    button: 0,
    ctrlKey: false,
    isPrimary: true,
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    ...init,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

type TriggerHandlers = Record<
  "onPointerDown" | "onPointerMove" | "onPointerCancel" | "onClick" | "onKeyDown",
  (event: FakeEvent) => void
>;

/**
 * 트리거 자식이 받는 최종 props(우리 핸들러 + Radix 핸들러가 합쳐진 것)를 붙잡는다.
 * 렌더가 끝난 뒤 부르므로 열림 상태는 렌더 때 값 그대로다 — 한 단계씩 확인한다.
 */
function captureTrigger(
  wrap: (trigger: ReactNode) => ReactNode,
  triggerProps: Omit<ComponentProps<typeof DropdownMenuTrigger>, "asChild"> = {}
): TriggerHandlers {
  let captured: Record<string, unknown> = {};
  function Probe(props: Record<string, unknown>) {
    captured = props;
    return <button type="button">열기</button>;
  }
  renderToStaticMarkup(
    wrap(
      <DropdownMenuTrigger asChild {...triggerProps}>
        <Probe />
      </DropdownMenuTrigger>
    )
  );
  return captured as unknown as TriggerHandlers;
}

/** 우리 DropdownMenu(제어)를 감싸고, Radix·우리 처리가 알리는 열림 변경을 기록한다. */
function controlled(
  open: boolean,
  triggerProps?: Omit<ComponentProps<typeof DropdownMenuTrigger>, "asChild">
) {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const trigger = captureTrigger(
    (child) => (
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        {child}
      </DropdownMenu>
    ),
    triggerProps
  );
  return { trigger, onOpenChange };
}

describe("DropdownMenuTrigger — 실제 연결(우리 처리 + Radix)", () => {
  it("터치로 누르면 Radix가 바로 열지 못하고, 손을 뗀 click에서 한 번 연다", () => {
    const { trigger, onOpenChange } = controlled(false);
    const down = fakeEvent({ pointerType: "touch" });
    trigger.onPointerDown(down);
    expect(down.defaultPrevented).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("펜도 터치와 같다", () => {
    const { trigger, onOpenChange } = controlled(false);
    trigger.onPointerDown(fakeEvent({ pointerType: "pen" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("스크롤로 이어진 터치(pointercancel)는 열지 않는다 — 뒤에 click이 와도 열지 않는다", () => {
    const { trigger, onOpenChange } = controlled(false);
    trigger.onPointerDown(fakeEvent({ pointerType: "touch" }));
    trigger.onPointerCancel(fakeEvent({ pointerType: "touch" }));
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("손가락이 조금 움직이면 열지 않는다 — 가로 칩 줄처럼 pointercancel이 안 와도 스와이프는 탭이 아니다", () => {
    const { trigger, onOpenChange } = controlled(false);
    trigger.onPointerDown(
      fakeEvent({ pointerType: "touch", clientX: 40, clientY: 10 })
    );
    trigger.onPointerMove(
      fakeEvent({
        pointerType: "touch",
        clientX: 40 + 11,
        clientY: 10,
        isPrimary: true,
      })
    );
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("손가락이 슬롭 안이면 손을 뗀 click에서 연다 — 살짝 흔들린 탭은 그대로", () => {
    const { trigger, onOpenChange } = controlled(false);
    trigger.onPointerDown(
      fakeEvent({ pointerType: "touch", clientX: 40, clientY: 10 })
    );
    trigger.onPointerMove(
      fakeEvent({
        pointerType: "touch",
        clientX: 44,
        clientY: 12,
        isPrimary: true,
      })
    );
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("마우스는 지금처럼 누르는 순간 Radix가 열고, 뒤따르는 click으로 두 번 열지 않는다", () => {
    const { trigger, onOpenChange } = controlled(false);
    trigger.onPointerDown(fakeEvent({ pointerType: "mouse" }));
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("키보드(Enter·Space·↓)는 Radix가 keydown에서 열고, Enter가 만드는 click(detail 0)으로 다시 토글하지 않는다", () => {
    for (const key of ["Enter", " ", "ArrowDown"]) {
      const { trigger, onOpenChange } = controlled(false);
      // 앞서 스크롤하다 만 터치가 남아 있어도(pointercancel 없이) 키보드 click으로는 열지 않는다.
      trigger.onPointerDown(fakeEvent({ pointerType: "touch" }));
      const keydown = fakeEvent({ key });
      trigger.onKeyDown(keydown);
      expect(keydown.defaultPrevented).toBe(true);
      expect(onOpenChange.mock.calls).toEqual([[true]]);
      trigger.onClick(fakeEvent({ detail: 0 }));
      expect(onOpenChange.mock.calls).toEqual([[true]]);
    }
  });

  it("잠기면 터치·마우스·키보드 어느 길로도 열지 않고, 잠긴 트리거의 이벤트는 건드리지 않는다", () => {
    const { trigger, onOpenChange } = controlled(false, { disabled: true });
    const touch = fakeEvent({ pointerType: "touch" });
    trigger.onPointerDown(touch);
    expect(touch.defaultPrevented).toBe(false);
    trigger.onClick(fakeEvent({ detail: 1 }));
    trigger.onPointerDown(fakeEvent({ pointerType: "mouse" }));
    trigger.onKeyDown(fakeEvent({ key: "Enter" }));
    trigger.onClick(fakeEvent({ detail: 0 }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("메뉴가 어떤 길로든 닫히면 미뤄 둔 터치를 지운다 — 열린 채 트리거를 다시 탭하면 닫힌 채로 남는다", () => {
    // 열린 모달 메뉴에서는 트리거가 pointer-events: none이라, 다시 탭하면 바깥 pointerdown이 먼저 닫는다(아래 Radix 전제).
    // 그 뒤 트리거에 click이 닿아도 다시 열면 안 된다. 여기서는 Radix가 부르는 닫기(Enter 토글)로 같은 길을 지난다.
    const { trigger, onOpenChange } = controlled(true);
    trigger.onPointerDown(fakeEvent({ pointerType: "touch" }));
    trigger.onKeyDown(fakeEvent({ key: "Enter" }));
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it("열려 있을 때 온 click은 열림 변경을 다시 알리지 않는다", () => {
    const { trigger, onOpenChange } = controlled(true);
    trigger.onPointerDown(fakeEvent({ pointerType: "touch" }));
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("open을 넘기지 않는 사용처(비제어)도 터치 click에서 열고 onOpenChange를 부른다", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const trigger = captureTrigger((child) => (
      <DropdownMenu onOpenChange={onOpenChange}>{child}</DropdownMenu>
    ));
    trigger.onPointerDown(fakeEvent({ pointerType: "touch" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("사용처가 넘긴 핸들러는 그대로 먼저 불리고, 그쪽이 기본 동작을 막으면 열지 않는다", () => {
    const onPointerDown = vi.fn((event: { preventDefault(): void }) =>
      event.preventDefault()
    );
    const onClick = vi.fn();
    const { trigger, onOpenChange } = controlled(false, {
      onPointerDown,
      onClick,
    });
    trigger.onPointerDown(fakeEvent({ pointerType: "touch" }));
    trigger.onClick(fakeEvent({ detail: 1 }));
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("이 파일의 DropdownMenu 밖(Radix Root 직접)에서는 Radix 기본 그대로다 — 열 길이 없어지지 않게", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const trigger = captureTrigger((child) => (
      <DropdownMenuPrimitive.Root open={false} onOpenChange={onOpenChange}>
        {child}
      </DropdownMenuPrimitive.Root>
    ));
    trigger.onPointerDown(fakeEvent({ pointerType: "touch" }));
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });
});

describe("DropdownMenu — 정적 모양은 그대로", () => {
  const render = (
    rootProps: ComponentProps<typeof DropdownMenu> = {},
    triggerProps: ComponentProps<typeof DropdownMenuTrigger> = {}
  ) =>
    renderToStaticMarkup(
      <DropdownMenu {...rootProps}>
        <DropdownMenuTrigger {...triggerProps}>열기</DropdownMenuTrigger>
      </DropdownMenu>
    );
  /** useId로 만든 id는 트리 모양에 따라 달라 비교에서 뺀다. */
  const withoutIds = (html: string) =>
    html.replace(/\s(id|aria-controls)="[^"]*"/g, "");

  it("닫힌 트리거는 Radix 그대로의 마크업에 data-slot만 더해진다", () => {
    const ours = render();
    expect(ours).toContain('aria-haspopup="menu"');
    expect(ours).toContain('aria-expanded="false"');
    expect(ours).toContain('data-state="closed"');
    expect(ours).toContain('type="button"');
    const radix = renderToStaticMarkup(
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger>열기</DropdownMenuPrimitive.Trigger>
      </DropdownMenuPrimitive.Root>
    );
    expect(
      withoutIds(ours).replace(' data-slot="dropdown-menu-trigger"', "")
    ).toBe(withoutIds(radix));
  });

  it("defaultOpen·open(제어)을 그대로 따른다 — 제어 값이 defaultOpen보다 앞선다", () => {
    for (const html of [
      render({ defaultOpen: true }),
      render({ open: true }),
    ]) {
      expect(html).toContain('aria-expanded="true"');
      expect(html).toContain('data-state="open"');
    }
    const forcedClosed = render({ open: false, defaultOpen: true });
    expect(forcedClosed).toContain('data-state="closed"');
  });

  it("잠그면 disabled·data-disabled가 그대로 붙는다", () => {
    const html = render({}, { disabled: true });
    expect(html).toContain('data-disabled=""');
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });
});

describe("Radix 전제 — 열린 모달 메뉴는 트리거를 다시 탭하면 바깥 pointerdown에서 먼저 닫힌다", () => {
  const require = createRequire(import.meta.url);
  const dropdownEntry = require.resolve("@radix-ui/react-dropdown-menu");
  const menuEntry = createRequire(dropdownEntry).resolve(
    "@radix-ui/react-menu"
  );
  const layerEntry = createRequire(menuEntry).resolve(
    "@radix-ui/react-dismissable-layer"
  );
  const dropdown = readFileSync(dropdownEntry, "utf8");
  const menu = readFileSync(menuEntry, "utf8");
  const layer = readFileSync(layerEntry, "utf8");

  it("DropdownMenuTrigger는 우리 onPointerDown을 먼저 부르고, 기본 동작이 막혔으면 바로 열지 않는다", () => {
    expect(dropdown).toMatch(
      /onPointerDown: \(0, import_primitive\.composeEventHandlers\)\(props\.onPointerDown,/
    );
  });

  it("드롭다운은 기본이 모달이고, 모달 메뉴는 열린 동안 바깥(트리거 포함) pointer 이벤트를 끈다", () => {
    expect(dropdown).toMatch(/modal = true\b/);
    expect(menu).toMatch(/disableOutsidePointerEvents: context\.open,/);
    expect(layer).toContain('ownerDocument.body.style.pointerEvents = "none"');
  });

  it("바깥 누름은 pointerdown에서 바로 닫는다 — 메뉴는 click까지 미루는 옵션을 켜지 않는다", () => {
    expect(layer).toMatch(/deferPointerDownOutside = false/);
    expect(menu).not.toContain("deferPointerDownOutside");
  });
});
