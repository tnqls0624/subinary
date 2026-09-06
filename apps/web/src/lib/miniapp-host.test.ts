import { describe, expect, it, vi } from 'vitest';
import { createMiniappHostRuntime, createMiniappStateHandlers, type MiniappStateStore, type MiniappFrame } from './miniapp-host';
import { createMiniappClient } from './miniapp-client-test-utils';
import { MINIAPPS } from './miniapp-registry';
import { activeTabFor } from './nav-tabs';

const request = (method = 'state.get', params: Record<string, unknown> = { key: 'garden' }, requestId = 'r') => ({ v: 1, kind: 'request', requestId, method, params });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function store(): MiniappStateStore {
  return { list: vi.fn(async () => ({ items: [] })), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
}

describe('호스트 메시지 경계', () => {
  it('다른 source와 배열 params를 거부한다', async () => {
    const frame = { postMessage: vi.fn() };
    const handler = vi.fn(async () => null);
    const runtime = createMiniappHostRuntime({ appKey: 'backyard', permissions: [], getFrame: () => frame, getHandlers: () => ({ 'state.get': handler }) });
    await runtime.receive({ source: {}, data: request() });
    await runtime.receive({ source: frame, data: { ...request(), params: [] } });
    expect(handler).not.toHaveBeenCalled(); expect(frame.postMessage).not.toHaveBeenCalled();
  });
  it.each(['reload', 'replace', 'destroy'])('이전 비동기 응답을 차단한다: %s', async (mode) => {
    const old = { postMessage: vi.fn() };
    const fresh = { postMessage: vi.fn() };
    let frame: MiniappFrame = old;
    const result = deferred<unknown>();
    const runtime = createMiniappHostRuntime({ appKey: 'backyard', permissions: [], getFrame: () => frame, getHandlers: () => ({ 'state.get': () => result.promise }) });
    const pending = runtime.receive({ source: old, data: request() });
    if (mode === 'reload') runtime.loaded();
    if (mode === 'replace') frame = fresh;
    if (mode === 'destroy') runtime.destroy();
    old.postMessage.mockClear();
    result.resolve({ state: null }); await pending;
    expect(old.postMessage).not.toHaveBeenCalled(); expect(fresh.postMessage).not.toHaveBeenCalled();
  });
  it('권한 0개인 manifest와 ready, 지출 거부를 확인한다', async () => {
    expect(MINIAPPS).toHaveLength(1);
    expect(MINIAPPS[0]).toMatchObject({ key: 'backyard', permissions: [], height: 470 });
    const frame = { postMessage: vi.fn() };
    const runtime = createMiniappHostRuntime({ appKey: 'backyard', permissions: MINIAPPS[0]!.permissions, getFrame: () => frame, getHandlers: () => ({}) });
    runtime.loaded();
    expect(frame.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready', permissions: [] }), '*');
    await runtime.receive({ source: frame, data: request('merchant.list') });
    expect(frame.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'permission_denied' }) }), '*');
    expect(activeTabFor('/play/app/')).toBe('account');
  });
  it('내부 오류 상세는 내보내지 않는다', async () => {
    const frame = { postMessage: vi.fn() };
    const runtime = createMiniappHostRuntime({ appKey: 'backyard', permissions: [], getFrame: () => frame, getHandlers: () => ({ 'state.get': async () => { throw new Error('SQL secret'); } }) });
    await runtime.receive({ source: frame, data: request() });
    expect(frame.postMessage).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'host_error', message: '요청을 처리하지 못했어요' } }), '*');
  });
});

