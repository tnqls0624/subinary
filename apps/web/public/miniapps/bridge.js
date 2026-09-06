// @ts-check
/** 미니앱의 실제 배포 클라이언트. 저장 실패는 호출자에게 전달한다. */
(() => {
  'use strict';
  /** @typedef {{data: unknown, source: unknown}} BridgeEvent */
  /** @typedef {{addEventListener: (type: string, fn: (event: BridgeEvent) => void) => void, removeEventListener: (type: string, fn: (event: BridgeEvent) => void) => void}} MessageSource */
  /** @typedef {{postMessage: (message: unknown, origin: string) => void}} MessageTarget */
  /** @typedef {{source?: MessageSource, target?: MessageTarget, createId?: () => string, timeoutMs?: number, captureReady?: boolean}} ClientOptions */
  /** @typedef {{resolve: (value: unknown) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}} Pending */
  const BRIDGE_VERSION = 1;
  class MiniappBridgeError extends Error {
    /** @param {string} code 오류 코드 @param {string} message 표시 문구 */
    constructor(code, message) { super(message); this.name = 'MiniappBridgeError'; this.code = code; }
  }
  /** 객체 필드 판별. @param {unknown} value @returns {value is Record<string, unknown>} */
  function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
  /** 주입된 창 또는 실제 부모와 통신한다. @param {ClientOptions} options */
  function createMiniappClient(options = {}) {
    const { source, target } = options;
    const timeoutMs = options.timeoutMs ?? 8000;
    let sequence = 0;
    const createId = options.createId ?? (() => `r${Date.now()}-${++sequence}`);
    /** @type {Map<string, Pending>} */
    const pending = new Map();
    /** @type {Set<Pending>} */
    const waiting = new Set();
    let readySeen = false;
    let listening = false;
    let destroyed = false;
    let captureReady = options.captureReady ?? false;
    /** 리스너를 필요할 때만 유지한다. */
    function cleanup() {
      if (listening && !captureReady && !pending.size && !waiting.size) {
        source?.removeEventListener('message', onMessage); listening = false;
      }
    }
    /** 응답·ready를 검증한다. @param {BridgeEvent} event */
    function onMessage(event) {
      if (event.source !== target || !record(event.data)) return;
      const d = event.data;
      if (d.kind === 'ready') {
        if (d.v !== BRIDGE_VERSION || typeof d.appKey !== 'string' || !Array.isArray(d.permissions) || !d.permissions.every((p) => typeof p === 'string')) return;
        readySeen = true; captureReady = false;
        for (const item of waiting) { clearTimeout(item.timer); item.resolve(undefined); }
        waiting.clear(); cleanup(); return;
      }
      if (d.kind !== 'response' || typeof d.requestId !== 'string') return;
      const item = pending.get(d.requestId);
      if (!item) return;
      pending.delete(d.requestId); clearTimeout(item.timer);
      if (d.v !== BRIDGE_VERSION) item.reject(new MiniappBridgeError('version_mismatch', '브릿지 버전이 달라요'));
      else if (d.ok === true && Object.prototype.hasOwnProperty.call(d, 'data') && d.data !== undefined) item.resolve(d.data);
      else if (d.ok === false && record(d.error) && typeof d.error.code === 'string' && ['version_mismatch', 'unknown_method', 'permission_denied', 'invalid_params', 'host_error'].includes(d.error.code) && typeof d.error.message === 'string') item.reject(new MiniappBridgeError(d.error.code, d.error.message));
      else item.reject(new MiniappBridgeError('invalid_response', '호스트 응답 형식이 잘못됐어요'));
      cleanup();
    }
    /** 문서 로딩 중 ready를 먼저 구독한다. */
    function listen() { if (!listening && source) { source.addEventListener('message', onMessage); listening = true; } }
    if (captureReady) listen();
    /** 호스트에 요청한다. @param {string} method @param {Record<string, unknown>} [params] @returns {Promise<unknown>} */
    function invoke(method, params = {}) {
      if (!source || !target || destroyed) return Promise.reject(new MiniappBridgeError('host_error', '호스트에 연결할 수 없어요'));
      return new Promise((resolve, reject) => {
        const requestId = createId();
        const timer = setTimeout(() => { pending.delete(requestId); reject(new MiniappBridgeError('timeout', '호스트 응답 시간이 초과됐어요')); cleanup(); }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer }); listen();
        try { target.postMessage({ v: BRIDGE_VERSION, kind: 'request', requestId, method, params }, '*'); }
        catch { pending.delete(requestId); clearTimeout(timer); reject(new MiniappBridgeError('host_error', '요청을 보내지 못했어요')); cleanup(); }
      });
    }
    /** ready가 먼저 왔어도 기억하며, timeout 뒤 다시 대기할 수 있다. @returns {Promise<void>} */
    async function ready() {
      if (!source || !target || destroyed) throw new MiniappBridgeError('host_error', '호스트에 연결할 수 없어요');
      if (readySeen) return;
      await new Promise((resolve, reject) => {
        const item = { resolve, reject, timer: setTimeout(() => { waiting.delete(item); captureReady = false; reject(new MiniappBridgeError('timeout', '호스트 준비 시간이 초과됐어요')); cleanup(); }, timeoutMs) };
        waiting.add(item); listen();
        // 첫 load가 부모 세대를 확정하기 전에는 GET을 시작하지 않는다.
        if (captureReady) return;
        // 최초 ready 대기가 끝난 재시도만 host.info로 연결을 재확인한다.
        void invoke('host.info').then((info) => {
          if (!waiting.has(item)) return;
          if (!record(info) || typeof info.appKey !== 'string' || !Array.isArray(info.permissions) || !info.permissions.every((p) => typeof p === 'string')) throw new MiniappBridgeError('invalid_response', '호스트 정보가 잘못됐어요');
          readySeen = true; captureReady = false;
          clearTimeout(item.timer); waiting.delete(item); resolve(undefined); cleanup();
        }).catch((error) => {
          if (!waiting.delete(item)) return;
          clearTimeout(item.timer); reject(error); cleanup();
        });
      });
    }
    const state = {
      /** 정상 응답의 명시적 null만 신규다. @param {string} key @returns {Promise<unknown | null>} */
      async get(key) {
        const result = await invoke('state.get', { key });
        if (!record(result) || !Object.prototype.hasOwnProperty.call(result, 'state') || result.state === undefined) throw new MiniappBridgeError('invalid_response', '저장 응답에 state가 없어요');
        return result.state;
      },
      /** 저장 완료 ACK를 확인한다. @param {string} key @param {Record<string, unknown>} value @returns {Promise<void>} */
      async set(key, value) {
        const result = await invoke('state.set', { key, state: value });
        if (!record(result) || result.ok !== true) throw new MiniappBridgeError('invalid_response', '저장 완료 응답이 잘못됐어요');
      },
    };
    /** 모든 리스너와 대기를 해제한다. */
    function destroy() {
      destroyed = true; captureReady = false;
      for (const item of [...pending.values(), ...waiting]) { clearTimeout(item.timer); item.reject(new MiniappBridgeError('host_error', '브릿지가 종료됐어요')); }
      pending.clear(); waiting.clear(); cleanup();
    }
    return { invoke, ready, state, destroy, BRIDGE_VERSION };
  }
  const api = { createMiniappClient, MiniappBridgeError };
  /** @type {typeof globalThis & {MiniappBridge?: typeof api, MiniApp?: ReturnType<typeof createMiniappClient>}} */
  const root = globalThis;
  root.MiniappBridge = api;
  if (typeof window !== 'undefined') root.MiniApp = createMiniappClient({ source: window, target: window.parent, captureReady: true });
})();
