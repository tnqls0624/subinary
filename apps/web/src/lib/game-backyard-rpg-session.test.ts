import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, settle } from './game-backyard-test-utils';
import { loadRpg, playable } from './game-backyard-rpg-test-utils';
const api = loadRpg();
const sessions: ReturnType<typeof api.session.createSession>[] = [];
function setup(initial: Record<string, unknown> = api.codec.initial()) {
  const saved: Record<string, unknown> = structuredClone(initial);
  const get = vi.fn(async (key: string): Promise<unknown> => Object.hasOwn(saved, key) ? saved[key] : null);
  const set = vi.fn(async (key: string, value: RpgSave): Promise<void> => { saved[key] = structuredClone(value); });
  const ready = vi.fn(async () => {});
  const session = api.session.createSession({ bridge: { ready, state: { get, set } }, setTimer: (fn, ms) => Number(setTimeout(fn, ms)), clearTimer: id => clearTimeout(id) });
  sessions.push(session);
  return { session, get, set, ready, saved, play: () => playable(session) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { sessions.splice(0).forEach(s => s.destroy()); vi.useRealTimers(); });

describe('RPG 세션 부팅 계약', () => {
  it('팩토리에는 writer·통신이 없고 null만 신규 초기화한다', async () => {
    const h = setup({});
    expect(h.session.getState()).toEqual({ status: 'waiting_host' });
    expect(h.get).not.toHaveBeenCalled();
    await h.session.load();
    expect(h.play().data.rpg_meta.seed).toBe(4821);
    expect(h.set.mock.calls.map(c => c[0])).toEqual(['rpg_world', 'rpg_collection', 'rpg_residents', 'rpg_player', 'rpg_meta']);
    expect(h.get.mock.calls.map(c => c[0])).toContain('garden');
  });
  it.each([...api.codec.keys, 'garden'])('%s 초기 GET 실패에서 PUT=0', async failing => {
    const h = setup({});
    h.get.mockImplementation(async key => { if (key === failing) throw Error('GET 503'); return null; });
    await h.session.load();
    expect(h.session.getState().status).toBe('load_error');
    expect(h.session.getState()).not.toHaveProperty('writer');
    expect(h.session.getState()).not.toHaveProperty('data');
    expect(h.set).not.toHaveBeenCalled();
  });
  it.each(api.codec.keys)('%s 미래 버전 및 손상은 PUT=0', async key => {
    for (const [raw, status] of [[{ v: 99 }, 'unsupported_version'], [{ v: 2 }, 'invalid_state'], [undefined, 'invalid_state']] as const) {
      const h = setup({ ...api.codec.initial(), [key]: raw });
      await h.session.load();
      expect(h.session.getState().status).toBe(status);
      expect(h.set).not.toHaveBeenCalled();
    }
  });
  it.each(api.codec.keys.filter(k => k !== 'rpg_meta'))('meta가 있는데 %s null이면 복원 오류', async key => {
    const h = setup({ ...api.codec.initial(), [key]: null });
    await h.session.load();
    expect(h.session.getState().status).toBe('invalid_state');
    expect(h.set).not.toHaveBeenCalled();
  });
  it.each(['rpg_world', 'rpg_collection', 'rpg_residents', 'rpg_player', 'rpg_meta'])('%s 초기 PUT 실패 후 기존 키를 보존하며 meta ACK를 마지막에 받는다', async failing => {
    const h = setup({});
    h.set.mockImplementation(async (key, value) => {
      if (key === failing) throw Error('PUT 503');
      h.saved[key] = structuredClone(value);
    });
    await h.session.load();
    expect(h.session.getState().status).toBe('initialization_error');
    expect(h.session.getState()).not.toHaveProperty('writer');
    const before = structuredClone(h.saved);
    const restored = setup(before);
    const metaAck = deferred<void>();
    restored.set.mockImplementation(async (key, value) => {
      if (key === 'rpg_meta') await metaAck.promise;
      restored.saved[key] = structuredClone(value);
    });
    const loading = restored.session.load();
    for (let i = 0; i < 8; i++) await settle();
    expect(restored.session.getState().status).toBe('initializing');
    expect(restored.set.mock.calls.at(-1)?.[0]).toBe('rpg_meta');
    for (const [key, value] of Object.entries(before)) {
      expect(restored.saved[key]).toEqual(value);
      expect(restored.set.mock.calls.map(c => c[0])).not.toContain(key);
    }
    metaAck.resolve(); await loading;
    expect(restored.play().data.rpg_meta.initialized).toBe(true);
  });
  it('v1 이전은 garden GET만 하고 원본·열매·화분 시각을 보존한다', async () => {
    const garden={v:1,t:10,s:7,f:345,n:0,k:['p','w'],p:['p:0:99999','w:15']};
    const h=setup({garden});await h.session.load();
    expect(h.saved.garden).toEqual(garden);
    expect(h.set.mock.calls.map(c=>c[0])).not.toContain('garden');
    expect(h.play().data.rpg_world).toEqual({v:2,items:['0:p:3:15','1:w:6:18'],legacyFruit:345});
    expect(h.play().data.rpg_collection.nodes).toEqual(['pot-0:99999']);
    const puts=h.set.mock.calls.length;
    h.saved.garden={...garden,f:999};
    await h.session.load();
    expect(h.play().data.rpg_world.legacyFruit).toBe(345);
    expect(h.set).toHaveBeenCalledTimes(puts);
  });
  it('부분 초기화 손상과 v1 손상은 누락 키를 채우기 전에 중단한다', async () => {
    for (const initial of [{ rpg_player: { v: 5 } }, { garden: { v: 1, t: 0, s: 1, f: 3, n: 0, k: ['p'], p: ['broken'] } }]) {
      const h = setup(initial); await h.session.load(); expect(h.set).not.toHaveBeenCalled();
      expect(h.session.getState()).not.toHaveProperty('writer');
    }
  });
  it('초기 ready·GET 8초 무응답은 PUT=0이며 늦은 응답도 버린다', async () => {
    for (const name of ['ready', 'get'] as const) {
      const h = setup({}), late = deferred<never>();
      h[name].mockImplementation(() => late.promise);
      const loading = h.session.load(); await settle(); await vi.advanceTimersByTimeAsync(8000); await loading;
      expect(h.session.getState().status).toBe('load_error'); expect(h.set).not.toHaveBeenCalled();
    }
  });
  it('이전 load의 늦은 null과 destroy 뒤 응답은 쓰지 않는다', async () => {
    const h = setup(), late = deferred<unknown>();
    h.get.mockReturnValueOnce(late.promise);
    const first = h.session.load(); await settle(); await h.session.load(); late.resolve(null); await first;
    expect(h.play().data).toEqual(api.codec.initial()); expect(h.set).not.toHaveBeenCalled();
    const next = setup({}); next.get.mockReturnValue(late.promise);
    const loading = next.session.load(); next.session.destroy(); await loading;
    expect(next.set).not.toHaveBeenCalled();
  });
});

describe('RPG 키별 writer와 이동 checkpoint', () => {
  it('world 이동은 ACK 전 편집을 잠그고 다른 키를 쓰지 않는다', async () => {
    const h = setup(); await h.session.load();
    const ack = deferred<void>(); h.set.mockReturnValueOnce(ack.promise);
    const next = { ...h.play().data.rpg_world, items: ['0:p:4:21', '1:w:4:20', '2:c:5:20'] };
    expect(h.play().writer.commit('rpg_world', next)).toBe(true);
    expect(h.play().writer.commit('rpg_world', next)).toBe(false);
    expect(h.set.mock.calls.map(c => c[0])).toEqual(['rpg_world']);
    expect(h.play().writer.getSaveState().locked).toBe(true);
    ack.resolve(); await settle(); expect(h.play().writer.getSaveState().locked).toBe(false);
  });
  it('화분 보관·재배치 후 collection 시각이 같고 슬롯 삭제·재발급을 거부한다', async () => {
    const data = api.codec.initial(); data.rpg_collection.nodes = ['pot-0:12345'];
    const h = setup(data); await h.session.load();
    const stored = { ...data.rpg_world, items: ['0:p:b', '1:w:4:20', '2:c:5:20'] };
    expect(h.play().writer.commit('rpg_world', stored)).toBe(true); await settle();
    expect(h.play().writer.commit('rpg_world', data.rpg_world)).toBe(true); await settle();
    expect(api.codec.potReadyAt(h.play().data.rpg_collection, '0')).toBe(12345);
    expect(h.play().writer.commit('rpg_world', { ...stored, items: ['1:w:b', '2:c:b'] })).toBe(false);
    expect(h.play().writer.commit('rpg_world', { ...stored, items: ['0:w:b', '1:w:b', '2:c:b'] })).toBe(false);
    expect(h.play().writer.commit('rpg_collection', { ...data.rpg_collection, nodes: [] })).toBe(false);
    expect(h.set.mock.calls.every(c => c[0] === 'rpg_world')).toBe(true);
  });
  it('PUT 503 백오프는 1/2/4/8/16/30초이고 영구 오류는 멈춘다', async () => {
    const h = setup(); await h.session.load();
    h.set.mockRejectedValue({ code: 'host_error' });
    h.play().writer.commit('rpg_player', { ...h.play().data.rpg_player, x: 121 });
    await settle();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const calls = h.set.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1); expect(h.set).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1); expect(h.set).toHaveBeenCalledTimes(calls + 1);
      expect(h.play().writer.getSaveState().message).toBe('저장 안 됨');
    }
    h.set.mockRejectedValue({ code: 'permission_denied' });
    h.play().writer.flush(); await settle(); const count = h.set.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000); expect(h.set).toHaveBeenCalledTimes(count);
  });
  it('8초 PUT timeout·늦은 ACK가 최신 dirty를 지우지 않는다', async () => {
    const h = setup(); await h.session.load();
    const old = deferred<void>(), latest = deferred<void>();
    h.set.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const writer = h.play().writer;
    writer.commit('rpg_player', { ...h.play().data.rpg_player, x: 121 });
    writer.commit('rpg_player', { ...h.play().data.rpg_player, x: 122 });
    await vi.advanceTimersByTimeAsync(8000);
    expect(writer.getSaveState().message).toBe('저장 안 됨');
    await vi.advanceTimersByTimeAsync(1000);
    old.resolve(); await settle();
    expect(writer.getSaveState().keys.rpg_player.ackedSequence).toBe(0);
    expect(writer.getSaveState().dirty).toBe(true);
    latest.resolve(); await settle(); expect(writer.getSaveState().dirty).toBe(false);
    expect(h.set.mock.calls[1][1]).toMatchObject({ x: 122 });
  });
  it('정상 이전 ACK도 최신 위치의 dirty를 지우지 않는다', async () => {
    const h = setup(); await h.session.load();
    const old = deferred<void>(), next = deferred<void>();
    h.set.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const writer = h.play().writer;
    writer.commit('rpg_player', { ...h.play().data.rpg_player, x: 121 });
    writer.commit('rpg_player', { ...h.play().data.rpg_player, x: 122 });
    old.resolve(); await settle();
    expect(writer.getSaveState().keys.rpg_player).toMatchObject({ ackedSequence: 1, localSequence: 2 });
    expect(writer.getSaveState().dirty).toBe(true);
    next.resolve(); await settle(); expect(writer.getSaveState().dirty).toBe(false);
  });
  it('60초 걷기의 프레임 관측 PUT=0, 정지 1회 포함 총 PUT ≤7', async () => {
    const h = setup(); await h.session.load(); const writer = h.play().writer;
    let framePuts = 0;
    for (let frame = 0; frame < 3600; frame++) {
      const count = h.set.mock.calls.length;
      writer.observePlayer({ ...h.play().data.rpg_player, x: 100 + frame % 200, t: Math.floor(frame / 60) }, true);
      framePuts += h.set.mock.calls.length - count;
      await vi.advanceTimersByTimeAsync(Math.floor((frame + 1) * 1000 / 60) - Math.floor(frame * 1000 / 60));
    }
    writer.observePlayer({ ...h.play().data.rpg_player, x: 301, t: 60 }, false);
    const count = h.set.mock.calls.length;
    await vi.advanceTimersByTimeAsync(999); expect(h.set).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.set.mock.calls.length).toBeLessThanOrEqual(7);
    expect(h.set.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(h.set).toHaveBeenCalledTimes(count + 1);
    expect(framePuts).toBe(0);
    process.stdout.write('60초 걷기 player PUT: ' + h.set.mock.calls.length + ' 프레임별 PUT: ' + framePuts + ' 정지 저장: 1\n');
  });
  it('dirty 복귀는 메모리 보존, ACK 뒤 복귀는 재읽기, destroy는 타이머 정리', async () => {
    const h = setup(); await h.session.load();
    const ack = deferred<void>(); h.set.mockReturnValueOnce(ack.promise);
    h.play().writer.observePlayer({ ...h.play().data.rpg_player, x: 125 }, true);
    const reads = h.get.mock.calls.length;
    await h.session.load(); expect(h.get).toHaveBeenCalledTimes(reads);
    expect(h.play().data.rpg_player.x).toBe(125);
    ack.resolve(); await settle(); await h.session.load();
    expect(h.get.mock.calls.length).toBeGreaterThan(reads);
    h.session.destroy(); expect(vi.getTimerCount()).toBe(0);
  });
});
