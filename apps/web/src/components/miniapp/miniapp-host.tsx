"use client";
import { useCallback, useEffect, useRef } from "react";
import { createMiniappHostRuntime, type MiniappHandlers } from "@/lib/miniapp-host";
export type { MiniappHandler } from "@/lib/miniapp-host";

export interface MiniappHostProps {
  appKey: string;
  src: string;
  permissions: readonly string[];
  handlers: MiniappHandlers;
  height?: number;
  title: string;
}

/** allow-scripts만 허용하는 미니앱 호스트. 가구·앱 경계는 부모의 key로 재생성한다. */
export function MiniappHost({ appKey, src, permissions, handlers, height = 480, title }: MiniappHostProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const runtimeRef = useRef<ReturnType<typeof createMiniappHostRuntime> | null>(null);
  const hasLoaded = useRef(false);
  useEffect(() => {
    const runtime = createMiniappHostRuntime({ appKey, permissions,
      getFrame: () => frameRef.current?.contentWindow ?? null,
      getHandlers: () => handlersRef.current });
    runtimeRef.current = runtime;
    const onMessage = (event: MessageEvent): void => { void runtime.receive(event); };
    window.addEventListener("message", onMessage);
    if (hasLoaded.current) runtime.loaded();
    return () => {
      runtime.destroy();
      runtimeRef.current = null;
      window.removeEventListener("message", onMessage);
    };
  }, [appKey, permissions, src]);
  const onLoad = useCallback(() => {
    hasLoaded.current = true;
    runtimeRef.current?.loaded();
  }, []);
  return <iframe ref={frameRef} src={src} sandbox="allow-scripts" onLoad={onLoad}
    title={title} className="bg-background w-full rounded-xl border" style={{ height }}
    allow="" referrerPolicy="no-referrer" />;
}
