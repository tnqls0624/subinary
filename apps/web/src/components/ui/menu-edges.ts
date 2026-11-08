import { useSyncExternalStore } from "react";

/**
 * 떠 있는 메뉴(DropdownMenu·Select)가 화면 가장자리에서 지킬 거리.
 *
 * 앱은 상태 표시줄·제스처 바 밑까지 그린다(viewport-fit=cover, 헤더가 --safe-top 만큼 띄운다). Radix 는
 * 화면 전체를 기준으로 메뉴를 펼치므로, 길어서 위로 열린 메뉴의 첫 줄이 상태 표시줄 밑에 깔리고 그 자리의
 * 터치는 시스템이 가져갔다 — 2026-11-09 사용자 지적: 거래 상세 카테고리 맨 위 '영양제'가 눌리지 않는다
 * (드롭다운 collisionPadding 0 → 메뉴가 y=0 까지 올라갔다). 아래로 열린 메뉴의 끝 줄은 제스처 바에 깔린다.
 *
 * 상태 표시줄·제스처 바 높이를 px 로 재서 Radix collisionPadding 에 더한다. 그래야 위/아래 방향 고르기(flip)와
 * 남은 높이(size)가 둘 다 막대를 안다. CSS 로 최대 높이에서만 빼면 flip 이 막대를 모른 채 '아래에 들어간다'고
 * 고른 뒤 높이만 깎여, 탭바 바로 위에서 연 짧은 메뉴가 줄 하나도 안 보이게 짜부라졌다(검토에서 재현).
 */

export type SafeAreaInsets = { readonly top: number; readonly bottom: number };

export const NO_INSETS: SafeAreaInsets = Object.freeze({ top: 0, bottom: 0 });

/** 드롭다운이 시스템 막대와 별개로 화면 끝에서 띄우는 거리(px). */
export const MENU_EDGE_GAP_PX = 8;
/** Select 는 Radix 기본(CONTENT_MARGIN 10)을 지킨다 — 위로 열리면 translate-y-1 만큼 더 붙는다. */
export const SELECT_EDGE_GAP_PX = 10;

export type MenuCollisionPadding = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export function menuCollisionPadding(
  insets: SafeAreaInsets,
  gap: number = MENU_EDGE_GAP_PX
): MenuCollisionPadding {
  return {
    top: gap + insets.top,
    right: gap,
    bottom: gap + insets.bottom,
    left: gap,
  };
}

/** 안쪽 여백을 재는 방법과 바뀌는 순간을 듣는 방법. 테스트는 가짜를 넣는다. */
export type SafeAreaEnvironment = {
  measure(): SafeAreaInsets;
  watch(onChange: () => void): () => void;
};

/**
 * 안쪽 여백 저장소. 처음 구독할 때 재고 듣기 시작하며, 값이 실제로 바뀔 때만 알린다.
 * 마지막 구독이 끝나면 듣기를 멈추고, 다시 구독하면 그 사이 바뀐 값을 새로 잰다.
 */
export function createSafeAreaStore(env: SafeAreaEnvironment) {
  let current: SafeAreaInsets = NO_INSETS;
  const listeners = new Set<() => void>();
  let stopWatching: (() => void) | null = null;

  const refresh = () => {
    const next = env.measure();
    if (next.top === current.top && next.bottom === current.bottom) return;
    current = Object.freeze({ top: next.top, bottom: next.bottom });
    for (const listener of [...listeners]) listener();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (stopWatching == null) {
        stopWatching = env.watch(refresh);
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopWatching != null) {
          stopWatching();
          stopWatching = null;
        }
      };
    },
    getSnapshot(): SafeAreaInsets {
      return current;
    },
  };
}

function toPx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 브라우저: globals.css 의 --safe-top/--safe-bottom(env() 와 Capacitor 가 넣는 --safe-area-inset-* 중 큰 값)을
 * 안쪽 여백으로 받은 보이지 않는 탐침으로 잰다. Capacitor 는 이 값을 <html> style 에 늦게 넣거나 키보드가 뜨면
 * 바꾸므로 그 style 변경과 화면 크기 변경을 듣는다.
 */
function browserEnvironment(): SafeAreaEnvironment {
  let probe: HTMLElement | null = null;
  return {
    measure() {
      if (typeof document === "undefined" || document.body == null) {
        return NO_INSETS;
      }
      if (probe == null || !probe.isConnected) {
        probe = document.createElement("div");
        probe.setAttribute("aria-hidden", "true");
        probe.style.cssText =
          "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;" +
          "padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)";
        document.body.appendChild(probe);
      }
      const style = getComputedStyle(probe);
      return { top: toPx(style.paddingTop), bottom: toPx(style.paddingBottom) };
    },
    watch(onChange) {
      if (typeof window === "undefined") return () => {};
      window.addEventListener("resize", onChange);
      window.addEventListener("orientationchange", onChange);
      const observer =
        typeof MutationObserver === "undefined"
          ? null
          : new MutationObserver(() => onChange());
      observer?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
      return () => {
        window.removeEventListener("resize", onChange);
        window.removeEventListener("orientationchange", onChange);
        observer?.disconnect();
        probe?.remove();
        probe = null;
      };
    },
  };
}

const safeAreaStore = createSafeAreaStore(browserEnvironment());

/** 지금 상태 표시줄·제스처 바 높이(px). 서버 렌더와 첫 하이드레이션에서는 0. */
export function useSafeAreaInsets(): SafeAreaInsets {
  return useSyncExternalStore(
    safeAreaStore.subscribe,
    safeAreaStore.getSnapshot,
    () => NO_INSETS
  );
}
