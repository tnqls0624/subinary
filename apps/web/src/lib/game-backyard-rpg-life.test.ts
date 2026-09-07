import { describe, expect, it } from 'vitest';
import { loadRpg } from './game-backyard-rpg-test-utils';
const { codec, life, rules } = loadRpg();

/** null 결과를 성공으로 오인하지 않는다. */
function required<T>(value:T|null):T { if(value===null)throw Error('행동을 완료하지 못했어요');return value; }

describe('주민 3명·경험·대사',()=>{
  it('48개 고유 완성문과 공통 틀 8개, 12비트 재경험 +0',()=>{
    expect(new Set(life.residents.flatMap(r=>r.lines)).size).toBe(48);
    expect(life.residents.every(r=>r.lines.length===16&&r.waypoints.length>=4&&r.waypoints.length<=6)).toBe(true);
    expect(life.shared).toHaveLength(8);
    expect(life.friendship(life.experience(0,life.tags))).toBe(12);
    expect(life.experience(4095,life.tags)).toBe(4095);
  });
  it('각 주민이 모든 경험을 다시 만들고 표본은 소비하지 않는다',()=>{
    const collection={...codec.initial().rpg_collection,species:['s0:1:1','s4:1:1','s8:1:1']};
    const before=JSON.stringify(collection);
    for(const r of life.residents){
      let state=codec.initial().rpg_residents;
      for(const point of [{x:208,y:592},{x:208,y:112},{x:592,y:272}]){
        const d=['chair','well','pot'].map((kind,i)=>({id:String(i),kind,col:Math.floor(point.x/32)+i,row:Math.floor(point.y/32)+1}));
        for(const mode of ['talk','sample','sample','sample','sit'] as const)state=required(life.talk(state,r.id,point,d,collection,mode)).state;
      }
      expect(Number(state.items[0].split(':')[1])).toBe(4095);
      const later=required(life.talk(state,r.id,{x:208,y:592},[],collection));
      expect(later.friendship).toBe(12);
    }
    expect(JSON.stringify(collection)).toBe(before);
  });
  it('30회 대화와 모든 표본 슬롯에서 미치환·잘못된 조사 없음',()=>{
    const transcript:string[]=[];
    for(const r of life.residents){
      let state=codec.initial().rpg_residents;
      const collection={...codec.initial().rpg_collection,species:life.species.map(s=>`${s.id}:1:1`)};
      for(let i=0;i<30;i++){
        const result=required(life.talk(state,r.id,{x:208,y:592},[{id:'2',kind:'chair',col:6+i%2,row:20}],collection,i%3===0?'talk':'sample'));
        state=result.state;transcript.push(r.name+': '+result.text);
        expect(result.text).not.toMatch(/[{}]|undefined|null|열매을|나비을|물고기을|버섯를|솔방울를/);
        expect(result.text.length).toBeGreaterThan(8);
      }
    }
    process.stdout.write('대화 검수용 90회 기록:\n'+transcript.join('\n')+'\n');
  });
  it('의자 이동의 배치 서명이 달라지고 새로운 배치 반응을 우선한다',()=>{
    const point={x:208,y:592},first=[{id:'2',kind:'chair',col:6,row:20}];
    const a=required(life.talk(codec.initial().rpg_residents,'r0',point,first,codec.initial().rpg_collection));
    const b=required(life.talk(a.state,'r0',point,[{...first[0],col:7}],codec.initial().rpg_collection));
    expect(a.text).not.toBe(b.text);expect(a.state.items[0].split(':')[3]).not.toBe(b.state.items[0].split(':')[3]);
    expect(life.layout(point,first).signature).toBe(life.layout(point,[{...first[0],id:'31'}]).signature);
  });
  it('24px/s·3~8초 쉼·길막 10초 후 목적지만 변경하고 실제로 다시 걷는다',()=>{
    const actor={...life.walkers()[0],rest:0};
    const step=life.walk(actor,100,[],false);
    expect(Math.hypot(step.x-actor.x,step.y-actor.y)).toBeCloseTo(2.4);
    expect(life.walk(actor,100,[],true)).toEqual(actor);
    const wall=[{id:'block',kind:'chair',col:14,row:18}];
    let blocked={...actor,x:440,y:592};
    for(let i=0;i<99;i++)blocked=life.walk(blocked,100,wall,false);
    expect(blocked.goal).toBe(actor.goal);
    const recovered=life.walk(blocked,100,wall,false);
    expect(recovered.goal).not.toBe(actor.goal);
    expect([recovered.x,recovered.y]).toEqual([blocked.x,blocked.y]);
    let moved=recovered;for(let i=0;i<30;i++)moved=life.walk(moved,100,wall,false);
    expect(Math.hypot(moved.x-recovered.x,moved.y-recovered.y)).toBeGreaterThan(1);
    const arrived=life.walk({...actor,...life.residents[0].waypoints[1]},16,[],false);
    expect(arrived.rest).toBeGreaterThanOrEqual(3000);expect(arrived.rest).toBeLessThanOrEqual(8000);
  });
  it('고정 순회가 물·나무를 통과하지 않고 모든 장소를 연결한다',()=>{
    expect(rules.navigation().reachable).toBe(true);
    for(const definition of life.residents){
      for(const point of definition.waypoints)expect(rules.canStand(point.x,point.y)).toBe(true);
    }
    expect(life.residents.map(r=>r.shape)).toEqual(['bear','bird','rabbit']);
  });
});

