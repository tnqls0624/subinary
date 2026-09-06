// @ts-check
var BackyardRpgInput = (() => {
  /** 패드·키보드 소유권과 취소 수명을 묶는다.
   * @param {HTMLElement} pad @param {(velocity:RpgVector)=>void} change @param {()=>boolean} [enabled] @param {()=>void} [act]
   * @returns {{destroy:()=>void,reset:()=>void}} */
  function create(pad, change, enabled = ()=>true, act = ()=>{}) {
    const listeners = new AbortController();
    const options = {signal:listeners.signal};
    /** @type {number|null} */ let owner = null;
    /** @type {Set<string>} */ const keys = new Set();
    const knob = pad.querySelector('span');
    /** 입력 해제와 물리 속도 0을 같은 이벤트 안에서 적용한다. */
    function reset() {
      const previous = owner; owner = null; keys.clear();
      if(previous !== null && pad.hasPointerCapture(previous)) pad.releasePointerCapture(previous);
      if(knob instanceof HTMLElement) knob.style.transform = '';
      change({x:0,y:0});
    }
    /** @param {PointerEvent} event */
    function move(event) {
      if(event.pointerId !== owner) return;
      const box = pad.getBoundingClientRect();
      const x = event.clientX-box.left-box.width/2, y = event.clientY-box.top-box.height/2;
      const ratio = Math.min(1,40/Math.max(1,Math.hypot(x,y)));
      if(knob instanceof HTMLElement) knob.style.transform = `translate(${x*ratio}px,${y*ratio}px)`;
      change(BackyardRpgRules.velocity(x,y));
    }
    pad.addEventListener('pointerdown', event => {
      if(!enabled() || owner !== null || event.button !== 0) return;
      event.preventDefault(); keys.clear(); owner = event.pointerId;
      pad.focus({preventScroll:true}); pad.setPointerCapture(owner); move(event);
    }, options);
    pad.addEventListener('pointermove',move,options);
    for(const name of ['pointerup','pointercancel','lostpointercapture']) {
      pad.addEventListener(name,event=>{if(event instanceof PointerEvent && event.pointerId===owner) reset();},options);
    }
    const accepted = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD']);
    for(const name of /** @type {const} */ (['keydown','keyup'])) window.addEventListener(name,event=>{
      if(!enabled()) return;
      if((event.code==='Enter'||event.code==='Space') && event.target===pad) {
        event.preventDefault();if(name==='keydown'&&!event.repeat)act();return;
      }
      if(!accepted.has(event.code)) return;
      event.preventDefault();
      if(owner !== null) return;
      if(name==='keydown') keys.add(event.code); else keys.delete(event.code);
      const x=Number(keys.has('ArrowRight')||keys.has('KeyD'))-Number(keys.has('ArrowLeft')||keys.has('KeyA'));
      const y=Number(keys.has('ArrowDown')||keys.has('KeyS'))-Number(keys.has('ArrowUp')||keys.has('KeyW'));
      change(BackyardRpgRules.velocity(x,y,0));
    },options);
    window.addEventListener('blur',reset,options);
    window.addEventListener('orientationchange',reset,options);
    window.addEventListener('resize',reset,options);
    document.addEventListener('visibilitychange',reset,options);
    return {reset,destroy(){reset();listeners.abort();}};
  }
  return {create};
})();
