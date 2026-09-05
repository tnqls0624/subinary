/**
 * 미니앱 SDK — **미니앱 쪽**에서 쓰는 브릿지 클라이언트.
 *
 * ⚠️ `packages/shared`가 아니라 여기 있는 이유: 이 코드는 `window`·`EventListener`를
 * 쓰는 **브라우저 전용**이고, shared는 워커·API도 쓰는 공용 패키지라 DOM 타입이 없다.
 * shared에 두면 tsup DTS 빌드가 터진다(typecheck는 통과하므로 배포에서만 드러난다).
 *
 * 지금 실제 미니앱(`public/miniapps/*`)은 이 코드를 **인라인으로 복제**한다 — iframe은
 * 별도 문서라 import할 수 없기 때문이다. 미니앱이 늘어 번들 빌드가 생기면 그때 이
 * 파일을 진입점으로 쓴다. 계약 자체는 `miniapp-bridge.ts`가 단일 출처다.
 *
 * 토스의 `window.AIT.invoke('method', params)`에 해당한다. 미니앱은 이것만 import하면
 * 호스트와 대화할 수 있고, 그 밖의 방법은 없다(iframe이 격리돼 있다).
 *
 * ## 왜 SDK가 필요한가
 *
 * `postMessage`를 직접 쓰면 미니앱마다 요청/응답 짝짓기, 타임아웃, 오류 분기를 다시
 * 구현하게 된다. 그 구현이 조금씩 다르면 "이 미니앱만 가끔 멈춘다" 같은 문제가 생기고,
 * 원인을 미니앱마다 따로 찾아야 한다.
 *
 * ## 타임아웃이 필수인 이유
 *
 * 호스트가 응답하지 않는 경우가 실제로 있다 — 브릿지 버전이 어긋나 리스너가 아예 없거나,
 * 호스트 화면이 언마운트됐거나, 호스트가 처리 중 크래시한 경우다. 타임아웃이 없으면
 * 미니앱의 `await`가 영원히 걸리고 화면은 로딩 상태로 멈춘 채 아무 말도 하지 않는다.
 */
import {
  MINIAPP_BRIDGE_VERSION,
  type MiniappErrorCode,
  type MiniappMethod,
  type MiniappResponse,
} from '@family/shared';

/** 호스트 응답이 오류일 때 던지는 예외. 코드로 분기할 수 있다. */
export class MiniappBridgeError extends Error {
  constructor(
    readonly code: MiniappErrorCode | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'MiniappBridgeError';
  }
}

export interface MiniappClientOptions {
  /**
   * 응답 대기 상한(ms).
   *
   * 8초로 둔다 — 토스 게임 가이드가 요구하는 "인터랙션 2초 이내"보다 넉넉하되,
   * 사용자가 "멈췄다"고 느끼기 전에는 끝나야 한다.
   */
  timeoutMs?: number;
  /** 테스트 주입용. 기본은 브라우저 전역. */
  target?: Pick<Window, 'postMessage'>;
  source?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** 요청 id 생성기. 기본은 crypto.randomUUID. */
  createId?: () => string;
}

/**
 * 미니앱에서 호스트를 호출하는 클라이언트.
 *
 * ```ts
 * const host = createMiniappClient();
 * const { totalNet } = await host.invoke('spend.summary', { from, to });
 * ```
 */
export function createMiniappClient(options: MiniappClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const target =
    options.target ??
    // 미니앱은 iframe 안이므로 부모가 호스트다.
    (typeof window !== 'undefined' ? window.parent : undefined);
  const source =
    options.source ?? (typeof window !== 'undefined' ? window : undefined);
  const createId =
    options.createId ??
    (() =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `r${Date.now()}${Math.random().toString(36).slice(2)}`);

  async function invoke<T = unknown>(
    method: MiniappMethod,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!target || !source) {
      throw new MiniappBridgeError('host_error', '호스트가 없습니다(브라우저 밖).');
    }
    const requestId = createId();

    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        source.removeEventListener('message', onMessage as EventListener);
        fn();
      };

      const onMessage = (event: MessageEvent) => {
        const data = event.data as MiniappResponse | undefined;
        if (
          typeof data !== 'object' ||
          data === null ||
          data.kind !== 'response' ||
          // **요청 id로 짝짓는다.** 미니앱이 여러 요청을 동시에 보낼 수 있고 응답
          // 순서가 요청 순서와 다를 수 있다.
          data.requestId !== requestId
        ) {
          return;
        }
        finish(() => {
          if (data.ok) resolve(data.data as T);
          else reject(new MiniappBridgeError(data.error.code, data.error.message));
        });
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new MiniappBridgeError(
              'timeout',
              `호스트가 ${timeoutMs}ms 안에 답하지 않았어요.`,
            ),
          ),
        );
      }, timeoutMs);

      source.addEventListener('message', onMessage as EventListener);
      // sandbox iframe에서 부모로 보낼 때 targetOrigin은 `*`뿐이다 — 부모 origin을
      // 알 수 없기 때문이다. 대신 **민감한 값을 요청에 담지 않는다**(파라미터는
      // 기간·키 같은 좌표뿐이고, 데이터는 응답으로만 온다).
      target.postMessage(
        { v: MINIAPP_BRIDGE_VERSION, kind: 'request', requestId, method, params },
        '*',
      );
    });
  }

  return { invoke };
}
