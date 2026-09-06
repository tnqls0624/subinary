/// <reference path="../../public/miniapps/backyard/input.js" />
/// <reference path="../../public/miniapps/backyard/renderer.js" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** 실제 이벤트 등록 코드에 좌표와 취소 이벤트를 전달한다. */
function setup() {
  const canvas = new EventTarget();
  const window = new EventTarget();
  const context = createContext({ window });
  runInContext(readFileSync(resolve(import.meta.dirname, '../../public/miniapps/backyard/input.js'), 'utf8'), context);
  const api = runInContext('BackyardInput', context) as typeof BackyardInput;
  const onTap = vi.fn();
  const onPreview = vi.fn();
  const input = api.createInput(canvas as HTMLCanvasElement, {
    hitTest: (x, y) => x >= 0 && x < 320 && y >= 0 && y < 320 ? { row: Math.floor(y / 80), col: Math.floor(x / 80) } : null,
    onTap, onPreview,
  });
  const emit = (type: string, x = 40, y = 40, id = 1): void => {
    const event = new Event(type);
    Object.assign(event, { clientX: x, clientY: y, pointerId: id, isPrimary: id === 1, button: 0 });
    (type === 'pointerdown' ? canvas : window).dispatchEvent(event);
  };
  return { input, emit, onTap, onPreview };
}

describe('배포 탭 입력', () => {
  it('같은 칸의 정상 탭은 한 번 전달한다', () => {
    const h = setup(); h.emit('pointerdown'); h.emit('pointerup', 43, 42);
    expect(h.onTap).toHaveBeenCalledExactlyOnceWith({ row: 0, col: 0 });
  });
  it.each(['pointercancel', 'scroll', 'blur'])('%s 이후에는 행동이 없다', (type) => {
    const h = setup(); h.emit('pointerdown'); h.emit(type); h.emit('pointerup'); expect(h.onTap).not.toHaveBeenCalled();
  });
  it('8px 넘게 움직인 뒤 출발점으로 돌아와도 취소된다', () => {
    const h = setup(); h.emit('pointerdown'); h.emit('pointermove', 50); h.emit('pointerup'); expect(h.onTap).not.toHaveBeenCalled();
  });
  it('같은 칸이라도 pointermove 없이 멀리 떨어진 up을 거절한다', () => {
    const h = setup(); h.emit('pointerdown'); h.emit('pointerup', 60); expect(h.onTap).not.toHaveBeenCalled();
  });
  it('경계 밖 및 다른 칸으로 끝나면 행동이 없다', () => {
    const h = setup(); h.emit('pointerdown', 319); h.emit('pointerup', 320); h.emit('pointerdown', 79); h.emit('pointerup', 81); expect(h.onTap).not.toHaveBeenCalled();
  });
  it('다중 포인터와 해제 후 입력은 행동이 없다', () => {
    const h = setup(); h.emit('pointerdown'); h.emit('pointerdown', 40, 40, 2); h.emit('pointerup');
    h.input.destroy(); h.emit('pointerdown'); h.emit('pointerup'); expect(h.onTap).not.toHaveBeenCalled();
  });
});

describe('배포 renderer 좌표', () => {
  it('DPR·리사이즈·모서리에서 CSS 좌표로만 칸을 찾는다', () => {
    const window = Object.assign(new EventTarget(), { devicePixelRatio: 2 });
    let size = 280;
    const canvas = { width: 0, height: 0, getContext: () => ({}), getBoundingClientRect: () => ({ left: 10, top: 20, right: 10 + size, bottom: 20 + size, width: size, height: size }) };
    const disconnect = vi.fn();
    class ResizeObserver { observe(): void {} disconnect = disconnect; }
    const context = createContext({ window, ResizeObserver });
    for (const name of ['balance', 'rules', 'renderer']) runInContext(readFileSync(resolve(import.meta.dirname, `../../public/miniapps/backyard/${name}.js`), 'utf8'), context);
    const api = runInContext('BackyardRenderer', context) as typeof BackyardRenderer;
    const renderer = api.createRenderer(canvas as unknown as HTMLCanvasElement);
    expect(canvas.width).toBe(560);
    expect(renderer.hitTest(10, 20)).toEqual({ row: 0, col: 0 });
    expect(renderer.hitTest(289.99, 299.99)).toEqual({ row: 3, col: 3 });
    expect(renderer.hitTest(290, 100)).toBeNull(); expect(renderer.hitTest(30, 300)).toBeNull();
    expect(renderer.hitTest(Number.NaN, 20)).toBeNull(); expect(renderer.hitTest(9, 20)).toBeNull();
    size = 320; window.devicePixelRatio = 3; renderer.resize();
    expect(canvas.width).toBe(960); expect(renderer.hitTest(329, 339)).toEqual({ row: 3, col: 3 });
    renderer.destroy(); expect(disconnect).toHaveBeenCalledOnce(); expect(renderer.hitTest(10, 20)).toBeNull();
  });
});