describe('채집 8종·60초·99개',()=>{
  it('8종을 모두 발견하며 자연 12개·화분48개로 최대 60점이다',()=>{
    let state=codec.initial().rpg_collection;
    for(const node of life.nodes)state=required(life.gather(state,node.id,1000));
    expect(state.species).toHaveLength(8);expect(state.nodes).toHaveLength(12);
    const pots=Array.from({length:48},(_,i)=>({id:String(i),kind:'pot',col:i%32,row:20,stored:false}));
    for(const pot of pots)state=required(life.gather(state,'pot-'+pot.id,1000,pots));
    expect(state.nodes).toHaveLength(60);expect(codec.decode('rpg_collection',state).status).toBe('ok');
  });
  it('열매는 3시간·나머지 채집점은 60초로 다시 나타난다',()=>{
    // 설계서 §12: "익으면 멈춤 — 나무·화분에 유지, 벌레/낚시는 별도 장소 규칙".
    // 전부 3시간이면 판 생산 게임이 되고, 전부 60초면 실시간에 묶은 의미가 없어진다.
    const berry=life.nodes.find(n=>n.species<2);const pick=life.nodes.find(n=>n.species>=2);
    expect(berry && pick).toBeTruthy();
    expect(life.regrowSeconds(berry!.id)).toBe(10800);
    expect(life.regrowSeconds('pot-0')).toBe(10800);
    expect(life.regrowSeconds(pick!.id)).toBe(60);
  });
  it('경계·시계 역행·장기 방치·중복 클릭을 단일 시각으로 제한한다',()=>{
    // node-0은 열매라 재생성이 3시간(10800초)이다.
    const first=required(life.gather(codec.initial().rpg_collection,'node-0',1000));
    for(const time of [0,999,1000,1000+10799])expect(life.gather(first,'node-0',time)).toBeNull();
    const next=required(life.gather(first,'node-0',1000+10800));expect(next.species[0]).toBe('s0:2:1000:node-0');
    const later=required(life.gather(next,'node-0',1000+10800+30*86400));expect(later.species[0]).toBe('s0:3:1000:node-0');
    expect(first.species[0]).toBe('s0:1:1000:node-0');
    expect(life.gather(first,'missing',1000)).toBeNull();expect(life.gather(first,'node-0',NaN)).toBeNull();
    // 버섯·솔방울·벌레는 한 산책 안에서 다시 나타난다.
    const pick=life.nodes.find(n=>n.species>=2)!;
    const picked=required(life.gather(codec.initial().rpg_collection,pick.id,1000));
    expect(life.gather(picked,pick.id,1059)).toBeNull();
    expect(life.gather(picked,pick.id,1060)).not.toBeNull();
  });
  it('99개를 거절하고 보관·재배치로 화분 수확을 초기화하지 않는다',()=>{
    const pot=codec.owned(codec.initial().rpg_world)[0];
    const first=required(life.gather(codec.initial().rpg_collection,'pot-0',1000,[pot]));
    expect(life.gather(first,'pot-0',2000,[{...pot,stored:true}])).toBeNull();
    expect(life.gather(first,'pot-0',1001,[{...pot,col:10}])).toBeNull();
    const full={...first,species:['s0:99:1000']};const before=JSON.stringify(full);
    expect(life.gather(full,'pot-0',2000,[pot])).toBeNull();expect(JSON.stringify(full)).toBe(before);
  });
});

describe('입질을 기다려 주는 낚시',()=>{
  it('2~4초 대기, 입질 후 60초도 유지, 600ms 끌어올림',()=>{
    for(const random of [0,0.5,1]){
      const cast=life.cast(0,random);if(cast.phase!=='waiting')throw Error('던지기 실패');
      expect(cast.remaining).toBeGreaterThanOrEqual(2000);expect(cast.remaining).toBeLessThanOrEqual(4000);
      const bite=life.tickFishing(cast,cast.remaining,false);expect(bite.phase).toBe('bite');
      expect(life.tickFishing(bite,60000,false)).toEqual(bite);
      const pull=life.pull(bite);expect(pull).toMatchObject({phase:'pulling',remaining:600});
      expect(life.pull(pull)).toEqual(pull);
      expect(life.tickFishing(pull,600,false)).toMatchObject({phase:'pulling',remaining:0});
    }
  });
  it('각 낚시점 소속 종 수 이내에 모두 발견하고 총 8종을 얻는다',()=>{
    let state=codec.initial().rpg_collection;
    for(let spot=0;spot<3;spot++){
      const found:number[]=[];
      for(let i=0;i<life.fishGroups[spot].length;i++){
        const caught=required(life.catchFish(state,spot,1000,4821));found.push(caught.index);state=caught.state;
      }
      expect(new Set(found)).toEqual(new Set(life.fishGroups[spot]));
    }
    expect(state.species).toHaveLength(8);
  });
  it('숨김·패널 일시정지 때 진행 0, 취소·재시작 때 수량 변화 0',()=>{
    const state=codec.initial().rpg_collection,before=JSON.stringify(state);
    const cast=life.cast(0,1);expect(life.tickFishing(cast,60000,true)).toEqual(cast);
    const resumed=life.tickFishing(cast,1000,false);expect(resumed).toMatchObject({remaining:3000});
    const cancelled:RpgFishing={phase:'idle'};expect(life.pull(cancelled)).toEqual(cancelled);
    expect(life.cast(0,0)).toMatchObject({remaining:2000});expect(JSON.stringify(state)).toBe(before);
    expect(life.cast(-1,0)).toEqual(cancelled);expect(life.catchFish(state,99,1000,4821)).toBeNull();
  });
});
