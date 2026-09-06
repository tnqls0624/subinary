import { describe, expect, it, vi } from 'vitest';
import { cell, deferred, loadBackyard, settle } from './game-backyard-test-utils';

/** 주입 타이머의 개수와 백오프 지연을 실제 대기 없이 검사한다. */
function timers() {
  let id = 0;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  return {
    pending,
    setTimer: (callback: () => void, delay: number) => { pending.set(++id, { callback, delay }); return id; },
    clearTimer: (timer: number) => { pending.delete(timer); },
    fire: () => {
      const entry = pending.entries().next().value;
      if (!entry) throw new Error('대기 중인 타이머가 없어요');
      pending.delete(entry[0]);
      entry[1].callback();
      return entry[1].delay;
    },
  };
}

function setup(raw: unknown = null) {
  const api = loadBackyard();
  const timer = timers();
  const ready = vi.fn<() => Promise<void>>().mockResolvedValue();
  const get = vi.fn<(key: string) => Promise<unknown>>().mockResolvedValue(raw);
  const set = vi.fn<(key: string, value: GardenSaveV1) => Promise<void>>().mockResolvedValue();
  const initialize = vi.fn(api.rules.createInitialGarden);
  const nowSec = vi.fn(() => 1000);
  const onChange = vi.fn<(state: GardenSessionState) => void>();
  const session = api.session.createSession({
    bridge: { ready, state: { get, set } }, nowSec, seed: () => 42,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer, onChange,
    rules: { ...api.rules, createInitialGarden: initialize },
  });
  const playable = () => {
    const state = session.getState();
    if (state.status !== 'playable') throw new Error(`플레이 불가: ${state.status}`);
    return state;
  };
  const harvest = (index = 0) => playable().writer.dispatch({ type: 'harvest', cell: cell(index) });
  return { ...api, timer, ready, get, set, initialize, nowSec, onChange, session, playable, harvest };
}
const saved = (patch: Record<string, unknown> = {}) => ({ v: 1, t: 1000, s: 42, f: 100, n: 0, k: ['p', 'w'], p: ['p:0:1000', 'p:1:1000', 'p:2:1000'], ...patch });

