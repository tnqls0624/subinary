/**
 * 떠 있는 메뉴가 상태 표시줄·제스처 바 밑으로 펼쳐지지 않는다(2026-11-09 사용자 지적: 거래 상세 카테고리 맨 위
 * '영양제'가 상태 표시줄 밑에 깔려 눌리지 않았다).
 *
 * node 환경이라 Radix 가 메뉴를 실제로 펼치게 할 수 없다. 그래서
 * - 공용 부품이 Radix 에 넘기는 값은 Portal·Content 를 가짜로 바꿔 붙잡고,
 * - 그 값으로 메뉴가 어디에 놓이는지는 설치된 @floating-ui/core 에 Radix 와 같은 middleware 를 걸어 계산한다
 *   (CSS 로 최대 높이만 깎던 첫 수정이 탭바 위 짧은 메뉴를 짜부라뜨린 것을 이 계산으로 잡는다).
 */
import { createRequire } from "node:module";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

type CapturedProps = { className?: string; collisionPadding?: unknown };

function Captured({ className, collisionPadding }: CapturedProps) {
  return (
    <div
      className={className}
      data-collision={JSON.stringify(collisionPadding ?? null)}
    />
  );
}

vi.mock("@radix-ui/react-dropdown-menu", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@radix-ui/react-dropdown-menu")
  >();
  return {
    ...actual,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: Captured,
  };
});

vi.mock("@radix-ui/react-select", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@radix-ui/react-select")
  >();
  return {
    ...actual,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: Captured,
  };
});

// 공용 부품이 지금 막대 높이를 쓰는지 보려고 훅만 바꿀 수 있게 한다. 나머지는 실제 구현이다.
const hookInsets = vi.hoisted(() => ({ value: { top: 0, bottom: 0 } }));
vi.mock("./menu-edges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./menu-edges")>();
  return { ...actual, useSafeAreaInsets: () => hookInsets.value };
});

const { DropdownMenuContent } = await import("./dropdown-menu");
const { SelectContent } = await import("./select");
const {
  createSafeAreaStore,
  menuCollisionPadding,
  MENU_EDGE_GAP_PX,
  SELECT_EDGE_GAP_PX,
} = await import("./menu-edges");

function captured(markup: string) {
  const className = /class="([^"]*)"/.exec(markup)?.[1] ?? "";
  const collision = /data-collision="([^"]*)"/.exec(markup)?.[1] ?? "null";
  return {
    classes: className.split(/\s+/),
    collision: JSON.parse(collision.replace(/&quot;/g, '"')) as unknown,
  };
}

describe("menuCollisionPadding — 화면 끝 여백 + 시스템 막대", () => {
  it("위·아래에는 막대 높이를 더하고 좌우는 여백만 둔다", () => {
    expect(menuCollisionPadding({ top: 45, bottom: 24 })).toEqual({
      top: MENU_EDGE_GAP_PX + 45,
      right: MENU_EDGE_GAP_PX,
      bottom: MENU_EDGE_GAP_PX + 24,
      left: MENU_EDGE_GAP_PX,
    });
    expect(menuCollisionPadding({ top: 0, bottom: 0 }, 10)).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    });
  });
});

describe("공용 부품은 지금 막대 높이를 Radix collisionPadding 으로 넘긴다", () => {
  it("DropdownMenu: 막대 높이 + 8px, 최대 높이는 Radix 가 잰 남은 높이 그대로", () => {
    hookInsets.value = { top: 45, bottom: 24 };
    const { classes, collision } = captured(
      renderToStaticMarkup(<DropdownMenuContent />)
    );
    expect(collision).toEqual(menuCollisionPadding({ top: 45, bottom: 24 }));
    // CSS 로 막대 높이를 다시 빼면 flip 이 모르는 채로 높이만 깎여 짧은 메뉴가 짜부라진다.
    expect(classes).toContain(
      "max-h-(--radix-dropdown-menu-content-available-height)"
    );
    expect(classes.some((c) => c.includes("--safe-"))).toBe(false);
  });

  it("DropdownMenu: 직접 넘긴 여백은 그대로 따른다", () => {
    hookInsets.value = { top: 45, bottom: 24 };
    const { collision } = captured(
      renderToStaticMarkup(<DropdownMenuContent collisionPadding={16} />)
    );
    expect(collision).toBe(16);
  });

  it("Select: 막대 높이 + 10px(Radix 기본 여백), 최대 높이는 남은 높이 그대로", () => {
    hookInsets.value = { top: 30, bottom: 48 };
    const { classes, collision } = captured(
      renderToStaticMarkup(<SelectContent />)
    );
    expect(collision).toEqual(
      menuCollisionPadding({ top: 30, bottom: 48 }, SELECT_EDGE_GAP_PX)
    );
    expect(classes).toContain(
      "max-h-(--radix-select-content-available-height)"
    );
    expect(classes.some((c) => c.includes("--safe-"))).toBe(false);
  });
});