describe('저장 컨텍스트와 직렬 PUT', () => {
  it('목록에 키가 없는 성공만 null이며 실패는 전파한다', async () => {
    const api = store();
    const handlers = createMiniappStateHandlers('h1', 'backyard', [], api);
    await expect(handlers['state.get']!({ key: 'garden', householdId: 'h2', appKey: 'other' })).resolves.toEqual({ state: null });
    expect(api.list).toHaveBeenCalledWith('h1', 'backyard');
    api.list = async () => { throw new Error('인증 실패'); };
    await expect(handlers['state.get']!({ key: 'garden' })).rejects.toThrow('인증 실패');
    api.list = async () => ({ items: [{ stateKey: 'garden', state: undefined }] });
    await expect(handlers['state.get']!({ key: 'garden' })).rejects.toThrow('state');
  });
  it('가구·앱 준비 전에는 핸들러를 만들지 않는다', () => {
    expect(() => createMiniappStateHandlers('', 'backyard', [], store())).toThrow();
    expect(() => createMiniappStateHandlers('h', '', [], store())).toThrow();
  });
  it('앞 PUT의 실패 뒤에도 최신 PUT은 순서대로 실행된다', async () => {
    const api = store();
    const first = deferred<unknown>();
    const save = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    api.save = save;
    const handlers = createMiniappStateHandlers('h1', 'backyard', [], api);
    const a = handlers['state.set']!({ key: 'garden', state: { fruit: 1 } });
    const failed = expect(a).rejects.toThrow('실패');
    const b = handlers['state.set']!({ key: 'garden', state: { fruit: 2 }, householdId: 'h2' });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    first.reject(new Error('실패')); await failed; await b;
    expect(save.mock.calls).toEqual([['h1', 'backyard', 'garden', { fruit: 1 }], ['h1', 'backyard', 'garden', { fruit: 2 }]]);
  });
  it('가구·앱·키가 다른 저장 큐는 독립적이다', async () => {
    const api = store();
    const first = deferred<unknown>();
    api.save = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const one = createMiniappStateHandlers('h1', 'backyard', [], api);
    const two = createMiniappStateHandlers('h2', 'backyard', [], api);
    const pending = one['state.set']!({ key: 'garden', state: {} });
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    await two['state.set']!({ key: 'garden', state: {} });
    await one['state.set']!({ key: 'other', state: {} });
    expect(api.save).toHaveBeenCalledTimes(3);
    first.resolve(undefined); await pending;
  });
  it.each([{ key: '', state: {} }, { key: 'garden', state: [] }, { key: 'garden', state: null }])('불량 저장 요청을 거절한다: %j', async (params) => {
    const api = store();
    await expect(createMiniappStateHandlers('h', 'backyard', [], api)['state.set']!(params)).rejects.toThrow();
    expect(api.save).not.toHaveBeenCalled();
  });
});

it('실제 bridge.js와 호스트 단독 harness가 ready·GET·PUT·실패를 왕복한다', async () => {
  const listeners = new Set<EventListener>();
  const source = { addEventListener: (_: string, fn: EventListener) => { listeners.add(fn); }, removeEventListener: (_: string, fn: EventListener) => { listeners.delete(fn); } };
  const api = store();
  const handlers = createMiniappStateHandlers('household', 'backyard', [], api);
  const frame = { postMessage: (data: unknown) => { for (const fn of listeners) fn({ data, source: target } as unknown as Event); } };
  const runtime = createMiniappHostRuntime({ appKey: 'backyard', permissions: [], getFrame: () => frame, getHandlers: () => handlers });
  const target = { postMessage: (data: unknown) => { void runtime.receive({ source: frame, data }); } };
  const client = createMiniappClient({ source, target, captureReady: true });
  runtime.loaded(); await client.ready();
  await expect(client.state.get('garden')).resolves.toBeNull();
  await client.state.set('garden', { v: 1 });
  expect(api.save).toHaveBeenCalledWith('household', 'backyard', 'garden', { v: 1 });
  api.list = async () => { throw new Error('연결 실패'); };
  await expect(client.state.get('garden')).rejects.toMatchObject({ code: 'host_error' });
  api.save = async () => { throw new Error('저장 실패'); };
  await expect(client.state.set('garden', { v: 1 })).rejects.toMatchObject({ code: 'host_error' });
  client.destroy(); runtime.destroy(); expect(listeners.size).toBe(0);
});

it('저장 ACK는 각 요청 id에 대응하며 앞 PUT 완료 전에 뒤 PUT이 실행되지 않는다', async () => {
  const api = store();
  const first = deferred<unknown>();
  api.save = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
  const handlers = createMiniappStateHandlers('h', 'backyard', [], api);
  const frame = { postMessage: vi.fn() };
  const runtime = createMiniappHostRuntime({ appKey: 'backyard', permissions: [], getFrame: () => frame, getHandlers: () => handlers });
  const old = runtime.receive({ source: frame, data: request('state.set', { key: 'garden', state: { fruit: 1 } }, 'old') });
  const latest = runtime.receive({ source: frame, data: request('state.set', { key: 'garden', state: { fruit: 2 } }, 'latest') });
  await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  expect(frame.postMessage).not.toHaveBeenCalled();
  first.resolve(undefined); await Promise.all([old, latest]);
  expect(api.save).toHaveBeenCalledTimes(2);
  expect(frame.postMessage.mock.calls.map(([data]) => data)).toEqual([
    { v: 1, kind: 'response', requestId: 'old', ok: true, data: { ok: true } },
    { v: 1, kind: 'response', requestId: 'latest', ok: true, data: { ok: true } },
  ]);
});
