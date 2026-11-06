"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/*
 * 터치·펜은 손을 뗄 때 연다(2026-11-06 사용자 지적: 값 고르기 줄에 스크롤하려고 손가락을 대면 메뉴가 바로 열린다 —
 * "거래 상세만이 아니고 전체적으로 다 그래"). Radix DropdownMenu Trigger는 터치에서도 pointerdown에 연다.
 * 손가락을 대고 밀면 브라우저가 pointercancel을 보내고 click은 보내지 않으므로, 열기를 click으로 미루면
 * 스크롤로 이어진 터치에는 열리지 않는다. 다만 가로 칩 줄처럼 세로 페이지 스크롤과 겹치면 pointercancel이
 * 안 오고 click만 남는 경우가 있어(SOO-46), 손가락이 조금 움직이면 미뤄 둔 터치를 버린다.
 * 마우스는 지금처럼 누르는 순간, 키보드(Enter·Space·↓)는 Radix가 keydown에서 연다.
 * 이 파일의 DropdownMenu·DropdownMenuTrigger를 쓰는 모든 메뉴(값 고르기·⋯·가족 전환·역할·색)가 같다.
 * Radix Select는 이미 터치에서 click에 연다(react-select의 pointerTypeRef) — 거기는 손대지 않는다.
 */

/** 누른 자리에서 이만큼 넘게 움직이면 탭이 아니라 스크롤·스와이프로 본다(px). */
export const RELEASE_OPEN_SLOP_PX = 10;

/** 트리거를 누른 한 순간. click의 pointerType은 pointerdown에서 미뤄 둔 터치·펜의 종류다(없으면 null). */
export type DropdownPress =
  | { moment: "pointerdown"; pointerType: string }
  | { moment: "click"; pointerType: string | null; detail: number };

/**
 * 이 순간에 메뉴를 여는지. 잠겨 있으면 어느 순간에도 열지 않는다.
 * - pointerdown: 마우스만 연다(Radix 기본 그대로). 터치·펜은 click까지 미룬다.
 * - click: 미뤄 둔 터치·펜이 있고 실제로 누른 click(detail ≥ 1)일 때만 연다. 키보드 Enter·Space가 만드는
 *   click은 detail 0이다 — Radix가 keydown에서 이미 토글했으니 여기서 또 열면 두 번 토글된다.
 */
export function dropdownOpensAt(
  press: DropdownPress,
  { disabled }: { disabled: boolean },
): boolean {
  if (disabled) return false;
  if (press.moment === "pointerdown") return press.pointerType === "mouse";
  return (
    press.pointerType != null &&
    press.pointerType !== "mouse" &&
    press.detail > 0
  );
}

/** pointerdown에서 미뤄 둔 터치·펜. 메뉴가 어떤 길로든 열리거나 닫히면 지운다(`DropdownMenu`). */
type PendingTouch = { pointerType: string; x: number; y: number };
type PendingPress = { current: PendingTouch | null };

/** 트리거에 붙는 '뗄 때 열기' 처리. 넘긴 사용처의 핸들러 뒤, Radix 처리 앞에서 돈다. */
export function releaseOpenHandlers(
  pending: PendingPress,
  { disabled, openMenu }: { disabled: boolean; openMenu: () => void },
) {
  return {
    onPointerDown(event: {
      pointerType: string;
      clientX: number;
      clientY: number;
      preventDefault(): void;
    }) {
      pending.current = null;
      // 잠김은 Radix도 열지 않고, 마우스는 Radix가 누르는 순간 연다 — 둘 다 건드리지 않는다.
      if (disabled) return;
      if (
        dropdownOpensAt(
          { moment: "pointerdown", pointerType: event.pointerType },
          { disabled },
        )
      ) {
        return;
      }
      // Radix Trigger는 이 onPointerDown을 먼저 부르고, 기본 동작이 막혔으면 자기 처리(바로 열기)를 건너뛴다
      // (@radix-ui/primitive composeEventHandlers). pointerdown을 막아도 스크롤과 click은 그대로 온다.
      event.preventDefault();
      pending.current = {
        pointerType: event.pointerType,
        x: event.clientX,
        y: event.clientY,
      };
    },
    onPointerMove(event: {
      isPrimary: boolean;
      clientX: number;
      clientY: number;
    }) {
      const start = pending.current;
      if (start == null || !event.isPrimary) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.hypot(dx, dy) > RELEASE_OPEN_SLOP_PX) {
        pending.current = null;
      }
    },
    onPointerCancel() {
      pending.current = null;
    },
    onClick(event: { detail: number }) {
      const pointerType = pending.current?.pointerType ?? null;
      pending.current = null;
      if (
        dropdownOpensAt(
          { moment: "click", pointerType, detail: event.detail },
          { disabled },
        )
      ) {
        openMenu();
      }
    },
  };
}