describe('주입식 세션의 로드와 저장', () => {
  it('팩토리만 만들면 부팅 부작용과 writer가 없다', () => {
    const h = setup();
    expect(h.session.getState()).toEqual({ status: 'waiting_host' });
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.timer.pending.size).toBe(0);
    expect(h.session).not.toHaveProperty('dispatch');
    expect(h.session).not.toHaveProperty('writer');
  });

  it('get 실패 시 초기화 0회·set 0회이고 다시 시도만 가능하다', async () => {
    const h = setup();
    h.get.mockRejectedValue(new Error('get 실패'));
    await h.session.load();
    expect(h.session.getState()).toMatchObject({ status: 'load_error' });
    expect(h.session.getState()).not.toHaveProperty('garden');
    expect(h.session.getState()).not.toHaveProperty('writer');
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.timer.pending.size).toBe(0);
    h.get.mockResolvedValue(saved());
    await h.session.load();
    expect(h.playable().garden.fruit).toBe(100);
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it.each(['ready', 'get'] as const)('%s 무응답은 8초 후 로드 오류이며 초기화·저장하지 않는다', async operation => {
    const h = setup();
    h[operation].mockImplementation(() => new Promise(() => {}));
    const loading = h.session.load();
    await settle();
    expect(h.timer.fire()).toBe(8000);
    await loading;
    expect(h.session.getState().status).toBe('load_error');
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.timer.pending.size).toBe(0);
  });

  it('ready 실패는 get 이전에 끝나고 null을 받았을 때만 초기화·즉시 저장한다', async () => {
    const h = setup();
    h.ready.mockRejectedValueOnce(new Error('ready 실패'));
    await h.session.load();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    await h.session.load();
    expect(h.initialize).toHaveBeenCalledExactlyOnceWith(1000, 42);
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set.mock.calls[0]).toEqual(['garden', { v: 1, t: 1000, s: 42, f: 0, n: 0, k: ['p', 'w'], p: ['p:0:1000', 'p:1:1000', 'p:2:1000'] }]);
  });

  it.each([
    [undefined, 'invalid_state'], [{}, 'invalid_state'], [saved({ f: -1 }), 'invalid_state'],
    [saved({ v: 2 }), 'unsupported_version'],
  ] as const)('손상 또는 미래 버전은 무저장 상태 %s로 분리한다', async (raw, status) => {
    const h = setup(raw);
    // setup 기본값과 구분해 실제 undefined 응답도 검증한다.
    h.get.mockResolvedValue(raw);
    await h.session.load();
    expect(h.session.getState().status).toBe(status);
    expect(h.session.getState()).not.toHaveProperty('writer');
    expect(h.session.getState()).not.toHaveProperty('garden');
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.timer.pending.size).toBe(0);
  });

  it('혼합 손상 로드는 자동 청소 저장 없이 보존하고 다음 확정 행동에서만 저장한다', async () => {
    const h = setup(saved({ n: 9, k: ['p', 'w', 'c'], p: ['p:0:1000', 'broken', 'c:15'] }));
    await h.session.load();
    expect(h.playable().warnings).toHaveLength(1);
    expect(h.playable().garden).toMatchObject({ fruit: 100, purchasedPots: 9 });
    expect(h.set).not.toHaveBeenCalled();
    h.harvest();
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set.mock.calls[0][1]).toMatchObject({ f: 101, n: 9, k: ['p', 'w', 'c'], p: ['p:0:11800', 'c:15'] });
    expect(h.initialize).not.toHaveBeenCalled();
  });

  it('모두 깨진 튜플도 빈 복구 상태로 보존하며 신규 화분을 지급하지 않는다', async () => {
    const h = setup(saved({ p: ['broken'], f: 0, n: 9 }));
    await h.session.load();
    expect(h.playable().garden).toMatchObject({ placements: [], fruit: 0, purchasedPots: 9 });
    h.playable().writer.flush();
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('확정 행동은 즉시 저장하고 진행 중에는 최신 한 개만 남기며 오래된 ACK는 dirty를 지우지 않는다', async () => {
    const h = setup(saved());
    const first = deferred<void>();
    const second = deferred<void>();
    h.set.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await h.session.load();
    h.harvest(0);
    expect(h.set).toHaveBeenCalledTimes(1);
    h.harvest(1);
    h.harvest(2);
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.playable().writer.getSaveState()).toMatchObject({ localSequence: 3, ackedSequence: 0, dirty: true });
    first.resolve();
    await settle();
    expect(h.set).toHaveBeenCalledTimes(2);
    expect(h.set.mock.calls[1][1].f).toBe(103);
    expect(h.playable().writer.getSaveState()).toMatchObject({ ackedSequence: 1, dirty: true, inFlight: true });
    second.resolve();
    await settle();
    expect(h.playable().writer.getSaveState()).toMatchObject({ ackedSequence: 3, dirty: false, inFlight: false });
  });

  it('실패는 1·2·4·8·16·30·30초에 타이머 하나로 재시도한다', async () => {
    const h = setup(saved());
    h.set.mockRejectedValue({ code: 'host_error' });
    await h.session.load();
    h.harvest();
    await settle();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      expect(h.timer.pending.size).toBe(1);
      expect(h.playable().writer.getSaveState()).toMatchObject({ dirty: true, message: '저장 안 됨' });
      expect(h.timer.fire()).toBe(delay);
      await settle();
    }
    h.set.mockResolvedValue();
    h.timer.fire();
    await settle();
    expect(h.timer.pending.size).toBe(0);
    expect(h.playable().writer.getSaveState()).toMatchObject({ dirty: false, message: '' });
  });

  it('오류 내용 없는 reject도 저장 실패 문구와 재시도를 유지한다', async () => {
    const h = setup(saved());
    h.set.mockRejectedValue(undefined);
    await h.session.load();
    h.harvest();
    await settle();
    expect(h.playable().writer.getSaveState()).toMatchObject({ dirty: true, message: '저장 안 됨', retryScheduled: true });
  });

  it('다음 행동은 백오프를 취소하고 최신 상태를 즉시 전송한다', async () => {
    const h = setup(saved());
    h.set.mockRejectedValueOnce({ code: 'timeout' });
    await h.session.load();
    h.harvest(0);
    await settle();
    expect(h.timer.pending.size).toBe(1);
    h.harvest(1);
    expect(h.timer.pending.size).toBe(0);
    expect(h.set).toHaveBeenCalledTimes(2);
    expect(h.set.mock.calls[1][1].f).toBe(102);
    await settle();
    expect(h.playable().writer.getSaveState().dirty).toBe(false);
  });

  it.each(['invalid_params', 'unsupported_version', 'permission_denied'])('영구 오류 %s는 자동 재전송을 멈추지만 메모리 행동은 유지한다', async code => {
    const h = setup(saved());
    h.set.mockRejectedValue({ code });
    await h.session.load();
    h.harvest();
    await settle();
    h.harvest(1);
    h.playable().writer.flush();
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.timer.pending.size).toBe(0);
    expect(h.playable().garden.fruit).toBe(102);
    expect(h.playable().writer.getSaveState()).toMatchObject({ permanentFailure: true, dirty: true, message: '저장 안 됨' });
  });

  it('숨김 flush는 dirty일 때만 전송하고 진행 중에는 중복 요청을 만들지 않는다', async () => {
    const h = setup(saved());
    h.set.mockRejectedValueOnce({ code: 'timeout' });
    await h.session.load();
    h.playable().writer.flush();
    expect(h.set).not.toHaveBeenCalled();
    h.harvest();
    h.playable().writer.flush();
    expect(h.set).toHaveBeenCalledTimes(1);
    await settle();
    h.playable().writer.flush();
    expect(h.set).toHaveBeenCalledTimes(2);
    expect(h.timer.pending.size).toBe(0);
  });

  it('취소에는 행동이 없고 같은 칸 이동·실패는 저장 0회이며 꽉 찬 swap은 1회다', async () => {
    const h = setup(saved({ k: ['p', 'w', 'c'], p: Array.from({ length: 16 }, (_, i) => i === 0 ? 'p:0:1234' : `c:${i}`) }));
    await h.session.load();
    const before = h.playable().garden;
    expect(h.set).not.toHaveBeenCalled();
    const writer = h.playable().writer;
    expect(writer.dispatch({ type: 'move', from: cell(0), to: cell(0) }).status).toBe('noop');
    expect(writer.dispatch({ type: 'buyAndPlace', kind: 'p', cell: cell(0) }).status).toBe('error');
    expect(h.playable().garden).toBe(before);
    expect(h.set).not.toHaveBeenCalled();
    writer.dispatch({ type: 'move', from: cell(0), to: cell(15) });
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set.mock.calls[0][1].p).toContain('p:15:1234');
    expect(h.set.mock.calls[0][1].p).toContain('c:0');
  });

  it('재로드 후 이전 get의 늦은 null 응답은 초기화하지 않는다', async () => {
    const h = setup(saved());
    const old = deferred<unknown>();
    h.get.mockReturnValueOnce(old.promise);
    const first = h.session.load();
    await settle();
    await h.session.load();
    old.resolve(null);
    await first;
    expect(h.playable().garden.fruit).toBe(100);
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('재로드는 이전 writer와 retry를 폐기하며 실패한 새 로드는 쓸 수 없다', async () => {
    const h = setup(saved());
    h.set.mockRejectedValue({ code: 'timeout' });
    await h.session.load();
    const oldWriter = h.playable().writer;
    h.harvest();
    await settle();
    expect(h.timer.pending.size).toBe(1);
    h.get.mockRejectedValue(new Error('재로드 실패'));
    await h.session.load();
    expect(h.timer.pending.size).toBe(0);
    oldWriter.flush();
    expect(oldWriter.dispatch({ type: 'harvest', cell: cell(1) })).toMatchObject({ code: 'inactive_session' });
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.session.getState()).not.toHaveProperty('writer');
  });

  it.each([true, false])('destroy 후 늦은 저장 응답 성공=%s는 UI·재시도를 만들지 않는다', async success => {
    const h = setup(saved());
    const request = deferred<void>();
    h.set.mockReturnValue(request.promise);
    await h.session.load();
    const oldWriter = h.playable().writer;
    h.harvest();
    h.session.destroy();
    h.onChange.mockClear();
    if (success) request.resolve(); else request.reject({ code: 'timeout' });
    await settle();
    oldWriter.flush();
    await h.session.load();
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.timer.pending.size).toBe(0);
    expect(h.set).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('새 playable 이후 이전 저장 응답 성공=%s는 새 ACK·오류 상태에 영향을 주지 않는다', async success => {
    const h = setup(saved());
    const old = deferred<void>();
    const current = deferred<void>();
    h.set.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await h.session.load();
    h.harvest(0);
    await h.session.load();
    h.harvest(1);
    h.onChange.mockClear();
    if (success) old.resolve(); else old.reject({ code: 'timeout' });
    await settle();
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.playable().writer.getSaveState()).toMatchObject({ localSequence: 1, ackedSequence: 0, dirty: true, inFlight: true });
    expect(h.timer.pending.size).toBe(0);
    current.resolve();
    await settle();
    expect(h.playable().writer.getSaveState().dirty).toBe(false);
  });

  it('동기적으로 던진 bridge 오류도 로드 실패 또는 미저장으로 분리한다', async () => {
    const h = setup(saved());
    h.get.mockImplementationOnce(() => { throw new Error('동기 읽기 실패'); });
    await h.session.load();
    expect(h.session.getState().status).toBe('load_error');
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    await h.session.load();
    h.set.mockImplementationOnce(() => { throw { code: 'host_error' }; });
    h.harvest();
    expect(h.playable().writer.getSaveState()).toMatchObject({ dirty: true, message: '저장 안 됨', retryScheduled: true });
  });

  it('destroy는 읽기 및 저장 retry 타이머를 정리한다', async () => {
    const loading = setup();
    loading.ready.mockReturnValue(new Promise(() => {}));
    const promise = loading.session.load();
    loading.session.destroy();
    await promise;
    expect(loading.timer.pending.size).toBe(0);
    expect(loading.set).not.toHaveBeenCalled();
    const saving = setup(saved());
    saving.set.mockRejectedValue({ code: 'timeout' });
    await saving.session.load();
    saving.harvest();
    await settle();
    saving.session.destroy();
    expect(saving.timer.pending.size).toBe(0);
  });

  it('저장 요청 시각을 유지해 ACK 대기 중 시계 역행도 다음 주기를 되돌리지 않는다', async () => {
    const h = setup(saved());
    h.set.mockReturnValue(new Promise(() => {}));
    await h.session.load();
    h.nowSec.mockReturnValue(2000);
    h.harvest(0);
    h.nowSec.mockReturnValue(500);
    h.harvest(1);
    expect(h.playable().garden.lastSavedAtSec).toBe(2000);
    expect(h.playable().garden.placements[1]).toMatchObject({ readyAtSec: 12800 });
  });
});
