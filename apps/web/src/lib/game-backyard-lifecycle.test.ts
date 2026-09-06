/// <reference path="../../public/miniapps/backyard/app.js" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { cell, loadBackyard, settle } from './game-backyard-test-utils';

/** 실제 등록과 AbortSignal 해제를 포함해 남아 있는 리스너를 센다. */
class Element extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  hidden = false;
  inert = false;
  textContent = '';
  dataset: Record<string, string> = {};
  disabled = false;
  focus(): void {}
  setAttribute(): void {}
  click(): void { this.dispatchEvent(new Event('click')); }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options);
    if (!listener || (typeof options === 'object' && options.signal?.aborted)) return;
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener); this.listeners.set(type, bucket);
    if (typeof options === 'object') options.signal?.addEventListener('abort', () => bucket.delete(listener), { once: true });
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options);
    if (listener) this.listeners.get(type)?.delete(listener);
  }
  count(): number { return [...this.listeners.values()].reduce((sum, bucket) => sum + bucket.size, 0); }
}

/** DOM과 시계만 대체하며 app·input·renderer·session은 배포 원본을 실행한다. */
function harness() {
  let time = 1_000_000;
  let id = 0;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  const observers = new Set<ResizeObserver>();
  const drawing = { setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), ellipse: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fillRect: vi.fn(), setLineDash: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), fillStyle: '', globalAlpha: 1 };
  class Canvas extends Element {
    width = 0; height = 0;
    getContext() { return drawing; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 280, bottom: 280, width: 280, height: 280 }; }
  }
  class Observer {
    observe(): void { observers.add(this as unknown as ResizeObserver); }
    disconnect(): void { observers.delete(this as unknown as ResizeObserver); }
  }
  const nodes = new Map<string, Element>();
  for (const name of ['play', 'loading', 'hint', 'save', 'retry', 'move', 'cancel', 'buy-p', 'buy-w', 'buy-c', 'complete', 'close-complete', 'fruit', 'warning', 'load-message']) nodes.set(name, new Element());
  nodes.set('yard', new Canvas()); nodes.get('complete')!.hidden = true;
  const document = Object.assign(new Element(), { getElementById: (name: string) => nodes.get(name) });
  const window = Object.assign(new Element(), {
    devicePixelRatio: 2,
    setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; }, clearTimeout: (key: number) => { timers.delete(key); },
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (key: number) => { frames.delete(key); },
  });
  const context = createContext({ document, window, HTMLButtonElement: Element, HTMLCanvasElement: Canvas, AbortController, ResizeObserver: Observer, Date: { now: () => time }, performance: { now: () => time }, crypto: { getRandomValues: (array: Uint32Array) => array.fill(1) } });
  for (const name of ['balance', 'rules', 'codec', 'session', 'renderer', 'input', 'app']) runInContext(readFileSync(resolve(import.meta.dirname, `../../public/miniapps/backyard/${name}.js`), 'utf8'), context);
  const app = runInContext('BackyardApp', context) as typeof BackyardApp;
  const renderer = runInContext('BackyardRenderer', context) as typeof BackyardRenderer;
  return { app, renderer, drawing, canvas: nodes.get('yard') as unknown as HTMLCanvasElement, nodes, document, window,
    setTime: (seconds: number) => { time = seconds * 1000; },
    frame: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); },
    resources: () => ({ listeners: document.count() + window.count() + [...nodes.values()].reduce((sum, node) => sum + node.count(), 0), timers: timers.size, frames: frames.size, observers: observers.size }),
  };
}

/** fixture를 변경하지 않는 정상 저장 의존성이다. */
function bridge(value: unknown = null): GardenBridge {
  return { ready: async () => undefined, state: { get: async () => value, set: async () => undefined } };
}

