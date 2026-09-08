// @ts-check
/**
 * 걷는 동안의 콘텐츠 상태 전이. **Three·DOM·저장을 소유하지 않는다.**
 *
 * 2D 엔진(`rpg-engine.js`)의 `update`/`act`가 Phaser 객체와 HTML 요소에 붙어 있었기
 * 때문에 그 안의 게임 진행을 3D로 그대로 옮기려면 한 번은 분리해야 한다. 여기서
 * 분리한 것은 **표현이 아니라 진행**이며, 규칙·대사·종·재생성 시각은 전부
 * `BackyardRpgRules`·`BackyardRpgLife`를 그대로 호출한다. 새로 정하는 값이 없다.
 *
 * 저장은 주입된 `commit(key,value)` 하나로만 나간다 — 획득 하나가 `rpg_collection`
 * PUT 하나다.
 */
var BackyardRpg3dWorld = (() => {
  const rules=BackyardRpgRules,life=BackyardRpgLife;
  /** @typedef {{now:()=>number,random:()=>number,commit:(key:RpgKey,value:RpgSave)=>boolean,locked:()=>boolean,suspended:()=>boolean}} RpgWorldDeps */

  /** @param {RpgWorldDeps} deps */
  function create(deps){
    /** @type {RpgData|null} */ let data=null;
    /** @type {RpgDecoration[]} */ let decorations=[];
    /** @type {RpgOwned[]} */ let owned=[];
    let activeNodes=life.dailyNodes(0),visit=life.today(0,0,0);
    let actors=life.walkers(0);
    /** @type {Record<string,number>} */ let travelled={};
    /** @type {RpgFishing} */ let fishing={phase:'idle'};
    /** @type {{node:string,remaining:number}|null} */ let gathering=null;
    let dialogueId='',dialogueText='',dialogueTitle='',sitting=false;
    let editing=false,chosen='pot';
    /** @type {string|null} */ let movingId=null;
    let feedback='가까이 다가가 바라봐 주세요';
    /** @type {{index:number,name:string}|null} */ let card=null;
    let completionPending=false,completionSeen=false;
    // 배치 거절 판정은 통행 BFS를 포함한다. 고스트 표시를 프레임마다 다시 계산하면
    // 편집 중 프레임이 흔들리므로 6프레임마다만 갱신한다 — **확정은 act가 그 순간
    // 다시 판정하므로 권위는 여기 있지 않다.**
    let ticks=0;
    /** @type {{key:string,reason:string|null}|null} */ let cachedReason=null;

    /** 저장 ACK 전에는 의미 있는 편집을 잠근다. 2D와 같은 경계다. */
    const writable=()=>!!data&&!deps.locked();
    /** 벽시계를 초 단위로 읽고 역행은 채집점 readyAt 검사에서 차단한다. */
    const clock=()=>Math.max(0,deps.now(),data?data.rpg_player.t:0,visit.day*86400);

    /** 실제 존재하는 근접 대상만 만든다. @returns {RpgTarget[]} */
    function targets(){
      if(!data)return [];
      const collection=data.rpg_collection,at=clock();
      return [...rules.sites.filter(t=>t.kind==='workbench'||t.kind==='fishing').map(t=>({...t,label:t.kind==='fishing'?'낚시하기':t.label})),
        ...activeNodes.filter(n=>at>=life.readyAt(collection,n.id)),
        ...actors.map(a=>({id:a.id,kind:'resident',x:a.x,y:a.y,label:'말 걸기 · '+life.residents.find(r=>r.id===a.id)?.name})),
        ...rules.decorationTargets(decorations).map(t=>t.kind==='pot'?{...t,label:at>=life.readyAt(collection,'pot-'+t.id)?'따기 · 노란 열매':'열매가 자라는 중'}:t)];
    }
    /** 발 위치의 논리 평면에서만 대상을 고른다. Raycaster는 획득 권위가 없다(설계서 §7).
     * @param {RpgVector} point @param {number} direction */
    function target(point,direction){return rules.target(point,direction,targets(),decorations);}

    /** world 한 키만 저장한다. @param {RpgOwned[]} next */
    function saveWorld(next){
      if(!data||!writable())return false;
      return deps.commit('rpg_world',BackyardRpgCodec.world(next,data.rpg_world.legacyFruit));
    }
    /** 획득 카드는 ACK 표시를 React가 붙인다. @param {number} index */
    function showCard(index){card={index,name:life.species[index].name};}

    /**
     * 세션 상태가 바뀔 때 배치·방문일·주민을 맞춘다. 새 세대(fresh)에서만 순회를 다시 부팅한다.
     * @param {RpgData} next @param {boolean} fresh
     */
    function sync(next,fresh){
      data=next;
      owned=BackyardRpgCodec.owned(next.rpg_world);
      decorations=owned.filter(item=>!item.stored);
      if(fresh){
        visit=life.today(Math.floor(Date.now()/1000),Math.max(next.rpg_player.t,...next.rpg_collection.species.map(t=>Number(t.split(':')[2]))),next.rpg_meta.seed);
        activeNodes=life.dailyNodes(visit.variant);
        actors=life.walkers(visit.waypoint);travelled={};
        editing=false;movingId=null;dialogueId='';dialogueText='';sitting=false;
        feedback=next.rpg_world.legacyFruit?'예전 마당에서 모은 열매 '+next.rpg_world.legacyFruit+'개':'같은 마당을 공유해요. 동시에 바꾸면 마지막 저장이 남아요';
      }
      // 완료 표시는 16번째 획득의 ACK 뒤 별도 영속 표시를 받아 한 번만 연다.
      if(life.complete(next.rpg_collection)&&!next.rpg_collection.completed&&!deps.locked()){
        completionPending=true;
        if(!deps.commit('rpg_collection',{...next.rpg_collection,completed:true}))completionPending=false;
      }
      if(next.rpg_collection.completed&&completionPending&&!deps.locked()){completionPending=false;completionSeen=true;card=null;return {completion:true};}
      return {completion:false};
    }

    /** 주민 앞에서만 소비 없는 관계 행동을 확정한다. 표본은 사라지지 않는다.
     * @param {'talk'|'sample'|'sit'} mode @param {RpgVector} point */
    function converse(mode,point){
      if(!data||deps.suspended()||!writable())return false;
      const actor=actors.find(a=>a.id===dialogueId);
      if(!actor||Math.hypot(actor.x-point.x,actor.y-point.y)>40)return false;
      if(mode==='sample'&&!data.rpg_collection.species.length){dialogueText='표본을 하나 만난 뒤 함께 살펴봐요';return true;}
      if(mode==='sit'&&!life.layout(actor,decorations).nearby.some(d=>d.kind==='chair')){dialogueText='가까이에 의자를 놓으면 함께 앉을 수 있어요';return true;}
      const result=life.talk(data.rpg_residents,actor.id,actor,decorations,data.rpg_collection,mode);
      if(!result||!deps.commit('rpg_residents',result.state))return false;
      sitting=mode==='sit';dialogueText=result.text;
      dialogueTitle=life.residents.find(r=>r.id===actor.id)?.name+' · 함께한 경험 '+result.friendship+'/12';
      return true;
    }

    /** 행동 순간에 대상과 배치를 다시 판정한다. 먼 곳에서의 획득은 없다.
     * @param {RpgVector} point @param {number} direction */
    function act(point,direction){
      if(!data||deps.suspended()||dialogueId||gathering)return;
      if(fishing.phase!=='idle'){fishing=life.pull(fishing);return;}
      if(editing){
        if(!writable()){feedback='저장 완료를 기다려 주세요';return;}
        const cell=rules.preview(point,direction);
        const reason=rules.placementReason(decorations.filter(d=>d.id!==movingId),cell,[point,...actors]);
        if(reason){feedback=reason;return;}
        const reused=owned.find(i=>i.id===movingId)??owned.find(i=>i.stored&&i.kind===chosen);
        if(!reused&&owned.length>=48){feedback='보관 포함 48개예요 · 보관한 물건을 다시 놓아 주세요';return;}
        const id=reused?.id??String(Array.from({length:48},(_,i)=>i).find(i=>!owned.some(o=>o.id===String(i))));
        if(saveWorld([...owned.filter(i=>i.id!==id),{id,kind:reused?.kind??chosen,...cell,stored:false}])){movingId=null;feedback='앞에 놓았어요';}
        return;
      }
      const current=target(point,direction);
      if(!current){feedback='조금 더 다가가 바라봐 주세요';return;}
      if(!writable()){feedback='저장 후 계속할 수 있어요 · 다시';return;}
      if(current.kind==='resident'){dialogueId=current.id;converse('talk',point);return;}
      if(current.kind==='gather'||current.kind==='pot'){
        const node=current.kind==='pot'?'pot-'+current.id:current.id;
        if(!life.gather(data.rpg_collection,node,clock(),owned)){
          feedback=clock()<life.readyAt(data.rpg_collection,node)?'조금 더 자라면 만나요':'충분히 모았어요 · 수량은 그대로예요';return;
        }
        gathering={node,remaining:current.kind==='gather'&&(life.nodes.find(n=>n.id===node)?.species??0)>=4?400:350};
        feedback='조심스럽게 손을 뻗어요';return;
      }
      if(current.kind==='fishing'){
        fishing=life.cast(Number(current.id.slice(-1)),deps.random());
        feedback='찌를 바라보며 천천히 기다려요';return;
      }
      if(current.kind==='workbench'){editing=true;cachedReason=null;feedback='걸어서 앞 칸을 고른 뒤 놓아 주세요';return;}
      feedback=current.kind==='chair'?'의자에 잠시 앉아 쉬어요':current.kind==='well'?'우물에 동그란 물결이 번져요':current.kind==='bug'?'잎 사이에서 작은 날개가 움직여요':'잎과 열매가 살랑여요';
    }

    /**
     * 한 프레임의 진행. 낚시·채집 시계와 주민 순회를 같은 delta로 움직인다.
     * @param {number} delta 밀리초 @param {RpgVector} point @param {number} direction
     */
    function frame(delta,point,direction){
      if(!data||deps.suspended())return snapshot(point,direction);
      ticks++;
      const elapsed=delta>100?0:Math.max(0,delta);
      fishing=life.tickFishing(fishing,elapsed,!!dialogueId);
      if(fishing.phase==='pulling'&&fishing.remaining===0){
        const spot=fishing.spot;fishing={phase:'idle'};
        const result=life.catchFish(data.rpg_collection,spot,clock(),data.rpg_meta.seed);
        if(result&&writable()&&deps.commit('rpg_collection',result.state))showCard(result.index);
        else feedback='충분히 모았거나 저장을 기다리고 있어요 · 수량은 그대로예요';
      }
      if(gathering){
        gathering={...gathering,remaining:Math.max(0,gathering.remaining-elapsed)};
        if(gathering.remaining===0){
          const node=gathering.node;gathering=null;
          const result=life.gather(data.rpg_collection,node,clock(),owned);
          if(result&&writable()&&deps.commit('rpg_collection',result)){
            showCard(life.nodes.find(n=>n.id===node)?.species??0);
            const variant=life.today(clock(),data.rpg_player.t,data.rpg_meta.seed).variant;
            const next=life.dailyNodes(variant).find(n=>n.id===node);
            if(next)activeNodes=activeNodes.map(n=>n.id===node?next:n);
          }else feedback='충분히 모았거나 저장을 기다리고 있어요 · 수량은 그대로예요';
        }
      }
      actors=actors.map(actor=>{
        const focused=!!rules.target(point,direction,[{id:actor.id,kind:'resident',x:actor.x,y:actor.y,label:''}],decorations);
        const next=life.walk(actor,elapsed,decorations,focused||!!dialogueId);
        // NPC 위상은 저장하지 않는다. 실제 이동거리만 누적해 제자리 걸음을 막는다.
        travelled[next.id]=(travelled[next.id]??0)+Math.hypot(next.x-actor.x,next.y-actor.y);
        if(focused)next.direction=(Math.round(Math.atan2(point.y-next.y,point.x-next.x)/(Math.PI/4))+8)%8;
        return next;
      });
      return snapshot(point,direction);
    }

    /** 렌더와 HUD가 필요한 것만 노출한다. @param {RpgVector} point @param {number} direction */
    function snapshot(point,direction){
      const at=clock();
      const collection=data?.rpg_collection;
      const current=data&&!editing?target(point,direction):null;
      const cell=editing?rules.preview(point,direction):null;
      const key=cell?[cell.col,cell.row,movingId,decorations.length,Math.round(point.x),Math.round(point.y),
        ...actors.map(a=>Math.round(a.x)+','+Math.round(a.y))].join('|'):'';
      if(cell&&data&&(!cachedReason||cachedReason.key!==key)&&(ticks%6===0||!cachedReason))
        cachedReason={key,reason:rules.placementReason(decorations.filter(d=>d.id!==movingId),cell,[point,...actors])};
      const reason=cell&&data?cachedReason?.reason??null:null;
      const place=point.x>570&&point.y<448?'연못가':point.x>=496&&point.x<=560?'오솔길':point.y<420?'나무 그늘':'집 앞 마당';
      const label=fishing.phase==='bite'?'끌어올리기':fishing.phase==='pulling'?'끌어올리는 중':fishing.phase==='waiting'?'입질을 기다려요':
        gathering?'조심스럽게 채집 중':editing?'여기 놓기':current?.label||'다가가 보기';
      return {
        actors:actors.map(a=>({id:a.id,x:a.x,y:a.y,direction:a.direction,distance:travelled[a.id]??0,
          shape:life.residents.find(r=>r.id===a.id)?.shape??'bear',sitting:sitting&&dialogueId===a.id})),
        nodes:activeNodes.map(n=>({id:n.id,x:n.x,y:n.y,species:n.species,visible:!!collection&&at>=life.readyAt(collection,n.id)})),
        decorations:decorations.map(d=>({...d,ready:d.kind==='pot'&&!!collection&&at>=life.readyAt(collection,'pot-'+d.id)})),
        fishing,gathering,editing,chosen,movingId,
        ghost:cell?{...cell,kind:movingId?owned.find(i=>i.id===movingId)?.kind??chosen:chosen,reason}:null,
        target:current,dialogue:dialogueId?{id:dialogueId,title:dialogueTitle,text:dialogueText}:null,
        card,completion:completionSeen,
        hud:{action:label,place,feedback,disabled:!editing&&!current,
          placement:editing?`${owned.length}/48 (보관 포함) · ${reason||'앞 칸에 놓을 수 있어요'}`:''},
      };
    }

    return {
      sync,frame,act,converse,target,snapshot,
      /** 대화를 닫는다. 관계 저장은 이미 끝났고 여기서 다시 쓰지 않는다. */
      closeDialogue(){dialogueId='';dialogueText='';sitting=false;},
      /** 취소는 표본을 잃지 않는다. 시간 제한도 만들지 않는다. */
      cancelFishing(){fishing={phase:'idle'};gathering=null;feedback='산책을 계속해요';},
      closeCard(){card=null;},
      closeCompletion(){completionSeen=false;},
      openEditor(){editing=true;cachedReason=null;},
      closeEditor(){editing=false;movingId=null;cachedReason=null;feedback='산책을 계속해요';},
      /** @param {string} kind */
      choose(kind){movingId=null;chosen=kind;cachedReason=null;},
      /** @param {RpgVector} point @param {number} direction */
      store(point,direction){
        if(!data||!writable())return;
        const current=rules.target(point,direction,rules.decorationTargets(decorations),decorations);
        if(!current){feedback='보관할 물건 가까이 다가가 바라봐 주세요';return;}
        if(saveWorld(owned.map(i=>i.id===current.id?{...i,stored:true}:i)))feedback='보관했어요 · 같은 종류를 고르면 다시 놓아요';
      },
      /** @param {RpgVector} point @param {number} direction */
      move(point,direction){
        if(!data||!writable())return;
        const current=rules.target(point,direction,rules.decorationTargets(decorations),decorations);
        if(!current){feedback='옮길 물건 가까이 다가가 바라봐 주세요';return;}
        movingId=current.id;chosen=current.kind;editing=true;cachedReason=null;feedback='걸어서 새 자리를 골라 주세요';
      },
      /** 대화·낚시·채집 중에는 이동 입력이 0이어야 한다. */
      busy(){return !!dialogueId||fishing.phase!=='idle'||!!gathering;},
      visit(){return visit;},
    };
  }
  return Object.freeze({create});
})();
