// @ts-check
/** @typedef {{x:number,y:number}} RpgVector */
/** @typedef {{x:number,y:number,width:number,height:number}} RpgRect */
/** @typedef {{id:string,kind:string,x:number,y:number,label:string}} RpgTarget */
/** @typedef {{id:string,kind:string,col:number,row:number}} RpgDecoration */
/** 엔진·DOM 없는 지도·통행·근접·배치 규칙. */
var BackyardRpgRules = (() => {
  const tile = 32, width = 1024, height = 768;
  const pond = Object.freeze({ x: 640, y: 128, width: 320, height: 288 });
  const house = Object.freeze({ x: 160, y: 480, width: 128, height: 64 });
  const trees = Object.freeze([{x:112,y:272},{x:240,y:240},{x:368,y:176},{x:400,y:352},{x:112,y:400},
    {x:80,y:112},{x:176,y:144},{x:304,y:112},{x:432,y:80},{x:80,y:336},{x:304,y:336},{x:432,y:240}]);
  // 계단형 물 마스크가 실제 둑 모양과 충돌을 함께 결정한다.
  const water = Object.freeze(Array.from({length:9},(_,i)=>({x:640+(i===0||i===8?32:0),y:128+i*32,width:i===0||i===8?256:320,height:32})));
  const paths = Object.freeze([{x:208,y:560,width:368,height:64},{x:496,y:96,width:64,height:528},
    {x:528,y:224,width:112,height:64},{x:576,y:160,width:64,height:256},{x:144,y:96,width:416,height:64}]);
  /** @type {readonly RpgTarget[]} */
  const sites = Object.freeze([
    {id:'workbench',kind:'workbench',x:304,y:592,label:'꾸미기'},
    {id:'berry',kind:'berry',x:240,y:264,label:'열매 살펴보기'},
    {id:'leaf',kind:'leaf',x:336,y:304,label:'잎 살펴보기'},
    {id:'bug',kind:'bug',x:144,y:208,label:'벌레 살펴보기'},
    ...[208,304,368].map((y,i)=>({id:`fishing-${i}`,kind:'fishing',x:624,y,label:'물결 살펴보기'})),
  ]);
  const entrance = Object.freeze({x:240,y:560});
  const required = Object.freeze([entrance,{x:304,y:624},{x:240,y:304},{x:336,y:336},{x:144,y:240},
    {x:592,y:208},{x:592,y:304},{x:592,y:368}]);
  const waypoints = Object.freeze([{x:240,y:592},{x:528,y:592},{x:528,y:272},{x:592,y:272},{x:528,y:112},{x:208,y:112}]);
  const obstacles = Object.freeze([
    ...water, house,
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
  /** 발 충돌체의 통행 가능 여부를 판정한다. @param {number} x @param {number} y @param {readonly RpgDecoration[]} [decorations] @returns {boolean} */
  function canStand(x,y,decorations = []) {
    return Number.isFinite(x) && Number.isFinite(y) && x>=7 && y>=10 && x<=width-7 && y<=height &&
      !blocks(decorations).some(r=>x+7>r.x && x-7<r.x+r.width && y>r.y && y-10<r.y+r.height);
  }
  /** 새 산책의 고정 fixture를 반환한다. @returns {{x:number,y:number,direction:number,outfit:number}} */
  function fixture() { return {x:240,y:592,direction:6,outfit:0}; }

  /** 배치와 지형의 동일 충돌 사각형을 돌려준다. @param {readonly RpgDecoration[]} decorations @returns {RpgRect[]} */
  function blocks(decorations) {return [...obstacles,...decorations.map(d=>({x:d.col*tile,y:d.row*tile,width:tile,height:tile}))];}
  /** 대상 자체를 제외한 차단물과 시선 선분의 교차를 검사한다. @param {RpgVector} from @param {RpgVector} to @param {readonly RpgRect[]} walls */
  function clearSight(from,to,walls) {
    return !walls.some(r=>{
      let lo=0,hi=1;
      for(const [a,b,min,max] of [[from.x,to.x,r.x,r.x+r.width],[from.y,to.y,r.y,r.y+r.height]]) {
        const delta=b-a;
        if(Math.abs(delta)<1e-9){if(a<=min||a>=max)return false;continue;}
        const first=(min-a)/delta,last=(max-a)/delta;
        lo=Math.max(lo,Math.min(first,last));hi=Math.min(hi,Math.max(first,last));
      }
      return lo<hi && hi>0 && lo<1;
    });
  }
  /** 발 위치 40px·전방 ±60도·시선으로 대상 하나를 안정적으로 선택한다. @param {RpgVector} from @param {number} direction @param {readonly RpgTarget[]} targets @param {readonly RpgDecoration[]} [decorations] @returns {RpgTarget|null} */
  function target(from,direction,targets,decorations=[]) {
    if(!Number.isFinite(from.x)||!Number.isFinite(from.y)||!Number.isInteger(direction)||direction<0||direction>7)return null;
    return targets.filter(t=>{
      const dx=t.x-from.x,dy=t.y-from.y,distance=Math.hypot(dx,dy);
      return distance<=40 && (distance===0||(dx*Math.cos(direction*Math.PI/4)+dy*Math.sin(direction*Math.PI/4))/distance>=0.5-1e-10) &&
        clearSight(from,t,blocks(decorations.filter(d=>d.id!==t.id)));
    }).sort((a,b)=>Math.hypot(a.x-from.x,a.y-from.y)-Math.hypot(b.x-from.x,b.y-from.y)||(a.id<b.id?-1:a.id>b.id?1:0))[0]??null;
  }
  /** 이동 가능한 격자와 NPC/필수 장소 연결 정보를 만든다. @param {readonly RpgDecoration[]} [decorations] */
  function navigation(decorations=[]) {
    const passable=Array.from({length:24},(_,row)=>Array.from({length:32},(_,col)=>canStand(col*32+16,row*32+16,decorations)));
    const visited=new Set();const queue=[{col:7,row:17}];
    if(passable[17][7])visited.add('7,17');else queue.length=0;
    for(let i=0;i<queue.length;i++) {
      const cell=queue[i];
      for(const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const col=cell.col+dc,row=cell.row+dr,key=`${col},${row}`;
        if(!passable[row]?.[col]||visited.has(key))continue;
        // 발 사각형이 줄기 사이의 좁은 틈을 건너뛰지 않도록 간선도 검사한다.
        if(![8,16,24].every(step=>canStand(cell.col*32+16+dc*step,cell.row*32+16+dr*step,decorations)))continue;
        visited.add(key);queue.push({col,row});
      }
    }
    return {passable,waypoints,reachable:required.every(p=>visited.has(`${Math.floor(p.x/32)},${Math.floor(p.y/32)}`)),visited};
  }
  /** 바라보는 바로 앞 한 타일을 반환한다. @param {RpgVector} player @param {number} direction */
  function preview(player,direction) {return {col:Math.floor(player.x/32)+Math.round(Math.cos(direction*Math.PI/4)),row:Math.floor(player.y/32)+Math.round(Math.sin(direction*Math.PI/4))};}
  /** 거절 이유를 포함해 점유·길·필수 장소 도달을 검증한다. @param {readonly RpgDecoration[]} decorations @param {{col:number,row:number}} cell @param {readonly RpgVector[]} actors @returns {string|null} */
  function placementReason(decorations,cell,actors) {
    const {col,row}=cell;
    if(!Number.isInteger(col)||!Number.isInteger(row)||col<1||col>30||row<1||row>22)return '지도 경계에는 놓을 수 없어요';
    if(decorations.length>=48)return '물건은 최대 48개까지 놓을 수 있어요';
    if(decorations.some(d=>d.col===col&&d.row===row))return '이미 물건이 있는 자리예요';
    const box={x:col*32,y:row*32,width:32,height:32};
    if(obstacles.some(r=>box.x<r.x+r.width&&box.x+32>r.x&&box.y<r.y+r.height&&box.y+32>r.y))return '물·집·나무·울타리에는 놓을 수 없어요';
    if(paths.some(r=>box.x<r.x+r.width&&box.x+32>r.x&&box.y<r.y+r.height&&box.y+32>r.y)||[...required,...sites].some(p=>Math.floor(p.x/32)===col&&Math.floor(p.y/32)===row))return '길·집 입구·발견 장소는 비워 두세요';
    if(actors.some(p=>p.x+7>box.x&&p.x-7<box.x+32&&p.y>box.y&&p.y-10<box.y+32))return '누군가 서 있는 자리예요';
    if(!navigation([...decorations,{id:'preview',kind:'pot',col,row}]).reachable)return '발견 장소로 가는 길이 막혀요';
    return null;
  }
  /** 꾸미기 물건을 근접 대상으로 변환한다. @param {readonly RpgDecoration[]} decorations @returns {RpgTarget[]} */
  function decorationTargets(decorations) {return decorations.map(d=>({id:d.id,kind:d.kind,x:d.col*32+16,y:d.row*32+16,label:d.kind==='chair'?'앉기':d.kind==='well'?'우물 살펴보기':'화분 살펴보기'}));}
  /** 저장 전 단계의 고정 무료 물건 배치다. @returns {RpgDecoration[]} */
  function decorationFixture(){return ['pot','well','chair'].map((kind,i)=>({id:`fixture-${i}`,kind,col:3+i,row:20}));}
  return Object.freeze({tile,cols:32,rows:24,width,height,pond,water,paths,house,trees,sites,required,entrance,waypoints,obstacles,velocity,canStand,fixture,blocks,clearSight,target,navigation,preview,placementReason,decorationTargets,decorationFixture});
})();
