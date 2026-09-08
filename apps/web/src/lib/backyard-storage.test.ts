import { describe, expect, it, vi } from 'vitest';
import { createBackyardStorage, type BackyardStore } from './backyard-storage';
import { loadRpg, playable } from './game-backyard-rpg-test-utils';
import { settle } from './game-backyard-test-utils';

/** list/save 호출을 세는 가짜 저장소. */
function fakeStore(overrides: Partial<BackyardStore> = {}) {
  const saved: Record<string, unknown> = {};
  const calls: string[] = [];
  const store: BackyardStore = {
    list: async () => { calls.push('list'); return { items: Object.entries(saved).map(([stateKey, state]) => ({ stateKey, state })) }; },
    save: async (_h, _a, key, state) => { calls.push('save:' + key); saved[key] = state; },
    ...overrides,
  };
  return { store, saved, calls };
}

const context = { householdId: 'h1', appKey: 'backyard', isReady: () => true };

describe('전체 화면 저장 어댑터', () => {
  it('한 세대에서 list를 한 번만 부르고 5키를 스냅샷으로 답한다', async () => {
    // 브릿지판 state.get은 키마다 list를 호출해 5키를 읽으면 5~6회가 됐다.
    const { store, calls } = fakeStore();
    const storage = createBackyardStorage({ ...context, store });
    await storage.ready();
    for (const key of ['rpg_meta', 'rpg_world', 'rpg_collection', 'rpg_residents', 'rpg_player']) {
      expect(await storage.state.get(key)).toBeNull();
    }
    expect(calls).toEqual(['list']);
  });

  it('ready 없이 get을 부르면 오류다 — 없는 키와 안 읽은 상태를 섞지 않는다', async () => {
    const { store } = fakeStore();
    const storage = createBackyardStorage({ ...context, store });
    await expect(storage.state.get('rpg_meta')).rejects.toThrow('저장 목록을 먼저 읽어야 해요');
  });

  it('손상 응답을 빈 목록으로 바꾸지 않는다', async () => {
    for (const bad of [
      undefined,
      { items: null },
      { items: [{ stateKey: '' }] },
      { items: [{ stateKey: 'rpg_meta' }] },
      { items: [{ stateKey: 'rpg_meta', state: undefined }] },
      { items: [{ stateKey: 'rpg_meta', state: {} }, { stateKey: 'rpg_meta', state: {} }] },
    ] as unknown[]) {
      const { store } = fakeStore({ list: async () => bad as Awaited<ReturnType<BackyardStore['list']>> });
      const storage = createBackyardStorage({ ...context, store });
      await expect(storage.ready()).rejects.toThrow();
    }
  });

  it('인증·가구가 준비되지 않으면 ready가 실패하고 list를 부르지 않는다', async () => {
    const { store, calls } = fakeStore();
    const storage = createBackyardStorage({ ...context, store, isReady: () => false });
    await expect(storage.ready()).rejects.toThrow('가족 정보를 준비하고 있어요');
    expect(calls).toEqual([]);
  });

  it('같은 키의 PUT을 직렬 실행한다', async () => {
    const order: string[] = [];
    const gate: { release?: () => void } = {};
    const { store } = fakeStore({
      save: async (_h, _a, key) => {
        order.push('start:' + key);
        if (!gate.release) await new Promise<void>(resolve => { gate.release = resolve; });
        order.push('end:' + key);
      },
    });
    const storage = createBackyardStorage({ ...context, store });
    await storage.ready();
    const first = storage.state.set('rpg_world', { v: 2 });
    const second = storage.state.set('rpg_world', { v: 2 });
    await settle();
    // 두 번째는 첫 번째가 끝나기 전에 시작하지 않는다.
    expect(order).toEqual(['start:rpg_world']);
    gate.release?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:rpg_world', 'end:rpg_world', 'start:rpg_world', 'end:rpg_world']);
  });

  it('다른 키는 서로 기다리지 않는다', async () => {
    const started: string[] = [];
    const { store } = fakeStore({
      save: async (_h, _a, key) => { started.push(key); await new Promise(resolve => setTimeout(resolve, 5)); },
    });
    const storage = createBackyardStorage({ ...context, store });
    await storage.ready();
    void storage.state.set('rpg_world', { v: 2 });
    void storage.state.set('rpg_collection', { v: 2 });
    await settle();
    expect(new Set(started)).toEqual(new Set(['rpg_world', 'rpg_collection']));
  });

  it('저장 성공이 같은 세대의 스냅샷에 반영된다', async () => {
    const { store } = fakeStore();
    const storage = createBackyardStorage({ ...context, store });
    await storage.ready();
    await storage.state.set('rpg_player', { v: 2, x: 120 });
    expect(await storage.state.get('rpg_player')).toEqual({ v: 2, x: 120 });
  });

  it('객체가 아닌 state를 거절한다', async () => {
    const { store, calls } = fakeStore();
    const storage = createBackyardStorage({ ...context, store });
    await storage.ready();
    for (const bad of [null, [], 'x', 1] as unknown[]) {
      await expect(storage.state.set('rpg_world', bad as Record<string, unknown>)).rejects.toThrow('state는 객체여야 해요');
    }
    expect(calls).toEqual(['list']);
  });
});

