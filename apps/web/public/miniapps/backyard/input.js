// @ts-check
/** 탭만 수락하고 이동·스크롤·취소는 행동으로 전달하지 않는다. */
var BackyardInput = (() => {
  /** @param {HTMLCanvasElement} canvas @param {{hitTest:(x:number,y:number)=>Cell|null,onTap:(cell:Cell)=>void,onPreview:(cell:Cell|null)=>void}} deps 입력 어댑터를 연결한다. */
  function createInput(canvas,deps) {
    /** @type {{id:number,x:number,y:number,cell:Cell}|null} */ let pending=null;
    /** 현재 제스처를 폐기한다. */
    function cancel() { pending=null; deps.onPreview(null); }
    /** @param {PointerEvent} event 시작 위치를 기억한다. */
    function down(event) {
      if(pending || !event.isPrimary || event.button!==0) { cancel(); return; }
      const cell=deps.hitTest(event.clientX,event.clientY);
      if(!cell) return;
      pending={id:event.pointerId,x:event.clientX,y:event.clientY,cell}; deps.onPreview(cell);
    }
    /** @param {PointerEvent} event 작은 손떨림만 허용한다. */
    function move(event) {
      if(!pending || pending.id!==event.pointerId) return;
      if(Math.hypot(event.clientX-pending.x,event.clientY-pending.y)>8) cancel();
    }
    /** @param {PointerEvent} event 같은 칸에서 끝난 탭만 확정한다. */
    function up(event) {
      const start=pending;
      const cell=deps.hitTest(event.clientX,event.clientY);
      cancel();
      if(start && cell && start.id===event.pointerId && Math.hypot(event.clientX-start.x,event.clientY-start.y)<=8 && start.cell.row===cell.row && start.cell.col===cell.col) deps.onTap(cell);
    }
    canvas.addEventListener('pointerdown',down); window.addEventListener('pointermove',move); window.addEventListener('pointerup',up);
    window.addEventListener('pointercancel',cancel); window.addEventListener('scroll',cancel,true); window.addEventListener('blur',cancel);
    /** 등록한 입력 리스너를 해제한다. */
    function destroy() { cancel(); canvas.removeEventListener('pointerdown',down); window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); window.removeEventListener('pointercancel',cancel); window.removeEventListener('scroll',cancel,true); window.removeEventListener('blur',cancel); }
    return {cancel,destroy};
  }
  return {createInput};
})();
