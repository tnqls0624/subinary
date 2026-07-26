"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 당겨서 새로고침
 *
 * 문서 스크롤이 맨 위일 때 아래로 당기면 화면의 **활성 쿼리만** 다시 가져온다.
 * 네이티브 플러그인을 쓰지 않는 순수 웹 구현이라 브라우저와 Capacitor WebView에서
 * 동일하게 동작하고, 네이티브 재빌드 없이 배포된다.
 *
 * 전제: `globals.css`의 `html { overscroll-behavior-y: none }`이 네이티브 바운스를
 * 끈다. 바운스가 살아 있으면 scrollY가 음수로 튀며 제스처가 이중으로 잡힌다.
 *
 * ⚠️ `transform`은 `position: fixed` **후손의 컨테이닝 블록을 만든다**(translateY(0)
 * 이어도 그렇다). 그래서 쉬는 동안에는 transform 자체를 걸지 않고, 자체 fixed 패널을
 * 쓰는 화면(AI 채팅)은 `data-no-pull-refresh`로 제스처에서 제외한다. Radix 다이얼로그는
 * body로 포털되므로 영향받지 않는다.
 * ------------------------------------------------------------------------- */
import { Loader2, ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";

/** 이 거리(px)를 넘겨 놓으면 새로고침이 실행된다. */
const TRIGGER_DISTANCE = 72;
/** 당김 표시의 최대 이동 거리. 이 이상은 늘어나지 않는다. */
const MAX_PULL = 96;
/**
 * 당김 저항. 손가락 이동량을 그대로 반영하면 너무 헐거워 오작동이 잦다.
 * 0.5는 "확실히 당겼다"는 의도가 있어야 임계에 닿는 값.
 */
const RESISTANCE = 0.5;
/** 새로고침이 너무 빨리 끝나면 깜빡임으로 보인다 — 최소 표시 시간. */
const MIN_SPINNER_MS = 400;

/**
 * 제스처를 시작해도 되는 지점인지 판정한다.
 *
 * 거부하는 경우:
 * - 모달이 열려 스크롤이 잠긴 상태(Radix가 body에 `data-scroll-locked`를 건다).
 *   검토 다이얼로그처럼 내부 목록을 스크롤하는 중에 새로고침이 걸리면 안 된다.
 * - 터치 지점의 조상 중 **자체 스크롤러가 이미 내려가 있는** 경우.
 */
function canStartPull(target: EventTarget | null): boolean {
  if (document.body.hasAttribute("data-scroll-locked")) return false;

  let node = target instanceof Element ? target : null;
  while (node && node !== document.body) {
    // 자체 fixed 레이아웃을 쓰는 화면은 명시적으로 제외한다(transform 컨테이닝 블록).
    if (node.hasAttribute("data-no-pull-refresh")) return false;
    const style = window.getComputedStyle(node);
    const scrollable =
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      node.scrollHeight > node.clientHeight;
    if (scrollable && node.scrollTop > 0) return false;
    node = node.parentElement;
  }
  return true;
}

export function PullToRefresh({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // 손가락을 따라가는 중인지. 렌더에 쓰이므로 ref가 아니라 state여야 한다
  // (ref는 리렌더를 일으키지 않아 전환 판정이 한 프레임 어긋난다).
  const [dragging, setDragging] = useState(false);

  // 제스처 상태는 렌더와 무관하므로 ref로 둔다(터치마다 리렌더 방지).
  const startYRef = useRef<number | null>(null);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  const runRefresh = useCallback(async () => {
    refreshingRef.current = true;
    setDragging(false);
    setRefreshing(true);
    setPull(TRIGGER_DISTANCE);
    const startedAt = Date.now();
    try {
      // 화면에 실제로 붙어 있는 쿼리만 다시 가져온다. invalidate와 달리 완료를
      // 기다릴 수 있어 스피너를 정확한 시점에 내릴 수 있다.
      await queryClient.refetchQueries({ type: "active" });
    } catch {
      // 실패는 각 화면의 에러 상태가 이미 표시한다 — 여기서 토스트를 더하지 않는다.
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_SPINNER_MS) {
        await new Promise((r) => setTimeout(r, MIN_SPINNER_MS - elapsed));
      }
      refreshingRef.current = false;
      pullRef.current = 0;
      setRefreshing(false);
      setPull(0);
    }
  }, [queryClient]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const onTouchStart = (event: TouchEvent) => {
      if (refreshingRef.current || event.touches.length !== 1) return;
      if (window.scrollY > 0) return;
      if (!canStartPull(event.target)) return;
      startYRef.current = event.touches[0].clientY;
    };

    const onTouchMove = (event: TouchEvent) => {
      const startY = startYRef.current;
      if (startY === null || refreshingRef.current) return;

      const delta = event.touches[0].clientY - startY;
      if (delta <= 0) {
        // 위로 스크롤하려는 것 — 제스처를 놓아주고 브라우저에 넘긴다.
        if (pullRef.current !== 0) {
          pullRef.current = 0;
          setPull(0);
        }
        setDragging(false);
        startYRef.current = null;
        return;
      }
      // 당기는 동안에만 기본 동작을 막는다(listener가 passive:false여야 유효).
      // 항상 막으면 일반 스크롤이 죽는다.
      event.preventDefault();
      const next = Math.min(delta * RESISTANCE, MAX_PULL);
      pullRef.current = next;
      setPull(next);
      setDragging(true);
    };

    const onTouchEnd = () => {
      if (startYRef.current === null || refreshingRef.current) return;
      startYRef.current = null;
      setDragging(false);
      if (pullRef.current >= TRIGGER_DISTANCE) {
        void runRefresh();
      } else {
        pullRef.current = 0;
        setPull(0);
      }
    };

    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("touchend", onTouchEnd, { passive: true });
    node.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [runRefresh]);

  const armed = pull >= TRIGGER_DISTANCE;
  // 손가락을 따라갈 땐 즉시(전환 없음), 놓은 뒤 복귀할 땐 부드럽게.
  const settling = !dragging;

  return (
    <div ref={containerRef} className="relative">
      {/* 당김 표시 — 콘텐츠 위쪽 바깥에 두고 당긴 만큼 내려온다. */}
      <div
        aria-hidden={pull === 0}
        className="pointer-events-none absolute inset-x-0 -top-12 flex justify-center"
        style={{
          transform: `translateY(${pull}px)`,
          opacity: Math.min(pull / TRIGGER_DISTANCE, 1),
          transition: settling ? "transform 200ms ease-out, opacity 200ms" : "none",
        }}
      >
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "bg-background flex size-9 items-center justify-center rounded-full border shadow-sm",
            armed && !refreshing && "border-primary",
          )}
        >
          {refreshing ? (
            <>
              <Loader2 className="text-primary size-4 animate-spin" aria-hidden="true" />
              <span className="sr-only">새로고침 중</span>
            </>
          ) : (
            <ArrowDown
              className={cn(
                "size-4 transition-transform duration-200",
                armed ? "text-primary rotate-180" : "text-muted-foreground",
              )}
              aria-hidden="true"
            />
          )}
        </span>
      </div>

      {/* pull === 0이면 transform을 아예 걸지 않는다 — translateY(0)만으로도
          fixed 후손의 기준이 뷰포트에서 이 요소로 바뀌어 레이아웃이 깨진다. */}
      <div
        style={
          pull > 0
            ? {
                transform: `translateY(${pull}px)`,
                transition: settling ? "transform 200ms ease-out" : "none",
              }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
