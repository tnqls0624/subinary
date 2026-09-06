/**
 * 미니앱 브릿지 계약 — 호스트와 미니앱이 주고받는 유일한 통로.
 *
 * ## 왜 브릿지인가
 *
 * 미니앱은 `<iframe sandbox="allow-scripts">` 안에서 돈다. `allow-same-origin`을 주지
 * **않으므로** 같은 도메인에서 서빙해도 미니앱은 호스트의 쿠키·localStorage·DOM에
 * 접근할 수 없다. 브라우저가 막는다.
 *
 * 그래서 미니앱이 무언가를 하려면 **반드시 호스트에게 물어야** 하고, 호스트는 물어본
 * 것만 검증해서 답한다. 토스가 `window.AIT.invoke('method', params)` 하나로 여는 통로와
 * 같은 구조다.
 *
 * 이 설계의 값은 "미니앱을 믿지 않아도 된다"는 것이다. 미니앱 코드가 무엇을 하든
 * 브릿지가 허락한 것 이상은 할 수 없다.
 *
 * ## 권한
 *
 * 미니앱은 manifest에 필요한 권한을 선언하고, 호스트는 **선언한 것만** 허용한다.
 * 순수 게임은 권한 0개로 돌고(자기 상태 저장만), 지출 기반 게임은 읽기 권한을 받는다.
 *
 * 권한을 선언 없이 주지 않는 이유: 나중에 우리가 만들지 않은 미니앱을 올릴 때,
 * "기본으로 다 보임"이면 그 순간 전부 다시 설계해야 한다. 지금 미니앱이 우리 것뿐이라도
 * 경계는 처음부터 있어야 한다.
 *
 * ## 메시지 규약
 *
 * 요청과 응답은 `requestId`로 짝지어진다. 미니앱이 여러 요청을 동시에 보낼 수 있고,
 * 응답 순서가 요청 순서와 다를 수 있다.
 *
 *   미니앱 → 호스트   { v, kind: 'request', requestId, method, params }
 *   호스트 → 미니앱   { v, kind: 'response', requestId, ok, data }  또는
 *                    { v, kind: 'response', requestId, ok: false, error: { code, message } }
 */

/**
 * 브릿지 프로토콜 버전.
 *
 * 미니앱은 자기가 아는 버전을 보내고, 호스트가 모르는 버전이면 거절한다. 미니앱은
 * 호스트와 **따로 배포**되므로(그것이 이 구조의 목적이다) 둘의 버전이 어긋난 채로
 * 만나는 일이 반드시 생긴다. 그때 조용히 오작동하는 것보다 명확히 거절하는 편이 낫다.
 */
export const MINIAPP_BRIDGE_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* 권한                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 미니앱이 선언할 수 있는 권한.
 *
 * 좁게 시작한다 — 권한은 넓히기는 쉽고 **좁히기는 불가능**하다(이미 그 권한으로 만든
 * 미니앱이 깨진다). 필요해질 때 더한다.
 */
export const MINIAPP_PERMISSIONS = [
  /** 기간 지출 합계(`GET /v1/transactions/summary`와 같은 정의). 개별 거래는 안 준다. */
  'spend.summary',
  /** 가맹점 집계(이름·건수·합계). 개별 거래·금액 상세는 안 준다. */
  'merchant.list',
  /** 카테고리 목록(이름·slug). 가장 약한 권한 — 개인 데이터가 아니다. */
  'category.list',
] as const;
export type MiniappPermission = (typeof MINIAPP_PERMISSIONS)[number];