describe('세션과 붙였을 때 — 설계서 §3의 실패 분기', () => {
  /** 실제 배포 session에 어댑터를 연결한다. */
  function connect(store: BackyardStore, isReady = () => true) {
    const storage = createBackyardStorage({ ...context, store, isReady });
    const session = loadRpg().session.createSession({
      bridge: storage,
      setTimer: (fn, ms) => Number(setTimeout(fn, ms)),
      clearTimer: id => clearTimeout(id),
    });
    return { session, storage };
  }

  it('초기 list 실패면 writer가 없고 save 호출이 0이다', async () => {
    const calls: string[] = [];
    const store: BackyardStore = {
      list: async () => { calls.push('list'); throw new Error('503'); },
      save: async (_h, _a, key) => { calls.push('save:' + key); },
    };
    const { session } = connect(store);
    await session.load();
    await settle();
    const state = session.getState();
    expect(state.status).toBe('load_error');
    expect(state).not.toHaveProperty('writer');
    expect(calls.filter(c => c.startsWith('save'))).toEqual([]);
  });

  it('인증 미준비면 게임이 열리지 않고 save 호출이 0이다', async () => {
    const { store, calls } = fakeStore();
    const { session } = connect(store, () => false);
    await session.load();
    await settle();
    expect(session.getState().status).not.toBe('playable');
    expect(calls.filter(c => c.startsWith('save'))).toEqual([]);
  });

  it('신규는 데이터 4키를 먼저 쓰고 meta를 마지막에 쓴다', async () => {
    const { store, calls } = fakeStore();
    const { session } = connect(store);
    await session.load();
    await settle();
    expect(session.getState().status).toBe('playable');
    const writes = calls.filter(c => c.startsWith('save:')).map(c => c.slice(5));
    expect(writes.at(-1)).toBe('rpg_meta');
    expect(writes.slice(0, -1).sort()).toEqual(['rpg_collection', 'rpg_player', 'rpg_residents', 'rpg_world']);
  });

  it('정상 5키를 읽기만 하고 다시 쓰지 않는다', async () => {
    const { store, calls } = fakeStore();
    // 먼저 신규 초기화로 5키를 만든다.
    const first = connect(store);
    await first.session.load();
    await settle();
    first.session.destroy();
    calls.length = 0;
    // 새 세대로 다시 읽는다.
    const second = connect(store);
    await second.session.load();
    await settle();
    expect(playable(second.session)).toBeTruthy();
    expect(calls).toEqual(['list']);
  });

  it('알 수 없는 버전을 덮어쓰지 않는다', async () => {
    const { store, calls } = fakeStore();
    const first = connect(store);
    await first.session.load();
    await settle();
    first.session.destroy();
    // meta의 버전을 미래 값으로 바꾼다.
    const meta = store as unknown as { list: BackyardStore['list'] };
    const original = meta.list;
    meta.list = async (h, a) => {
      const result = await original(h, a);
      return { items: result.items.map(i => i.stateKey === 'rpg_meta' ? { ...i, state: { ...(i.state as object), v: 99 } } : i) };
    };
    calls.length = 0;
    const second = connect(store);
    await second.session.load();
    await settle();
    expect(second.session.getState().status).not.toBe('playable');
    expect(calls.filter(c => c.startsWith('save'))).toEqual([]);
  });
});
