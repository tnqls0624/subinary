"use client";
/* ---------------------------------------------------------------------------
 * 미니앱 호스트 — iframe 격리 실행 + 브릿지
 *
 * ## 격리가 어떻게 성립하나
 *
 * `sandbox="allow-scripts"`만 준다. **`allow-same-origin`을 주지 않는 것이 핵심이다** —
 * 그러면 같은 도메인에서 서빙해도 브라우저가 iframe을 고유한 불투명 origin으로 다루고,
 * 미니앱은 호스트의 쿠키·localStorage·DOM·토큰에 접근할 수 없다.
 *
 * 그 둘을 함께 주면(`allow-scripts allow-same-origin`) 샌드박스가 사실상 해제된다 —
 * 미니앱 스크립트가 부모 문서를 그대로 만질 수 있다. 이 조합은 절대 쓰지 않는다.
 *
 * 대가는 미니앱이 아무것도 스스로 못 한다는 것이고, 그래서 브릿지가 필요하다.
 *
 * ## postMessage를 왜 두 겹으로 검증하나
 *
 * `message` 이벤트는 누구나 보낸다 — iframe 안의 미니앱뿐 아니라 브라우저 확장,
 * 다른 탭, 광고 스크립트도 보낸다. 그래서
 *
 *   1. `event.source`가 **이 iframe의 contentWindow인지** 확인하고,
 *   2. 메시지 모양이 계약과 맞는지 확인한다.
 *
 * 둘 중 하나만으로는 부족하다. source만 보면 미니앱이 보낸 쓰레기를 처리하게 되고,
 * 모양만 보면 다른 창이 보낸 요청을 이 미니앱의 것으로 처리한다.
 *
 * `event.origin`으로는 판정할 수 없다 — sandbox iframe의 origin은 `"null"`이다.
 * 그것이 격리가 되고 있다는 증거이지 검증 수단이 아니다.
 * ------------------------------------------------------------------------- */
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  MINIAPP_BRIDGE_VERSION,
  checkMiniappRequest,
  isMiniappRequest,
  miniappError,
  miniappOk,
  type MiniappErrorCode,
  type MiniappMethod,
} from "@family/shared";

/** 브릿지 메서드 하나를 실제로 수행하는 함수. 호스트 화면이 주입한다. */
export type MiniappHandler = (
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface MiniappHostProps {
  /** 미니앱 식별자 — 상태 격리 키이자 로그 식별자. */
  appKey: string;
  /** 미니앱 번들 진입 URL. */
  src: string;
  /** manifest가 선언한 권한. 선언하지 않은 메서드는 브릿지가 막는다. */
  permissions: readonly string[];
  /** 메서드 구현. 없는 메서드는 `unknown_method`가 아니라 `host_error`가 된다. */
  handlers: Partial<Record<MiniappMethod, MiniappHandler>>;
  /** iframe 높이(px). 미니앱이 스스로 크기를 못 바꾸므로 호스트가 정한다. */
  height?: number;
  title: string;
}

export function MiniappHost({
  appKey,
  src,
  permissions,
  handlers,
  height = 480,
  title,
}: MiniappHostProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // 핸들러가 매 렌더 새 객체로 와도 effect를 다시 걸지 않는다. 리스너가 재등록되는
  // 사이에 도착한 메시지는 사라지고, 그 증상은 "가끔 응답이 없다"로만 보인다.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const permissionsRef = useRef(permissions);
  permissionsRef.current = permissions;

  const post = useCallback((message: unknown) => {
    // sandbox iframe의 origin은 `"null"`이라 targetOrigin으로 좁힐 수 없다.
    // 대신 **이 iframe의 contentWindow에만** 보낸다 — 창을 특정하는 것이 origin을
    // 특정하는 것과 같은 역할을 한다.
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      // 1겹: 이 iframe이 보낸 것인가.
      if (
        !frameRef.current ||
        event.source !== frameRef.current.contentWindow
      ) {
        return;
      }
      // 2겹: 계약에 맞는 모양인가.
      if (!isMiniappRequest(event.data)) return;

      const request = event.data;
      const check = checkMiniappRequest(request, permissionsRef.current);
      if (!check.ok) {
        post(miniappError(request.requestId, check.code, check.message));
        return;
      }

      const handler = handlersRef.current[check.method];
      if (!handler) {
        // 계약에는 있는데 이 화면이 구현하지 않은 메서드. 미니앱 잘못이 아니므로
        // `unknown_method`가 아니라 호스트 오류로 답한다.
        post(
          miniappError(
            request.requestId,
            "host_error" satisfies MiniappErrorCode,
            `호스트가 ${check.method}를 제공하지 않습니다.`,
          ),
        );
        return;
      }

      try {
        const data = await handler(request.params ?? {});
        post(miniappOk(request.requestId, data));
      } catch (error) {
        // 미니앱에 내부 사정을 흘리지 않는다 — 스택이나 SQL이 담긴 메시지가
        // 미니앱을 거쳐 화면에 뜨면 그것 자체가 누출이다.
        post(
          miniappError(
            request.requestId,
            "host_error",
            error instanceof Error && error.message.length < 200
              ? error.message
              : "요청을 처리하지 못했어요",
          ),
        );
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post]);

  // 미니앱이 부팅 직후 호스트를 알 수 있게 한다. 미니앱이 먼저 물어보게 하면
  // 그 요청이 리스너 등록 전에 도착할 수 있다.
  const onLoad = useCallback(() => {
    post({
      v: MINIAPP_BRIDGE_VERSION,
      kind: "ready",
      appKey,
      permissions: [...permissionsRef.current],
    });
  }, [appKey, post]);

  const sandbox = useMemo(
    () =>
      // ⛔ `allow-same-origin`을 절대 더하지 말 것. `allow-scripts`와 함께 주면
      // 샌드박스가 사실상 해제되어 미니앱이 부모 문서를 만질 수 있다.
      "allow-scripts",
    [],
  );

  return (
    <iframe
      ref={frameRef}
      src={src}
      sandbox={sandbox}
      onLoad={onLoad}
      title={title}
      className="bg-background w-full rounded-xl border"
      style={{ height }}
      // 미니앱에 카메라·마이크·위치를 주지 않는다. 필요해지면 권한 모델을 통해
      // 열되, 기본은 닫혀 있어야 한다.
      allow=""
      referrerPolicy="no-referrer"
    />
  );
}
