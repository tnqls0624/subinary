// @ts-check
/** @typedef {{x:number,y:number}} RpgVector */
/** @typedef {{x:number,y:number,width:number,height:number}} RpgRect */
/** 엔진·DOM 없는 임시 지도와 이동 의도. */
var BackyardRpgRules = (() => {
  const tile = 32, width = 1024, height = 768;
  const pond = Object.freeze({ x: 640, y: 128, width: 320, height: 288 });
  const house = Object.freeze({ x: 160, y: 480, width: 128, height: 64 });
  const trees = Object.freeze([{x:112,y:272},{x:240,y:240},{x:368,y:176},{x:400,y:352},{x:112,y:400}]);
  const obstacles = Object.freeze([
    pond, house,
    {x:0,y:0,width,height:16},{x:0,y:height-16,width,height:16},
    {x:0,y:0,width:16,height},{x:width-16,y:0,width:16,height},
    ...trees.map(t => ({x:t.x-8,y:t.y-12,width:16,height:16})),
  ]);
  /** 패드 좌표를 정규화한 8방향 속도로 바꾼다. 비정상 입력은 정지한다.
   * @param {number} x @param {number} y @param {number} [deadZone] @returns {RpgVector} */
  function velocity(x, y, deadZone = 8) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x,y) <= deadZone) return {x:0,y:0};
    const angle = Math.round(Math.atan2(y,x)/(Math.PI/4))*Math.PI/4;
    return {x:Math.cos(angle)*96,y:Math.sin(angle)*96};
  }
  /** 발 충돌체의 통행 가능 여부를 판정한다. @param {number} x @param {number} y @returns {boolean} */
  function canStand(x,y) {
    return Number.isFinite(x) && Number.isFinite(y) && x>=7 && y>=10 && x<=width-7 && y<=height &&
      !obstacles.some(r=>x+7>r.x && x-7<r.x+r.width && y>r.y && y-10<r.y+r.height);
  }
  /** 새 산책의 고정 fixture를 반환한다. @returns {{x:number,y:number,direction:number,outfit:number}} */
  function fixture() { return {x:240,y:592,direction:6,outfit:0}; }
  return Object.freeze({tile,cols:32,rows:24,width,height,pond,house,trees,obstacles,velocity,canStand,fixture});
})();
