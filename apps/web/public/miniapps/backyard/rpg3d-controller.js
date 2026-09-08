// @ts-check
/** 순수 논리 controller. 렌더 높이와 원격 저장을 소유하지 않는다. */
var BackyardRpg3dController = (() => {
  const rules=BackyardRpgRules;
  /** 저장 좌표를 논리 평면으로 복원한다. @param {RpgVector} saved */
  function fromSaved(saved) {
    if(!Number.isInteger(saved.x)||!Number.isInteger(saved.y)||saved.x<0||saved.x>511||saved.y<0||saved.y>383)throw Error('저장 좌표 범위가 올바르지 않습니다');
    return {x:saved.x*2,y:saved.y*2};
  }
  /** 논리 평면을 기존 정수 저장 단위로 양자화한다. @param {RpgVector} point */
  function toSaved(point) {
    if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<0||point.y<0||point.x>1022||point.y>766)throw Error('논리 좌표 범위가 올바르지 않습니다');
    return {x:Math.round(point.x/2),y:Math.round(point.y/2)};
  }
  /** 막힌 읽기 위치는 연결된 가장 가까운 타일로만 보정한다. 저장하지 않는다. @param {RpgVector} point */
  function safePosition(point) {
    if(rules.canStand(point.x,point.y))return {...point};
    const nav=rules.navigation();
    const points=[...nav.visited].map(key=>{const [col,row]=key.split(',').map(Number);return {x:col*32+16,y:row*32+16};});
    points.sort((a,b)=>Math.hypot(a.x-point.x,a.y-point.y)-Math.hypot(b.x-point.x,b.y-point.y));
    if(!points.length)throw Error('걸을 수 있는 시작 위치가 없습니다');
    return points[0];
  }
  /** 축별로 최대 4px씩 검사해 미끄러짐과 얇은 장애물을 보존한다. @param {RpgVector} point @param {RpgVector} delta */
  function move(point,delta) {
    if(!Number.isFinite(delta.x)||!Number.isFinite(delta.y))return {...point};
    const steps=Math.max(1,Math.ceil(Math.hypot(delta.x,delta.y)/4));
    let {x,y}=point;
    for(let i=0;i<steps;i++) {if(rules.canStand(x+delta.x/steps,y))x+=delta.x/steps;if(rules.canStand(x,y+delta.y/steps))y+=delta.y/steps;}
    return {x,y};
  }
  /** 고정 60Hz 시계. reset 직후 첫 frame은 delta 0이다.
   * 저장 형식은 그대로 두고 **읽은 방향만** 복원한다 — 저장은 이미 direction을 담고 있었고
   * 슬라이스 4까지 그것을 버렸다(근접 대상이 방향으로 정해지므로 복원해야 한다).
   * @param {RpgVector} [initial] @param {number} [facing] */
  function create(initial=rules.fixture(),facing) {
    const restored=Number.isInteger(facing)&&Number(facing)>=0&&Number(facing)<=7?Number(facing):rules.fixture().direction;
    let point=safePosition(initial),direction=restored,accumulator=0,distance=0;
    /** @type {number|null} */ let previous=null;
    let input={x:0,y:0};
    return {
      /** 화면 축은 고정 방위각이므로 +x=동, -y=북이다. @param {RpgVector} value */
      input(value){input=rules.velocity(value.x,value.y,0);},
      reset(){input={x:0,y:0};previous=null;accumulator=0;},
      /** RAF timestamp를 받으며 누적은 100ms를 넘지 않는다. @param {number} now */
      frame(now){
        if(!Number.isFinite(now))return;
        const delta=previous===null?0:Math.max(0,Math.min(100,now-previous));previous=now;
        accumulator=Math.min(100,accumulator+delta);
        while(accumulator+1e-8>=1000/60){
          if(input.x||input.y)direction=(Math.round(Math.atan2(input.y,input.x)/(Math.PI/4))+8)%8;
          const next=move(point,{x:input.x/60,y:input.y/60});distance+=Math.hypot(next.x-point.x,next.y-point.y);point=next;accumulator-=1000/60;
        }
      },
      state(){const world=BackyardRpg3dTerrain.toWorld(point);return {...point,direction,distance,world:{...world,y:BackyardRpg3dTerrain.heightAt(world.x,world.z)}};},
      /** 행동 순간에도 논리 발 위치에서 다시 판정한다. @param {readonly RpgTarget[]} [targets] */
      target(targets=rules.sites){return rules.target(point,direction,targets);},
    };
  }
  return {fromSaved,toSaved,safePosition,move,create};
})();
