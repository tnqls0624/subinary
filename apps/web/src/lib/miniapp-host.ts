import { MINIAPP_BRIDGE_VERSION, checkMiniappRequest, isMiniappRequest, miniappError, miniappOk, type MiniappMethod } from '@family/shared';

/** 브릿지 메서드를 수행하는 호스트 함수. */
export type MiniappHandler = (params: Record<string, unknown>) => Promise<unknown>;
export type MiniappHandlers = Partial<Record<MiniappMethod, MiniappHandler>>;
export interface MiniappFrame { postMessage(message: unknown, origin: string): void }

/** iframe 로드·해제 시 세대를 바꿔 이전 비동기 응답을 폐기한다. */
export function createMiniappHostRuntime(options: {
  appKey: string;
  permissions: readonly string[];
  getFrame: () => MiniappFrame | null;
  getHandlers: () => MiniappHandlers;
}) {
  let generation = 0;
  let active = true;
  return {
    loaded(): void {
      generation++;
      options.getFrame()?.postMessage({ v: MINIAPP_BRIDGE_VERSION, kind: 'ready', appKey: options.appKey, permissions: [...options.permissions] }, '*');
    },
    destroy(): void { active = false; generation++; },
    async receive(event: { source: unknown; data: unknown }): Promise<void> {
      const frame = options.getFrame();
      if (!active || !frame || event.source !== frame || !isMiniappRequest(event.data)) return;
      const captured = generation;
      const request = event.data;
      const post = (data: unknown): void => {
        if (active && generation === captured && options.getFrame() === frame) frame.postMessage(data, '*');
      };
      const check = checkMiniappRequest(request, options.permissions);
      if (!check.ok) { post(miniappError(request.requestId, check.code, check.message)); return; }
      const handler = options.getHandlers()[check.method];
      if (!handler) { post(miniappError(request.requestId, 'host_error', '요청을 처리하지 못했어요')); return; }
      try { post(miniappOk(request.requestId, await handler(request.params ?? {}))); }
      catch { post(miniappError(request.requestId, 'host_error', '요청을 처리하지 못했어요')); }
    },
  };
}

export interface MiniappStateStore {
  list(householdId: string, appKey: string): Promise<{ items: { stateKey: string; state: unknown }[] }>;
  save(householdId: string, appKey: string, key: string, state: Record<string, unknown>): Promise<unknown>;
  remove(householdId: string, appKey: string, key: string): Promise<unknown>;
}

/** 가구·앱 컨텍스트를 캡처하고 키별 PUT을 직렬 실행한다. */
export function createMiniappStateHandlers(householdId: string, appKey: string, permissions: readonly string[], store: MiniappStateStore): MiniappHandlers {
  if (!householdId || !appKey) throw new Error('가족과 미니앱이 준비되지 않았어요');
  const queues = new Map<string, Promise<unknown>>();
  const keyOf = (params: Record<string, unknown>): string => {
    if (typeof params.key !== 'string' || !params.key) throw new Error('key가 필요해요');
    return params.key;
  };
  return {
    'host.info': async () => ({ appKey, permissions: [...permissions] }),
    'state.get': async (params) => {
      const key = keyOf(params);
      const result = await store.list(householdId, appKey);
      const found = result.items.find((item) => item.stateKey === key);
      if (!found) return { state: null };
      if (!Object.prototype.hasOwnProperty.call(found, 'state') || found.state === undefined) throw new Error('저장 응답에 state가 없어요');
      return { state: found.state };
    },
    'state.set': async (params) => {
      const key = keyOf(params);
      const state = params.state;
      if (typeof state !== 'object' || state === null || Array.isArray(state)) throw new Error('state는 객체여야 해요');
      const operation = (queues.get(key) ?? Promise.resolve()).catch(() => undefined)
        .then(() => store.save(householdId, appKey, key, state as Record<string, unknown>));
      queues.set(key, operation);
      try { await operation; return { ok: true }; }
      finally { if (queues.get(key) === operation) queues.delete(key); }
    },
    'state.remove': async (params) => store.remove(householdId, appKey, keyOf(params)),
  };
}