/** 등록된 권한 이름인지 판별한다. */
export function isMiniappPermission(value: string): value is MiniappPermission {
  return (MINIAPP_PERMISSIONS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* 메서드                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 브릿지 메서드와 그것이 요구하는 권한.
 *
 * **상태 저장(`state.*`)은 권한이 필요 없다.** 미니앱 자기 상태이고, 호스트가 미니앱
 * 키로 격리해 저장하므로 다른 미니앱의 상태를 볼 수 없다. 권한을 요구하면 순수 게임도
 * 선언을 해야 하는데, 그 선언은 아무것도 막지 못하면서 마찰만 만든다.
 */
export const MINIAPP_METHODS = {
  /** 호스트 정보(브릿지 버전·미니앱 키). 권한 불필요 — 자기 자신에 대한 정보다. */
  'host.info': null,
  /** 자기 상태 읽기. `{ key }` → `{ state }` */
  'state.get': null,
  /** 자기 상태 쓰기. `{ key, state }` */
  'state.set': null,
  /** 자기 상태 지우기. `{ key }` */
  'state.remove': null,
  /** 기간 지출 합계. `{ from, to }` → `{ totalNet, count }` */
  'spend.summary': 'spend.summary',
  /** 가맹점 집계. → `{ items: [{ name, count, netTotal }] }` */
  'merchant.list': 'merchant.list',
  /** 카테고리 목록. → `{ items: [{ slug, name }] }` */
  'category.list': 'category.list',
} as const satisfies Record<string, MiniappPermission | null>;

export type MiniappMethod = keyof typeof MINIAPP_METHODS;

/** 등록된 메서드 이름인지 판별한다. */
export function isMiniappMethod(value: string): value is MiniappMethod {
  return Object.prototype.hasOwnProperty.call(MINIAPP_METHODS, value);
}

/** 이 메서드에 필요한 권한. `null`이면 권한 없이 쓸 수 있다. */
export function permissionForMethod(
  method: MiniappMethod,
): MiniappPermission | null {
  return MINIAPP_METHODS[method];
}

/* -------------------------------------------------------------------------- */
/* 메시지                                                                      */
/* -------------------------------------------------------------------------- */

export interface MiniappRequest {
  v: number;
  kind: 'request';
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface MiniappResponseOk {
  v: number;
  kind: 'response';
  requestId: string;
  ok: true;
  data: unknown;
}

export interface MiniappResponseError {
  v: number;
  kind: 'response';
  requestId: string;
  ok: false;
  error: { code: MiniappErrorCode; message: string };
}

export type MiniappResponse = MiniappResponseOk | MiniappResponseError;

/**
 * 오류 코드.
 *
 * 미니앱이 **분기할 수 있어야** 하므로 문자열 코드를 준다. 메시지만 주면 미니앱은
 * 문구를 파싱하게 되고, 그러면 문구를 못 고친다.
 */
export type MiniappErrorCode =
  /** 브릿지 버전이 호스트와 다르다. */
  | 'version_mismatch'
  /** 없는 메서드. */
  | 'unknown_method'
  /** manifest에 선언하지 않은 권한이 필요한 메서드. */
  | 'permission_denied'
  /** 파라미터가 계약과 다르다. */
  | 'invalid_params'
  /** 호스트가 처리 중 실패(네트워크 등). 미니앱이 재시도할 수 있다. */
  | 'host_error';

/**
 * 미니앱이 보낸 값이 요청 메시지인지 판정한다.
 *
 * **`postMessage`는 누구나 보낼 수 있다.** iframe 안의 미니앱뿐 아니라 확장 프로그램,
 * 다른 창도 보낸다. 그래서 호스트는 (1) 이벤트 source가 그 iframe인지 확인하고
 * (2) 이 함수로 모양을 확인한 뒤에만 처리해야 한다. 둘 중 하나만으로는 부족하다.
 */
export function isMiniappRequest(value: unknown): value is MiniappRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === 'request' &&
    typeof v.v === 'number' &&
    typeof v.requestId === 'string' &&
    v.requestId.length > 0 &&
    typeof v.method === 'string' &&
    (v.params === undefined ||
      (typeof v.params === 'object' && v.params !== null && !Array.isArray(v.params)))
  );
}

/** 응답 만들기 — 호스트가 쓴다. */
export function miniappOk(requestId: string, data: unknown): MiniappResponseOk {
  return { v: MINIAPP_BRIDGE_VERSION, kind: 'response', requestId, ok: true, data };
}

/** 요청 식별자를 보존한 실패 응답을 만든다. */
export function miniappError(
  requestId: string,
  code: MiniappErrorCode,
  message: string,
): MiniappResponseError {
  return {
    v: MINIAPP_BRIDGE_VERSION,
    kind: 'response',
    requestId,
    ok: false,
    error: { code, message },
  };
}

/* -------------------------------------------------------------------------- */
/* 요청 검증                                                                    */
/* -------------------------------------------------------------------------- */

/** 검증 결과 — 통과면 메서드가 확정되고, 아니면 이유가 나온다. */
export type MiniappRouteCheck =
  | { ok: true; method: MiniappMethod }
  | { ok: false; code: MiniappErrorCode; message: string };

/**
 * 요청 하나를 라우팅 전에 검증한다. **호스트의 첫 관문이다.**
 *
 * 순서가 중요하다: 버전 → 메서드 존재 → 권한. 권한을 먼저 보면 없는 메서드에 대해
 * `permission_denied`가 나가고, 그러면 미니앱 개발자가 오타를 권한 문제로 오해한다.
 */
export function checkMiniappRequest(
  request: MiniappRequest,
  grantedPermissions: readonly string[],
): MiniappRouteCheck {
  if (request.v !== MINIAPP_BRIDGE_VERSION) {
    return {
      ok: false,
      code: 'version_mismatch',
      message: `브릿지 버전이 다릅니다(호스트 ${MINIAPP_BRIDGE_VERSION}, 미니앱 ${request.v}).`,
    };
  }
  if (!isMiniappMethod(request.method)) {
    return {
      ok: false,
      code: 'unknown_method',
      message: `알 수 없는 메서드: ${request.method}`,
    };
  }
  const needed = permissionForMethod(request.method);
  if (needed !== null && !grantedPermissions.includes(needed)) {
    return {
      ok: false,
      code: 'permission_denied',
      message: `이 미니앱에는 ${needed} 권한이 없습니다.`,
    };
  }
  return { ok: true, method: request.method };
}

/** 현재 버전의 응답 봉투와 성공·실패 필드를 검증한다. */
export function isMiniappResponse(value: unknown): value is MiniappResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if (d.v !== MINIAPP_BRIDGE_VERSION || d.kind !== 'response' || typeof d.requestId !== 'string' || !d.requestId) return false;
  if (d.ok === true) return Object.prototype.hasOwnProperty.call(d, 'data') && d.data !== undefined;
  if (d.ok !== false || typeof d.error !== 'object' || d.error === null) return false;
  const error = d.error as Record<string, unknown>;
  return ['version_mismatch', 'unknown_method', 'permission_denied', 'invalid_params', 'host_error'].includes(String(error.code)) && typeof error.message === 'string';
}