describe("createSafeAreaStore — 늦게 들어오거나 바뀌는 막대 높이를 따라간다", () => {
  function fakeEnvironment() {
    let value = { top: 0, bottom: 0 };
    let onChange: (() => void) | null = null;
    const env = {
      measures: 0,
      stops: 0,
      measure() {
        env.measures += 1;
        return value;
      },
      watch(cb: () => void) {
        onChange = cb;
        return () => {
          env.stops += 1;
          onChange = null;
        };
      },
      set(next: { top: number; bottom: number }) {
        value = next;
        onChange?.();
      },
      get watching() {
        return onChange != null;
      },
    };
    return env;
  }

  it("처음 구독할 때 재고, 값이 바뀔 때만 알린다", () => {
    const env = fakeEnvironment();
    const store = createSafeAreaStore(env);
    expect(store.getSnapshot()).toEqual({ top: 0, bottom: 0 });

    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(env.measures).toBe(1);
    expect(listener).not.toHaveBeenCalled();

    // Capacitor 가 <html> style 에 안쪽 여백을 늦게 넣는다.
    env.set({ top: 45, bottom: 24 });
    expect(store.getSnapshot()).toEqual({ top: 45, bottom: 24 });
    expect(listener).toHaveBeenCalledTimes(1);

    // 같은 값이면 다시 그리지 않는다(다른 style 변경에도 불린다).
    const snapshot = store.getSnapshot();
    env.set({ top: 45, bottom: 24 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(snapshot);

    unsubscribe();
  });

  it("마지막 구독이 끝나면 듣기를 멈추고, 다시 구독하면 그 사이 값을 새로 잰다", () => {
    const env = fakeEnvironment();
    const store = createSafeAreaStore(env);
    const a = store.subscribe(() => {});
    const b = store.subscribe(() => {});
    expect(env.measures).toBe(1);
    a();
    expect(env.watching).toBe(true);
    b();
    expect(env.watching).toBe(false);
    expect(env.stops).toBe(1);

    env.set({ top: 30, bottom: 0 }); // 아무도 안 들을 때 바뀜
    expect(store.getSnapshot()).toEqual({ top: 0, bottom: 0 });
    const c = store.subscribe(() => {});
    expect(store.getSnapshot()).toEqual({ top: 30, bottom: 0 });
    c();
  });
});

/* ---------------------------------------------------------------------------------------------
 * 위치 계산: 설치된 @floating-ui/core(Radix Popper 가 쓰는 판)에 Radix 와 같은 middleware 를 건다.
 * offset(sideOffset 4) · shift(가로만, limitShift) · flip · size, 여백은 collisionPadding.
 * 메뉴 높이 = min(자연 높이, Radix 가 넘긴 남은 높이) — max-h-(--radix-…-available-height).
 * 열린 뒤 autoUpdate 가 다시 계산하는 것까지 값이 멈출 때까지 되풀이한다.
 * ------------------------------------------------------------------------------------------- */
// web 의 직접 의존이 아니라 타입을 가져올 수 없다 — 여기서 쓰는 부분만 적는다(@floating-ui/core 1.x API).
type Options = Record<string, unknown>;
type FloatingCore = {
  computePosition(
    reference: unknown,
    floating: unknown,
    config: Options,
  ): Promise<{ x: number; y: number; placement: string }>;
  offset(options: Options): unknown;
  shift(options: Options): unknown;
  limitShift(): unknown;
  flip(options: Options): unknown;
  size(
    options: Options & { apply(args: { availableHeight: number }): void },
  ): unknown;
};

function loadFloatingCore(): FloatingCore {
  let req = createRequire(import.meta.url);
  let resolved = "";
  for (const name of [
    "@radix-ui/react-dropdown-menu",
    "@radix-ui/react-menu",
    "@radix-ui/react-popper",
    "@floating-ui/react-dom",
    "@floating-ui/dom",
    "@floating-ui/core",
  ]) {
    resolved = req.resolve(name);
    req = createRequire(resolved);
  }
  return req(resolved) as FloatingCore;
}

const core = loadFloatingCore();

const VIEWPORT = { width: 412, height: 915 };
const ROW = 44; // 메뉴 한 줄(py-2.5 + 본문)
const CHROME = 10; // p-1 위아래 8 + 테두리 2
const menuHeight = (rows: number) => rows * ROW + CHROME;

async function place({
  rows,
  triggerTop,
  padding,
}: {
  rows: number;
  triggerTop: number;
  padding: number | ReturnType<typeof menuCollisionPadding>;
}) {
  const natural = menuHeight(rows);
  const reference = { x: 16, y: triggerTop, width: 380, height: 56 };
  let maxHeight = Number.POSITIVE_INFINITY;
  const height = () => Math.min(natural, maxHeight);
  const platform = {
    getElementRects: async () => ({
      reference,
      floating: { x: 0, y: 0, width: 220, height: height() },
    }),
    getDimensions: async () => ({ width: 220, height: height() }),
    getClippingRect: async () => ({ x: 0, y: 0, ...VIEWPORT }),
  };
  const detect = { padding, boundary: [] as never[], altBoundary: false };
  let last = { y: Number.NaN, height: Number.NaN, placement: "" };
  for (let pass = 0; pass < 6; pass += 1) {
    const result = await core.computePosition({} as never, {} as never, {
      placement: "bottom-start",
      strategy: "fixed",
      platform: platform as never,
      middleware: [
        core.offset({ mainAxis: 4, alignmentAxis: 0 }),
        core.shift({
          mainAxis: true,
          crossAxis: false,
          limiter: core.limitShift(),
          ...detect,
        }),
        core.flip({ ...detect }),
        core.size({
          ...detect,
          apply: ({ availableHeight }) => {
            maxHeight = Math.max(0, availableHeight);
          },
        }),
      ],
    });
    const next = { y: result.y, height: height(), placement: result.placement };
    if (
      next.y === last.y &&
      next.height === last.height &&
      next.placement === last.placement
    ) {
      break;
    }
    last = next;
  }
  return {
    top: last.y,
    bottom: last.y + last.height,
    height: last.height,
    natural,
  };
}

const DEVICES = [
  { name: "제스처 내비", insets: { top: 45, bottom: 24 } },
  { name: "3버튼 내비", insets: { top: 45, bottom: 48 } },
];
// 트리거 위끝 위치: 헤더(가족 전환)·위쪽 목록·가운데·거래 상세 아래쪽 줄·탭바 바로 위 줄.
const TRIGGERS = [60, 200, 450, 700, 760, 790, 805];
const MENUS = [1, 2, 3, 7, 17];

describe("메뉴 위치(floating-ui 계산) — 시스템 막대 밖, 한 줄 이상 보인다", () => {
  for (const device of DEVICES) {
    for (const gap of [MENU_EDGE_GAP_PX, SELECT_EDGE_GAP_PX]) {
      it(`${device.name}, 여백 ${gap}px: 모든 메뉴 길이·트리거 위치에서 막대를 침범하지 않는다`, async () => {
        const padding = menuCollisionPadding(device.insets, gap);
        for (const rows of MENUS) {
          for (const triggerTop of TRIGGERS) {
            const at = await place({ rows, triggerTop, padding });
            const label = `rows=${rows} triggerTop=${triggerTop} → ${JSON.stringify(
              at
            )}`;
            expect(at.top, label).toBeGreaterThanOrEqual(device.insets.top);
            expect(at.bottom, label).toBeLessThanOrEqual(
              VIEWPORT.height - device.insets.bottom
            );
            // 짜부라지지 않는다: 메뉴가 한 줄이면 다 보이고, 길면 적어도 몇 줄은 보인다.
            expect(at.height, label).toBeGreaterThanOrEqual(
              Math.min(at.natural, menuHeight(3))
            );
          }
        }
      });
    }
  }

  it("대조: 여백 0(고치기 전)이면 거래 상세 아래쪽 줄에서 연 17줄 메뉴의 첫 줄이 상태 표시줄 밑에 깔린다", async () => {
    const at = await place({ rows: 17, triggerTop: 700, padding: 0 });
    expect(at.top).toBeLessThan(45);
  });
});