/** 사용처 핸들러를 먼저 부르고, 그쪽이 기본 동작을 막지 않았을 때만 우리 처리를 부른다(Radix와 같은 규칙). */
function composeHandlers<E extends { defaultPrevented: boolean }>(
  theirs: ((event: E) => void) | undefined,
  ours: ((event: E) => void) | undefined,
): ((event: E) => void) | undefined {
  if (!ours) return theirs;
  return (event) => {
    theirs?.(event);
    if (!event.defaultPrevented) ours(event);
  };
}

const ReleaseOpenContext = React.createContext<{
  pending: PendingPress;
  openMenu: () => void;
} | null>(null);

function DropdownMenu({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  // 트리거가 click에서 직접 열어야 해서 열림 상태를 여기서 쥔다. open을 넘기면 그 값을 따르고(제어), 아니면 스스로 쥔다.
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(
    defaultOpen ?? false,
  );
  const open = openProp ?? uncontrolledOpen;
  const pending = React.useRef<PendingTouch | null>(null);
  const setOpen = React.useCallback(
    (next: boolean) => {
      // 어떤 길로든(키보드·마우스·바깥 누름·고르기) 열리거나 닫히면 미뤄 둔 터치를 지운다. 열린 채 트리거를
      // 다시 탭하면 모달 메뉴의 바깥 pointerdown이 먼저 닫으므로(그동안 트리거는 pointer-events: none),
      // 뒤따르는 click이 메뉴를 다시 열지 않는다.
      pending.current = null;
      if (next === open) return;
      if (openProp === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [open, openProp, onOpenChange],
  );
  const release = React.useMemo(
    () => ({ pending, openMenu: () => setOpen(true) }),
    [setOpen],
  );
  return (
    <ReleaseOpenContext.Provider value={release}>
      <DropdownMenuPrimitive.Root
        data-slot="dropdown-menu"
        {...props}
        open={open}
        onOpenChange={setOpen}
      />
    </ReleaseOpenContext.Provider>
  );
}

function DropdownMenuTrigger({
  onPointerDown,
  onPointerMove,
  onPointerCancel,
  onClick,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const release = React.useContext(ReleaseOpenContext);
  // 이 파일의 DropdownMenu 밖(Radix Root를 직접 쓴 곳)에서는 click에서 열 길이 없으니 Radix 기본을 그대로 둔다.
  const handlers = release
    ? releaseOpenHandlers(release.pending, {
        disabled: Boolean(props.disabled),
        openMenu: release.openMenu,
      })
    : null;
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
      onPointerDown={composeHandlers<React.PointerEvent<HTMLButtonElement>>(
        onPointerDown,
        handlers?.onPointerDown,
      )}
      onPointerMove={composeHandlers<React.PointerEvent<HTMLButtonElement>>(
        onPointerMove,
        handlers?.onPointerMove,
      )}
      onPointerCancel={composeHandlers<React.PointerEvent<HTMLButtonElement>>(
        onPointerCancel,
        handlers?.onPointerCancel,
      )}
      onClick={composeHandlers<React.MouseEvent<HTMLButtonElement>>(
        onClick,
        handlers?.onClick,
      )}
    />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-control border p-1 shadow-md",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>,
) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

/**
 * 메뉴 줄 공통: 누르는 높이 44, 본문 글자, 컨트롤 모서리. 하이라이트(키보드·마우스 focus, 손가락 active)는 muted.
 * 다크에서는 --popover와 --muted가 거의 같은 색(1.01:1)이라 글자색 10%를 깐다.
 */
const MENU_ITEM =
  "relative flex min-h-11 cursor-default items-center gap-2 rounded-control text-body outline-hidden select-none focus:bg-muted active:bg-muted dark:focus:bg-foreground/10 dark:active:bg-foreground/10 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        MENU_ITEM,
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground px-3 py-2 data-[inset]:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(MENU_ITEM, "py-2 pr-3 pl-8", className)}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>,
) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(MENU_ITEM, "py-2 pr-3 pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "text-muted-foreground text-caption px-3 py-1.5 font-medium data-[inset]:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "text-muted-foreground text-caption ml-auto tracking-widest",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
};
