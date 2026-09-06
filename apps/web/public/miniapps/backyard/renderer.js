// @ts-check
/** @typedef {{selected:Cell|null,preview:Cell|null,allowed:boolean}} GardenView */
/** canvas에는 마당과 선택 표시만 그린다. */
var BackyardRenderer = (() => {
  /** @param {HTMLCanvasElement} canvas DPR과 CSS 좌표를 분리한 표현 어댑터를 만든다. */
  function createRenderer(canvas) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('마당을 그릴 수 없어요');
    const ctx = context;
    const balance = BackyardBalance.createBalance();
    const colors = {soil:'#e5d8bb',tile:'#eee4cf',green:'#648764',leaf:'#9ab583',pot:'#bf795c',ink:'#514c40',water:'#88b7bb',fruit:'#dfac50'};
    /** @type {{garden:Garden,view:GardenView,nowSec:number}|null} */ let last = null;
    let destroyed = false;
    /** @type {{cell:Cell,atMs:number}[]} */ let harvests=[];
    /** CSS 크기와 현재 DPR에 맞춰 버퍼를 다시 잡는다. */
    function resize() {
      if (destroyed) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1,Math.round(rect.width*dpr));
      canvas.height = Math.max(1,Math.round(rect.height*dpr));
      if (last) render(last.garden,last.view,last.nowSec);
    }
    /** @param {number} x @param {number} y @param {number} w @param {number} h @param {string} color 둥근 도형을 그린다. */
    function box(x,y,w,h,color) { ctx.fillStyle=color; ctx.beginPath(); ctx.roundRect(x,y,w,h,4); ctx.fill(); }
    /** @param {number} x @param {number} y @param {number} rx @param {number} ry @param {string} color 타원으로 잎과 그림자를 그린다. */
    function oval(x,y,rx,ry,color) { ctx.fillStyle=color; ctx.beginPath(); ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2); ctx.fill(); }
    /** @param {Garden} garden @param {GardenView} view @param {number} nowSec 규칙의 판정 결과를 도형으로 표현한다. */
    function render(garden,view,nowSec,animationMs=performance.now()) {
      if (destroyed) return;
      last={garden,view,nowSec};
      ctx.setTransform(canvas.width/320,0,0,canvas.height/320,0,0);
      ctx.clearRect(0,0,320,320);
      for(let row=0;row<balance.rows;row++) for(let col=0;col<balance.cols;col++) box(col*80+2,row*80+2,76,76,(row+col)%2 ? colors.soil : colors.tile);
      for(const item of garden.placements) {
        const x=item.cell.col*80+40, baseY=item.cell.row*80+43;
        const remaining=item.kind==='p' ? item.readyAtSec-Math.max(nowSec,garden.lastSavedAtSec) : 0;
        const ripe=item.kind==='p' && remaining<=0;
        // CSS 좌표에서 진폭 2px, 주기 1.4초를 유지한다. 그림자는 바닥에 고정한다.
        const y=baseY+(ripe ? Math.sin(animationMs/1400*Math.PI*2)*2*320/(canvas.getBoundingClientRect().height||320) : 0);
        ctx.globalAlpha=.13; oval(x,baseY+20,24,7,colors.ink); ctx.globalAlpha=1;
        if(item.kind==='p') {
          ctx.fillStyle=colors.pot; ctx.beginPath(); ctx.moveTo(x-19,y); ctx.lineTo(x+19,y); ctx.lineTo(x+14,y+22); ctx.lineTo(x-14,y+22); ctx.closePath(); ctx.fill();
          box(x-21,y-3,42,7,colors.pot);
          // 시작 시각이 없는 DTO이므로 진행률을 추정하지 않고 남은 시간으로 새싹·자람·익음을 구분한다.
          const grown=remaining<=balance.boostedGrowthSec/2;
          box(x-2,y-(grown?24:12),4,grown?24:12,colors.green);
          oval(x-7,y-(grown?18:9),grown?11:7,5,colors.green);
          if(grown) oval(x+9,y-26,11,5,colors.leaf);
          if(ripe) { oval(x-9,y-8,8,8,colors.fruit); oval(x+10,y-15,9,9,colors.fruit); }
        } else if(item.kind==='w') {
          box(x-22,y-2,44,23,colors.ink); oval(x,y-2,22,10,colors.tile); oval(x,y-2,16,6,colors.water);
          box(x-21,y-28,4,28,colors.pot); box(x+17,y-28,4,28,colors.pot);
          ctx.fillStyle=colors.pot; ctx.beginPath(); ctx.moveTo(x-29,y-26); ctx.lineTo(x,y-46); ctx.lineTo(x+29,y-26); ctx.closePath(); ctx.fill();
        } else { box(x-22,y-28,44,20,colors.green); box(x-25,y-4,50,9,colors.pot); box(x-20,y+4,7,17,colors.ink); box(x+13,y+4,7,17,colors.ink); }
      }
      harvests=harvests.filter(effect=>animationMs-effect.atMs<700);
      for(const effect of harvests) {
        const progress=Math.max(0,(animationMs-effect.atMs)/700);
        ctx.globalAlpha=1-progress; ctx.fillStyle=colors.ink; ctx.font='bold 18px system-ui'; ctx.textAlign='center';
        ctx.fillText('+1',effect.cell.col*80+40,effect.cell.row*80+28-progress*24); ctx.globalAlpha=1;
      }
      if(view.preview) { ctx.fillStyle=view.allowed ? '#64876444' : '#bf795c66'; ctx.fillRect(view.preview.col*80+2,view.preview.row*80+2,76,76); }
      if(view.selected) { ctx.strokeStyle=colors.ink; ctx.lineWidth=3; ctx.setLineDash([5,4]); ctx.strokeRect(view.selected.col*80+5,view.selected.row*80+5,70,70); ctx.setLineDash([]); }
    }
    /** @param {number} clientX @param {number} clientY @returns {Cell|null} 오른쪽과 아래 경계는 마당 밖이다. */
    function hitTest(clientX,clientY) {
      const rect=canvas.getBoundingClientRect();
      if(destroyed || !Number.isFinite(clientX) || !Number.isFinite(clientY) || rect.width<=0 || rect.height<=0 || clientX<rect.left || clientY<rect.top || clientX>=rect.right || clientY>=rect.bottom) return null;
      return {row:Math.floor((clientY-rect.top)/rect.height*balance.rows),col:Math.floor((clientX-rect.left)/rect.width*balance.cols)};
    }
    const observer=new ResizeObserver(resize); observer.observe(canvas); window.addEventListener('resize',resize); resize();
    /** @param {Cell} cell @param {number} [atMs] 수확 효과는 저장하지 않고 짧게 표시한다. */
    function harvest(cell,atMs=performance.now()) { if(!destroyed) harvests.push({cell,atMs}); }
    /** 표현 리스너를 해제한다. */
    function destroy() { destroyed=true; last=null; harvests=[]; observer.disconnect(); window.removeEventListener('resize',resize); }
    return {render,hitTest,resize,harvest,destroy};
  }
  return {createRenderer};
})();
