/** 브라우저의 실제 이벤트·RAF·timer·ResizeObserver를 계측하고 원본 API를 복구한다. */
(async () => {
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  const original = {
    add: EventTarget.prototype.addEventListener, remove: EventTarget.prototype.removeEventListener,
    raf: window.requestAnimationFrame, cancel: window.cancelAnimationFrame,
    timer: window.setTimeout, clear: window.clearTimeout, observer: window.ResizeObserver,
  };
  const listeners = [], frames = new Set(), timers = new Set(), observers = new Set();
  const samples = [];
  const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
  EventTarget.prototype.addEventListener = function(type, handler, options) {
    original.add.call(this, type, handler, options);
    if (!(this === window || this === document || this instanceof HTMLElement) || options?.signal?.aborted) return;
    if (listeners.some(item => item.target === this && item.type === type && item.handler === handler && item.capture === capture(options))) return;
    const record = { target: this, type, handler, capture: capture(options) }; listeners.push(record);
    if (options?.signal) original.add.call(options.signal, 'abort', () => { const index = listeners.indexOf(record); if (index >= 0) listeners.splice(index, 1); }, { once: true });
  };
  EventTarget.prototype.removeEventListener = function(type, handler, options) {
    original.remove.call(this, type, handler, options);
    const index = listeners.findIndex(item => item.target === this && item.type === type && item.handler === handler && item.capture === capture(options));
    if (index >= 0) listeners.splice(index, 1);
  };
  window.requestAnimationFrame = callback => { const id = original.raf.call(window, time => { frames.delete(id); callback(time); }); frames.add(id); return id; };
  window.cancelAnimationFrame = id => { frames.delete(id); original.cancel.call(window, id); };
  window.setTimeout = (callback, ms) => { const id = original.timer.call(window, () => { timers.delete(id); callback(); }, ms); timers.add(id); return id; };
  window.clearTimeout = id => { timers.delete(id); original.clear.call(window, id); };
  window.ResizeObserver = class extends original.observer {
    observe(...args) { observers.add(this); super.observe(...args); }
    disconnect() { observers.delete(this); super.disconnect(); }
  };
  const counts = () => ({ listeners: listeners.length, raf: frames.size, timers: timers.size, observers: observers.size });
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  try {
    for (let cycle = 0; cycle < 20; cycle++) {
      const app = BackyardApp.createApp({ ready: async () => undefined, state: { get: async () => null, set: async () => { throw Error('host_error'); } } });
      await settle(); const active = counts();
      if (active.raf !== 1 || active.timers !== 1 || active.observers !== 1) throw Error('활성 자원 검증 실패: ' + JSON.stringify(active));
      app.destroy(); await settle(); const destroyed = counts(); samples.push({ cycle: cycle + 1, active, destroyed });
      if (Object.values(destroyed).some(value => value !== 0)) throw Error('정리 후 자원 잔존: ' + JSON.stringify(destroyed));
    }
    return samples;
  } finally {
    EventTarget.prototype.addEventListener = original.add; EventTarget.prototype.removeEventListener = original.remove;
    window.requestAnimationFrame = original.raf; window.cancelAnimationFrame = original.cancel;
    window.setTimeout = original.timer; window.clearTimeout = original.clear; window.ResizeObserver = original.observer;
  }
})()
