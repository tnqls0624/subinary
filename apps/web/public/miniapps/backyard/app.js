// @ts-check
/** 세션과 DOM을 조립한다. 화면에서 저장 API를 직접 호출하지 않는다. */
var BackyardApp = (() => {
  /** @param {GardenBridge} bridge 실제 브릿지 또는 로컬 검증용 저장 의존성을 연결한다. */
  function createApp(bridge) {
    /** @param {string} id 필수 요소 누락을 명확하게 보고한다. */
    function element(id) { const value=document.getElementById(id); if(!value) throw new Error(`화면 요소가 없어요: ${id}`); return value; }
    /** @param {string} id 버튼의 DOM 타입을 확인한다. */
    function button(id) { const value=element(id); if(!(value instanceof HTMLButtonElement)) throw new Error(`버튼이 아니에요: ${id}`); return value; }
    const canvas=element('yard');
    if(!(canvas instanceof HTMLCanvasElement)) throw new Error('마당 canvas가 없어요');
    const renderer=BackyardRenderer.createRenderer(canvas);
    const rules=BackyardRules.createRules(), balance=BackyardBalance.createBalance();
    const play=element('play'), loading=element('loading'), hint=element('hint'), save=element('save');
    const retry=button('retry'), moveButton=button('move'), cancelButton=button('cancel');
    const shops=[{kind:/** @type {GardenKind} */('p'),name:'화분',button:button('buy-p')},{kind:/** @type {GardenKind} */('w'),name:'우물',button:button('buy-w')},{kind:/** @type {GardenKind} */('c'),name:'의자',button:button('buy-c')}];
    /** @type {'harvest'|'move'|GardenKind} */ let mode='harvest';
    /** @type {Cell|null} */ let selected=null;
    /** @type {Cell|null} */ let preview=null;
    /** @type {Cell} */ let keyboardCell={row:0,col:0};
    let destroyed=false, completedDismissed=false;
    /** @type {number|null} */ let frame=null;
    const complete=element('complete'), closeComplete=button('close-complete');
    let message='익은 화분을 눌러 열매를 거두세요';
    const nowSec=()=>Math.floor(Date.now()/1000);
    /** @param {Cell} cell @returns {Action|null} 선택 모드를 규칙 Action으로 변환한다. */
    function actionFor(cell) {
      if(mode==='move') return selected ? {type:'move',from:selected,to:cell} : null;
      return mode==='harvest' ? {type:'harvest',cell} : {type:'buyAndPlace',kind:mode,cell};
    }
    /** @param {GardenSessionState} state 저장 상태와 마당 표시를 함께 갱신한다. */
    function paint(state) {
      if(destroyed) return;
      const playable=state.status==='playable';
      const wasCompleteHidden=complete.hidden;
      complete.hidden=!playable||completedDismissed||(playable&&!rules.isComplete(state.garden));
      if(wasCompleteHidden&&!complete.hidden) closeComplete.focus(); play.hidden=!playable; loading.hidden=playable;
      retry.hidden=state.status==='loading'||state.status==='waiting_host';
      if(state.status!=='playable') {
        save.textContent='';
        element('load-message').textContent=state.status==='unsupported_version' ? '앱을 업데이트해 주세요' : state.status==='invalid_state' ? '저장된 마당을 읽을 수 없어요' : state.status==='load_error' ? '불러오지 못했어요 · 다시 시도해 주세요' : '마당을 불러오고 있어요';
        return;
      }
      const status=state.writer.getSaveState();
      save.textContent=status.dirty ? (status.error ? '저장 안 됨' : '저장 중…') : '저장됨'; save.dataset.dirty=String(status.dirty);
      element('fruit').textContent=`열매 ${state.garden.fruit}`;
      element('warning').textContent=state.warnings.length ? '일부 물건을 복원하지 못했어요' : '';
      hint.textContent=message;
      moveButton.setAttribute('aria-pressed',String(mode==='move'));
      for(const shop of shops) {
        const price=shop.kind==='p' ? rules.potPrice(state.garden.purchasedPots) : shop.kind==='w' ? balance.wellPrice : balance.chairPrice;
        shop.button.textContent=state.garden.unlocked.includes(shop.kind) ? `${shop.name} · ${price}` : `${shop.name} · 잠김`;
        shop.button.disabled=!state.garden.unlocked.includes(shop.kind);
        shop.button.setAttribute('aria-pressed',String(mode===shop.kind));
      }
      const action=preview ? actionFor(preview) : null;
      const result=action ? rules.applyAction(state.garden,action,nowSec()) : null;
      if(result?.status==='ok' && result.events.some(event=>event.type==='swapped')) hint.textContent='이 칸의 물건과 자리를 바꿔요';
      renderer.render(state.garden,{selected,preview,allowed:result?.status==='ok'||result?.status==='noop'},nowSec());
    }
    const session=BackyardSession.createSession({bridge,nowSec,seed:()=>crypto.getRandomValues(new Uint32Array(1))[0],setTimer:(fn,ms)=>window.setTimeout(fn,ms),clearTimer:id=>window.clearTimeout(id),onChange:paint});
    /** @param {Cell} cell 확정 행동은 playable writer에만 전달한다. */
    function tap(cell) {
      const state=session.getState(); if(state.status!=='playable') return;
      if(mode==='move' && !selected) { selected=cell; message='도착할 칸을 누르세요 · 물건이 있으면 자리 바꾸기'; paint(state); return; }
      const action=actionFor(cell); if(!action) return;
      const result=state.writer.dispatch(action);
      if(result.status==='error') message=result.message;
      else {
        const harvested=result.status==='ok' && result.events.some(event=>event.type==='harvested');
        if(harvested) renderer.harvest(cell);
        selected=null; mode='harvest'; message=result.status==='noop' ? '같은 자리에 두었어요' : harvested ? '열매 +1 · 다시 자라고 있어요' : '익은 화분을 눌러 열매를 거두세요';
      }
      paint(session.getState());
    }
    const input=BackyardInput.createInput(canvas,{hitTest:renderer.hitTest,onTap:tap,onPreview:cell=>{preview=cell;paint(session.getState());}});
    const controller=new AbortController();
    /** @param {HTMLElement} target @param {string} type @param {EventListener} handler 연결 수명에 속한 DOM 이벤트를 등록한다. */
    function listen(target,type,handler) { target.addEventListener(type,handler,{signal:controller.signal}); }
    function reset() { input.cancel(); mode='harvest'; selected=null; preview=null; message='익은 화분을 눌러 열매를 거두세요'; paint(session.getState()); }
    listen(closeComplete,'click',()=>{completedDismissed=true;complete.hidden=true;moveButton.focus();});
    listen(complete,'keydown',event=>{
      if(event instanceof KeyboardEvent && (event.key==='Escape'||event.key==='Tab')) {
        event.preventDefault();
        if(event.key==='Escape') closeComplete.click(); else closeComplete.focus();
      }
    });
    listen(cancelButton,'click',reset);
    listen(moveButton,'click',()=>{reset();mode='move';message='옮길 물건을 누르세요';paint(session.getState());});
    for(const shop of shops) listen(shop.button,'click',()=>{reset();mode=shop.kind;message=`${shop.name}을 놓을 빈 칸을 누르세요`;paint(session.getState());});
    listen(retry,'click',()=>{reset();void session.load();});
    listen(canvas,'keydown',event=>{
      if(!(event instanceof KeyboardEvent)) return;
      const delta={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[event.key];
      if(delta) { event.preventDefault(); keyboardCell={row:Math.max(0,Math.min(balance.rows-1,keyboardCell.row+delta[0])),col:Math.max(0,Math.min(balance.cols-1,keyboardCell.col+delta[1]))}; preview=keyboardCell; paint(session.getState()); }
      else if(event.key==='Enter'||event.key===' ') { event.preventDefault();tap(keyboardCell); }
      else if(event.key==='Escape') reset();
    });
    /** 한 개 RAF만 예약하고 절대 시각으로 성장 상태를 다시 그린다. */
    function tick() {
      frame=null;
      if(destroyed||document.hidden) return;
      paint(session.getState());
      frame=window.requestAnimationFrame(tick);
    }
    /** 숨김 중에는 렌더를 멈추고 복귀 즉시 성장 상태를 갱신한다. */
    function visibility() {
      if(destroyed) return;
      if(frame!==null) window.cancelAnimationFrame(frame);
      frame=null; input.cancel();
      const state=session.getState();
      if(document.hidden) { if(state.status==='playable') state.writer.flush(); }
      else { renderer.resize(); tick(); }
    }
    document.addEventListener('visibilitychange',visibility,{signal:controller.signal});
    window.addEventListener('pagehide',destroy,{signal:controller.signal});
    /** 연결한 세션과 표현 어댑터를 해제한다. */
    function destroy() { if(destroyed) return;destroyed=true;if(frame!==null) window.cancelAnimationFrame(frame);frame=null;controller.abort();input.destroy();renderer.destroy();session.destroy(); }
    void session.load();
    tick();
    return {destroy,session};
  }
  return {createApp};
})();
// 실제 페이지는 공용 클라이언트를 사용하고, 검증은 팩토리에 가짜 저장소를 주입한다.
if(typeof document!=='undefined') {
  const root=/** @type {typeof globalThis & {MiniApp?:GardenBridge}} */(globalThis);
  if(root.MiniApp) {
    BackyardApp.createApp(root.MiniApp);
    // 소유한 공용 클라이언트의 진행 중 요청도 페이지 종료 때 정리한다.
    const client=/** @type {GardenBridge & {destroy?:()=>void}} */(root.MiniApp);
    window.addEventListener('pagehide',()=>client.destroy?.(),{once:true});
    window.addEventListener('pageshow',event=>{if(event.persisted) window.location.reload();});
  }
}
