"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { PageBackHeader } from "@/components/widgets";
import { MiniappHost, type MiniappHostProps } from "./miniapp-host";

/**
 * 부모의 탭·시각 뷰포트·실제 시작점을 측정한 뒤 게임을 노출한다.
 *
 * `height`는 고정 높이가 아니라 **상한**이다. 등록부(`miniapp-registry`)가 주는 값을
 * 그대로 상한으로 쓰므로 여기에 숫자를 다시 적지 않는다 — 두 곳에 적으면 등록부를
 * 고쳐도 화면이 안 바뀌는 드리프트가 생긴다.
 */
export function BackyardViewport({ subtitle, height: maxHeight = 520, ...props }: MiniappHostProps & { subtitle: string }) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ height: number; paused: boolean } | null>(null);
  useLayoutEffect(() => {
    const container = root.current, title = heading.current, anchor = slot.current;
    if (!container || !title || !anchor) return;
    const viewport = window.visualViewport;
    const nav = document.querySelector<HTMLElement>("[data-bottom-nav]");
    const measure = (): void => {
      // 먼저 원래 제목/여백으로 재어 회전 후에도 접힘 상태가 고착되지 않게 한다.
      title.hidden = false;
      container.style.marginTop = "";
      const available = (): number => {
        const visualBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
        const tab = nav?.getBoundingClientRect();
        const bottom = tab && tab.height > 0 ? Math.min(tab.top, visualBottom) : visualBottom;
        return Math.max(0, Math.floor(Math.min(maxHeight, bottom - anchor.getBoundingClientRect().top - 16)));
      };
      let height = available();
      if (height < 300) {
        title.hidden = true;
        container.style.marginTop = "-16px";
        height = available();
      }
      const paused = height < 300;
      setLayout(previous => previous?.height === height && previous.paused === paused ? previous : { height, paused });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (nav) observer.observe(nav);
    const header = document.querySelector("body header");
    if (header) observer.observe(header);
    observer.observe(container);
    const mutations = new MutationObserver(measure);
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("scroll", measure, { passive: true });
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect(); mutations.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("scroll", measure);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
    };
  }, [maxHeight]);
  return <div ref={root}>
    <div ref={heading} style={{ marginBottom: 16 }}><PageBackHeader title={props.title} subtitle={subtitle} /></div>
    <div ref={slot} style={{ position: "relative", height: layout?.height ?? 0, overflow: "hidden" }}>
      {layout && <MiniappHost {...props} height={layout.height} paused={layout.paused} />}
      {layout?.paused && <div role="status" className="bg-background absolute inset-0 flex items-center justify-center p-4 text-center">세로로 돌려서 계속하기</div>}
    </div>
  </div>;
}
