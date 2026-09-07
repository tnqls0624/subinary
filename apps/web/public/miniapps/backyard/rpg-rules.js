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
    return {passable,waypoints,reachable:[...required,...BackyardRpgLife.nodes].every(p=>visited.has(`${Math.floor(p.x/32)},${Math.floor(p.y/32)}`)),visited};
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
    if(paths.some(r=>box.x<r.x+r.width&&box.x+32>r.x&&box.y<r.y+r.height&&box.y+32>r.y)||[...required,...sites,...BackyardRpgLife.nodes].some(p=>Math.floor(p.x/32)===col&&Math.floor(p.y/32)===row))return '길·집 입구·발견 장소는 비워 두세요';
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

/** @typedef {{id:string,code:string,name:string,index:number}} RpgSpecies */
/** @typedef {RpgTarget & {species:number}} RpgNode */
/** @typedef {{id:string,name:string,shape:string,waypoints:RpgVector[],lines:string[]}} RpgResidentDefinition */
/** @typedef {{id:string,x:number,y:number,goal:number,rest:number,blocked:number,direction:number,phase:number,hop?:RpgVector|null}} RpgWalker */
/** @typedef {{phase:'waiting'|'bite'|'pulling',spot:number,remaining:number}|{phase:'idle'}} RpgFishing */
/** 주민·채집·낚시의 순수 상태 전이. 시각은 초, 진행 delta는 밀리초다. */
var BackyardRpgLife = (() => {
  const rules=BackyardRpgRules;
  const names=['노란 열매','빨간 열매','둥근 버섯','솔방울','흰나비','노랑나비','무당벌레','잠자리','붕어','잉어','송사리','피라미','미꾸라지','메기','은빛 물고기','점박이 물고기'];
  /** @type {RpgSpecies[]} */ const species=names.map((name,index)=>({id:'s'+index,code:(index<8?'g':'f')+String(index%8+1).padStart(2,'0'),name,index}));
  /** @type {RpgNode[]} */ const nodes=[
    [240,272,0],[112,304,0],[368,208,1],[176,176,1],
    [272,272,2],[336,368,2],[336,144,3],[432,112,3],
    [144,208,4],[464,192,5],[336,304,6],[592,400,7],
  ].map(([x,y,index],i)=>({id:'node-'+i,x,y,species:index,kind:'gather',label:(index<2?'따기':index<4?'줍기':'잡기')+' · '+names[index]}));
  const fishGroups=[[13,14,15],[8,9],[10,11,12]];
  /** @type {RpgResidentDefinition[]} */ const residents=[
    {id:'r0',name:'모루',shape:'bear',waypoints:[{x:208,y:592},{x:464,y:592},{x:528,y:272},{x:592,y:272},{x:528,y:112},{x:208,y:112}],lines:[
      '오늘도 천천히 한 바퀴 돌까?','반가워. 잠깐 쉬었다 가도 좋아.','발밑에 작은 그림자가 따라오네.','서두르지 않아도 마당은 여기 있어.',
      '집 앞은 햇볕이 포근해서 좋아.','나무 그늘에 들어오니 바람이 시원하네.','동쪽 물가에 잔물결이 보이더라.','이 길은 천천히 걸을수록 길게 느껴져.',
      '여기 의자가 있으니 쉬어 가기 좋겠네.','우물 옆에 서면 물소리가 가까워져.','화분의 작은 잎도 제법 넓은 그늘을 만드네.','자리가 바뀌니 익숙한 풍경도 새로워 보여.',
      '작은 표본 하나에도 볼 게 참 많구나.','물고기 무늬를 이렇게 가까이 보는 건 좋네.',
      '너와 걷다 보니 내가 좋아하는 자리도 늘었어.','말이 없어도 함께 쉬는 시간은 좋구나.']},
    {id:'r1',name:'두리',shape:'bird',waypoints:[{x:464,y:112},{x:208,y:112},{x:528,y:272},{x:592,y:272},{x:528,y:592},{x:336,y:592}],lines:[
      '안녕! 작은 날개를 찾아보자.','발소리가 들려서 고개를 들었어.','어느 쪽으로 걸어볼까?','반가워! 내 옆에 재미있는 게 있어.',
      '집 앞 화분에도 열매가 달려 있어.','저 잎 아래에 작은 날개가 숨어 있어.','연못 가까이에서는 잠자리를 찾아봐.','북쪽 길옆에 솔방울이 굴러와 있어.',
      '의자 아래 그림자가 새 모양 같아!','우물에 비친 하늘도 살펴보고 싶어.','화분 잎 뒤를 보니 작은 길이 보여.','자리가 달라졌네! 다른 쪽에서도 봐야지.',
      '새 표본이네. 도감에 같이 남기자.','작은 지느러미에도 무늬가 있구나!',
      '네가 찾아낸 걸 보면 나도 궁금한 게 늘어.','우리 나란히 앉아서 날개 모양을 비교해 보자.']},
    {id:'r2',name:'소담',shape:'rabbit',waypoints:[{x:592,y:272},{x:592,y:176},{x:528,y:112},{x:208,y:112},{x:528,y:592},{x:592,y:368}],lines:[
      '왔구나. 옆에 있어도 좋아.','바람 소리가 조용하네.','잠깐 같이 걸을까.','여기서 편하게 쉬어.',
      '집 앞 길은 발소리가 부드러워.','그늘에서는 잎 소리가 잘 들려.','찌가 움직일 때까지 같이 기다리자.','길 끝에 물빛이 보이네.',
      '의자가 여기 있으니 함께 앉기 좋겠다.','우물 물결은 작고 둥글어.','화분이 햇빛을 받고 있네.','자리를 옮기니 보이는 하늘도 달라져.',
      '작은 날개를 가까이서 봤구나.','기다려 준 물고기를 도감에 남기자.',
      '네 옆에서는 기다리는 시간도 편안해.','아무 말 없이 같이 앉아 있어도 좋아.']},
  ];
  const shared=[
    '{place} 잠깐 멈춰서 바람을 느껴 보자.','{place} 서 있으니 작은 소리가 들려.',
    '{object} 천천히 둘러봐도 좋아.','{object} 쉬어 갈 자리가 생겼네.',
    '{sample} 같이 살펴보니 무늬가 더 잘 보여.','{sample} 도감에 남겨 두면 다시 볼 수 있어.',
    '{place} 함께 앉아 있으니 편안하네.','{object} 풍경을 다른 쪽에서도 보고 싶어.',
  ];
  const tags=['greeting','home','shade','pond','chair','well','pot','gather','bug','fish','sample','sit'];
  /** 경험한 비트 수만 친밀도로 계산한다. @param {number} mask */
  function friendship(mask){let count=0;for(let i=0;i<12;i++)if(mask&(1<<i))count++;return count;}
  /** 재경험은 동일한 마스크다. @param {number} mask @param {string[]} experiences */
  function experience(mask,experiences){return experiences.reduce((value,tag)=>{const i=tags.indexOf(tag);return i<0?value:value|(1<<i);},mask)&4095;}
  /** 반경 3타일의 종류·위치·물가 인접 서명이다. @param {RpgVector} point @param {readonly RpgDecoration[]} decorations */
  function layout(point,decorations){
    const nearby=decorations.filter(d=>Math.hypot(d.col*32+16-point.x,d.row*32+16-point.y)<=96);
    const signature=nearby.map(d=>`${d.kind}:${d.col}:${d.row}`).sort().join('|')+'|'+String(point.x>=544&&point.y<448);
    let hash=2166136261;for(let i=0;i<signature.length;i++)hash=Math.imul(hash^signature.charCodeAt(i),16777619)>>>0;
    return {nearby,signature:hash};
  }
  /** 상황에 맞는 완성문과 마스크만 반환한다. 표본은 소비하지 않는다.
   * @param {RpgResidents} state @param {string} id @param {RpgVector} point @param {readonly RpgDecoration[]} decorations
   * @param {RpgCollection} collection @param {'talk'|'sample'|'sit'} [mode] */
  function talk(state,id,point,decorations,collection,mode='talk'){
    const resident=residents.find(r=>r.id===id);if(!resident)return null;
    const old=state.items.find(t=>t.split(':')[0]===id)?.split(':')??[id,'0','-1','0','b'];
    const scene=layout(point,decorations),last=Number(old[2]);
    const location=point.x>=544&&point.y<448?'pond':point.y<420?'shade':'home';
    const found=collection.species.filter(t=>Number(t.split(':')[1])>0).map(t=>Number(t.split(':')[0].slice(1)));
    // 표본 종류를 차례로 보여 주므로 언제든 채집·벌레·낚시 경험을 다시 만들 수 있다.
    const previous=Number(old[4].slice(1));
    const sample=mode==='sample'?found[(found.indexOf(previous)+1)%Math.max(1,found.length)]:undefined;
    const observed=['greeting',location,...scene.nearby.map(d=>d.kind)];
    if(sample!==undefined)observed.push('sample',sample<4?'gather':sample<8?'bug':'fish');
    if(mode==='sit'&&scene.nearby.some(d=>d.kind==='chair'))observed.push('sit');
    const mask=experience(Number(old[1]),observed);
    let pool=[0,1,2,3,location==='home'?4:location==='shade'?5:6,7,16,17];
    if(friendship(mask)>=8)pool.push(14,15);
    const changed=scene.signature!==Number(old[3]);
    if(changed&&scene.nearby.length)pool=[...scene.nearby.map(d=>d.kind==='chair'?8:d.kind==='well'?9:10),11,18,19,23];
    if(sample!==undefined)pool=[sample>=8?13:12,20,21];
    if(mode==='sit'&&observed.includes('sit'))pool=[15,22];
    const line=pool[(pool.indexOf(last)+1)%pool.length];
    const object=scene.nearby[0]?.kind==='chair'?'의자 옆에서':scene.nearby[0]?.kind==='well'?'우물 옆에서':scene.nearby[0]?.kind==='pot'?'화분 옆에서':'이 자리에서';
    const phrase=sample===undefined?'이 표본을':species[sample].name+(sample===2||sample===3?'을':'를');
    const text=(line<16?resident.lines[line]:shared[line-16]).replace('{place}',location==='home'?'집 앞에서':location==='shade'?'나무 그늘에서':'물가에서').replace('{object}',object).replace('{sample}',phrase);
    return {text,line,friendship:friendship(mask),state:{v:/** @type {2} */(2),items:[...state.items.filter(t=>t.split(':')[0]!==id),[id,mask,line,scene.signature,sample===undefined?old[4]:'s'+sample].join(':')]}};
  }
  /** 해당 채집점의 다음 획득 시각. @param {RpgCollection} state @param {string} node */
  function readyAt(state,node){return Number(state.nodes.find(t=>t.split(':')[0]===node)?.split(':')[1]??0);}
  const FRUIT_REGROW=10800,NODE_REGROW=60;
  /**
   * 재생성 간격. **나무·화분(열매)만 3시간이고 나머지는 60초다.**
   *
   * 설계서 §12가 "익으면 멈춤 — 나무·화분에 유지, 벌레/낚시는 별도 장소 규칙"으로
   * 이 구분을 유지했다. 근거는 같은 줄에 있다 — 전부 3시간 생산기로 만들면 다시 판
   * 생산 게임이 되고, 전부 60초로 만들면 실시간에 묶은 의미가 사라진다.
   * 열매는 다시 열 이유를 만들고, 버섯·솔방울·벌레는 한 산책 안에서 다시 나타난다.
   *
   * @param {string} node @returns {number} 초
   */
  function regrowSeconds(node){
    if(node.startsWith('pot-'))return FRUIT_REGROW;
    const definition=nodes.find(n=>n.id===node);
    return definition && definition.species<2 ? FRUIT_REGROW : NODE_REGROW;
  }
  /** 알려진 종을 한 개 기록한다. 99개에서는 원본을 유지한다. @param {RpgCollection} state @param {number} index @param {number} now */
  function collect(state,index,now){
    if(!species[index]||!Number.isSafeInteger(now)||now<0)return null;
    const id=species[index].id,old=state.species.find(t=>t.split(':')[0]===id)?.split(':');
    if(Number(old?.[1]??0)>=99)return null;
    return {...state,species:[...state.species.filter(t=>t.split(':')[0]!==id),`${id}:${Number(old?.[1]??0)+1}:${old?.[2]??now}`]};
  }
  /** 한 행동으로 도감·가방·채집점 시각을 확정한다. @param {RpgCollection} state @param {string} node @param {number} now @param {readonly RpgOwned[]} [owned] */
  function gather(state,node,now,owned=[]){
    const definition=nodes.find(n=>n.id===node),pot=node.startsWith('pot-')&&owned.some(i=>i.id===node.slice(4)&&i.kind==='pot'&&!i.stored);
    if(!definition&&!pot)return null;
    if(now<readyAt(state,node)||now>Number.MAX_SAFE_INTEGER-60)return null;
    const next=collect(state,definition?.species??0,now);if(!next)return null;
    return {...next,nodes:[...state.nodes.filter(t=>t.split(':')[0]!==node),node+':'+(now+regrowSeconds(node))]};
  }
  /** 미발견 우선 후보와 순환 인덱스를 같은 collection에 반영한다. @param {RpgCollection} state @param {number} spot @param {number} now @param {number} seed */
  function catchFish(state,spot,now,seed){
    const group=fishGroups[spot];if(!group)return null;
    const index=group.find(i=>!state.species.some(t=>t.split(':')[0]===species[i].id))??group[(state.fishing[spot]+seed)%group.length];
    const next=collect(state,index,now);if(!next)return null;
    return {index,state:{...next,fishing:state.fishing.map((value,i)=>i===spot?(value+1)%group.length:value)}};
  }
  /** 2~4초 대기를 시작한다. @param {number} spot @param {number} random @returns {RpgFishing} */
  function cast(spot,random){return fishGroups[spot]?{phase:'waiting',spot,remaining:2000+Math.max(0,Math.min(1,Number.isFinite(random)?random:0))*2000}:{phase:'idle'};}
  /** 일시정지 때 시계를 소비하지 않으며 입질은 영구 유지한다. @param {RpgFishing} state @param {number} delta @param {boolean} paused @returns {RpgFishing} */
  function tickFishing(state,delta,paused){
    if(paused||!Number.isFinite(delta)||delta<0||state.phase==='idle'||state.phase==='bite')return state;
    const remaining=Math.max(0,state.remaining-delta);
    return {...state,remaining,phase:state.phase==='waiting'&&remaining===0?'bite':state.phase};
  }
  /** 입질 한 번만 끌어올림으로 전환한다. @param {RpgFishing} state @returns {RpgFishing} */
  function pull(state){return state.phase==='bite'?{phase:'pulling',spot:state.spot,remaining:600}:state;}
  /** NPC는 저장하지 않는 순회 상태로 부팅한다. */
  function walkers(){return residents.map(r=>({id:r.id,...r.waypoints[0],goal:1,rest:3000,blocked:0,direction:0,phase:0}));}
  /** 통행 가능한 격자 경로의 다음 칸을 구한다. @param {RpgVector} start @param {RpgVector} end @param {readonly RpgDecoration[]} decorations */
  function nextStep(start,end,decorations){
    const key=(/** @type {RpgVector} */p)=>Math.floor(p.x/32)+','+Math.floor(p.y/32);
    const origin={x:Math.floor(start.x/32)*32+16,y:Math.floor(start.y/32)*32+16};
    if(!rules.canStand(end.x,end.y,decorations))return null;
    if(Math.hypot(start.x-origin.x,start.y-origin.y)>0.5&&rules.clearSight(start,origin,rules.blocks(decorations)))return origin;
    const queue=[origin],seen=new Set([key(origin)]);
    /** @type {Map<string,RpgVector>} */const first=new Map();
    for(let i=0;i<queue.length;i++){
      const p=queue[i];if(key(p)===key(end))return first.get(key(p))??end;
      for(const [dx,dy]of [[32,0],[-32,0],[0,32],[0,-32]]){
        const n={x:p.x+dx,y:p.y+dy};if(seen.has(key(n))||![0.25,0.5,0.75,1].every(t=>rules.canStand(p.x+dx*t,p.y+dy*t,decorations)))continue;
        seen.add(key(n));first.set(key(n),first.get(key(p))??n);queue.push(n);
      }
    }return null;
  }
  /** 24px/s로 순회하며 10초 길막은 목적지만 바꾼다. @param {RpgWalker} actor @param {number} delta @param {readonly RpgDecoration[]} decorations @param {boolean} stopped @returns {RpgWalker} */
  function walk(actor,delta,decorations,stopped){
    if(stopped||!Number.isFinite(delta)||delta<=0)return actor;
    const r=residents.find(r=>r.id===actor.id);if(!r)return actor;
    if(actor.rest>0)return {...actor,rest:Math.max(0,actor.rest-delta),phase:0};
    const destination=r.waypoints[actor.goal];
    if(Math.hypot(actor.x-destination.x,actor.y-destination.y)<1)return {...actor,goal:(actor.goal+1)%r.waypoints.length,rest:3000+(actor.goal*1237)%5001,blocked:0,phase:0};
    // 원점 중심으로 되돌아가지 않도록 정면 통행이 가능하면 현재 위치에서 목적지로 걷는다.
    const distanceToGoal=Math.hypot(actor.x-destination.x,actor.y-destination.y),steps=Math.max(1,Math.ceil(distanceToGoal/8));
    const direct=rules.clearSight(actor,destination,rules.blocks(decorations))&&Array.from({length:steps},(_,i)=>(i+1)/steps).every(t=>rules.canStand(actor.x+(destination.x-actor.x)*t,actor.y+(destination.y-actor.y)*t,decorations));
    const hop=actor.hop&&Math.hypot(actor.x-actor.hop.x,actor.y-actor.hop.y)>0.5?actor.hop:null;
    const next=hop??(direct?destination:nextStep(actor,destination,decorations));
    if(next){
      const dx=next.x-actor.x,dy=next.y-actor.y,length=Math.hypot(dx,dy),distance=Math.min(length,24*Math.min(delta,100)/1000);
      const x=actor.x+dx/(length||1)*distance,y=actor.y+dy/(length||1)*distance;
      if(length>0&&rules.canStand(x,y,decorations))return {...actor,x,y,hop:next,blocked:0,direction:(Math.round(Math.atan2(dy,dx)/(Math.PI/4))+8)%8,phase:actor.phase+delta};
    }
    if(actor.blocked+delta<10000)return {...actor,blocked:actor.blocked+delta,phase:0};
    const nextGoal=r.waypoints.map((p,i)=>({p,i})).find(({p,i})=>i!==actor.goal&&rules.canStand(p.x,p.y,decorations)&&nextStep(actor,p,decorations));
    return {...actor,goal:nextGoal?.i??(actor.goal+1)%r.waypoints.length,blocked:0,phase:0,hop:null};
  }
  return Object.freeze({species,nodes,fishGroups,residents,shared,tags,friendship,experience,layout,talk,readyAt,regrowSeconds,collect,gather,catchFish,cast,tickFishing,pull,walkers,walk,nextStep});
})();