describe('배포 화면 마감과 수명', () => {
  it('저장 재시도 대기 중 20회 생성·해제해도 리스너·RAF·timer·observer가 남지 않는다', async () => {
    const h = harness();
    for (let index = 0; index < 20; index++) {
      const failing = bridge(); failing.state.set = async () => { throw new Error('host_error'); };
      const app = h.app.createApp(failing); await settle();
      expect(h.resources().frames).toBe(1); expect(h.resources().timers).toBe(1);
      app.destroy(); app.destroy(); await settle();
      expect(h.resources()).toEqual({ listeners: 0, timers: 0, frames: 0, observers: 0 });
    }
  });
  it('숨김은 RAF를 멈추고 복귀는 한 개만 재개하며 늦은 로드는 해제 후 화면을 바꾸지 않는다', async () => {
    const h = harness(); const app = h.app.createApp(bridge()); await settle();
    h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange'));
    expect(h.resources().frames).toBe(0);
    h.setTime(11800); h.document.hidden = false;
    h.document.dispatchEvent(new Event('visibilitychange')); h.document.dispatchEvent(new Event('visibilitychange'));
    expect(h.resources().frames).toBe(1); h.frame(); expect(h.resources().frames).toBe(1);
    app.destroy();
    let resolve!: (value: unknown) => void;
    const delayed = bridge(); delayed.state.get = () => new Promise(done => { resolve = done; });
    const next = h.app.createApp(delayed); await settle(); next.destroy();
    const before = h.nodes.get('save')!.textContent; resolve(null); await settle();
    expect(h.nodes.get('save')!.textContent).toBe(before);
    expect(h.resources()).toEqual({ listeners: 0, timers: 0, frames: 0, observers: 0 });
  });
  it('16칸과 3종 해금으로 완료를 표시하고 닫은 뒤 swap과 저장이 가능하다', async () => {
    const h = harness(); const { rules, codec } = loadBackyard();
    const garden: Garden = { ...rules.createInitialGarden(1000, 1), unlocked: ['p', 'w', 'c'], placements: Array.from({ length: 16 }, (_, index) => index === 0 ? { kind: 'w', cell: cell(index) } : { kind: 'p', cell: cell(index), readyAtSec: 11800 }) };
    const dto = codec.serializeGarden(garden, 1000); if (dto.status !== 'ok') throw Error('fixture 직렬화 실패');
    const app = h.app.createApp(bridge(dto.value)); await settle();
    expect(h.nodes.get('complete')!.hidden).toBe(false); expect(h.nodes.get('play')!.inert).toBe(true);
    h.nodes.get('close-complete')!.click(); expect(h.nodes.get('play')!.inert).toBe(false); h.nodes.get('move')!.click();
    const tap = (x: number): void => {
      for (const type of ['pointerdown', 'pointerup']) {
        const event = new Event(type); Object.assign(event, { clientX: x, clientY: 35, pointerId: 1, isPrimary: true, button: 0 });
        (type === 'pointerdown' ? h.canvas : h.window).dispatchEvent(event);
      }
    };
    tap(35); tap(105); await settle();
    const state = app.session.getState(); if (state.status !== 'playable') throw Error('복원 실패');
    expect(state.garden.placements.find(item => item.kind === 'w')?.cell).toEqual(cell(1));
    expect(state.writer.getSaveState().dirty).toBe(false); expect(h.nodes.get('complete')!.hidden).toBe(true);
    const saved = codec.serializeGarden(state.garden, 1000); if (saved.status !== 'ok') throw Error('저장 실패');
    expect(Object.keys(saved.value)).toEqual(['v', 't', 's', 'f', 'n', 'k', 'p']);
    app.destroy();
  });
  it('익은 화분만 CSS 2px·1400ms bob이며 그림자는 고정되고 수확 효과는 사라진다', () => {
    const h = harness(); const renderer = h.renderer.createRenderer(h.canvas); const { rules } = loadBackyard();
    const garden = rules.createInitialGarden(1000, 1); const view = { selected: null, preview: null, allowed: false };
    const draw = (ms: number, now = 1000): number[][] => {
      h.drawing.ellipse.mockClear(); renderer.render(garden, view, now, ms);
      return h.drawing.ellipse.mock.calls.map(args => args as number[]);
    };
    const base = draw(0), top = draw(350), cycle = draw(1400);
    expect((top[1][1] - base[1][1]) * 280 / 320).toBeCloseTo(2);
    expect(top[0]).toEqual(base[0]); expect(cycle).toEqual(base);
    const growing = { ...garden, placements: [{ kind: 'p' as const, cell: cell(0), readyAtSec: 11800 }, { kind: 'w' as const, cell: cell(1) }, { kind: 'c' as const, cell: cell(2) }] };
    h.drawing.ellipse.mockClear(); renderer.render(growing, view, 1000, 0); const still = h.drawing.ellipse.mock.calls.slice();
    h.drawing.ellipse.mockClear(); renderer.render(growing, view, 1000, 350); expect(h.drawing.ellipse.mock.calls).toEqual(still);
    renderer.harvest(cell(0), 0); renderer.render(garden, view, 1000, 350); expect(h.drawing.fillText).toHaveBeenCalled();
    h.drawing.fillText.mockClear(); renderer.render(garden, view, 1000, 700); expect(h.drawing.fillText).not.toHaveBeenCalled(); renderer.destroy();
  });
});
