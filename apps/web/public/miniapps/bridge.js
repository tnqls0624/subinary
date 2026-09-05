/* ---------------------------------------------------------------------------
 * 미니앱 브릿지 클라이언트 — 모든 미니앱이 공유한다.
 *
 * 미니앱은 `<iframe sandbox="allow-scripts">` 안의 별도 문서라 호스트의 모듈을
 * import할 수 없다. 하지만 **같은 문서가 로드하는 스크립트는 제한되지 않으므로**
 * 이 파일을 `<script src="../bridge.js">`로 불러 쓴다.
 *
 * 처음 두 미니앱은 이 코드를 각자 인라인으로 복제했다. 셋째가 생기는 시점에 공유
 * 파일로 뺀다 — 계약이 바뀔 때 고칠 곳이 하나여야 한다.
 *
 * 계약의 단일 출처는 `packages/shared/src/miniapp-bridge.ts`이고, 그쪽 테스트가
 * 메시지 모양을 고정한다. 이 파일은 그 계약을 쓰는 클라이언트다.
 * ------------------------------------------------------------------------- */
(() => {
  "use strict";

  const BRIDGE_VERSION = 1;
  const TIMEOUT_MS = 8000;

  /**
   * 호스트에 요청을 보내고 응답을 기다린다.
   *
   * 타임아웃이 필수인 이유: 호스트가 답하지 않는 경우가 실제로 있다(브릿지 버전
   * 불일치, 호스트 화면 언마운트, 처리 중 크래시). 없으면 `await`가 영원히 걸리고
   * 게임은 로딩 상태로 멈춘 채 아무 말도 하지 않는다.
   */
  function invoke(method, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `r${Date.now()}${Math.random().toString(36).slice(2)}`;
      let done = false;

      const finish = (fn) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        fn();
      };

      const onMessage = (event) => {
        const d = event.data;
        // 요청 id로 짝짓는다 — 여러 요청이 동시에 나가고 응답 순서가 다를 수 있다.
        if (!d || d.kind !== "response" || d.requestId !== requestId) return;
        finish(() =>
          d.ok ? resolve(d.data) : reject(new Error(d.error?.code ?? "host_error")),
        );
      };

      const timer = setTimeout(
        () => finish(() => reject(new Error("timeout"))),
        TIMEOUT_MS,
      );

      window.addEventListener("message", onMessage);
      // sandbox iframe에서 부모 origin을 알 수 없어 targetOrigin은 `*`뿐이다.
      // 대신 요청에 민감한 값을 담지 않는다 — 파라미터는 키·기간 같은 좌표뿐이고
      // 데이터는 응답으로만 온다.
      window.parent.postMessage(
        { v: BRIDGE_VERSION, kind: "request", requestId, method, params },
        "*",
      );
    });
  }

  /**
   * 상태 저장 헬퍼 — 거의 모든 게임이 최고 기록을 남긴다.
   *
   * 실패를 삼킨다. 저장이 안 되는 것은 게임을 멈출 이유가 아니고, 다음 수에서 다시
   * 저장된다. 반대로 읽기 실패는 `null`로 돌려 "기록 없음"과 같이 다룬다.
   */
  const state = {
    async get(key) {
      try {
        const res = await invoke("state.get", { key });
        return res?.state ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      return invoke("state.set", { key, state: value }).catch(() => {});
    },
  };

  window.MiniApp = { invoke, state, BRIDGE_VERSION };
})();
