// @ts-check
/** @typedef {{localSequence:number,ackedSequence:number,inFlight:boolean,error:unknown,permanent:boolean}} RpgWriteState */
/** @typedef {{commit:(key:RpgKey,value:RpgSave)=>boolean,observePlayer:(value:RpgPlayer,moving:boolean)=>void,flush:()=>void,getSaveState:()=>{dirty:boolean,locked:boolean,message:string,keys:Record<RpgKey,RpgWriteState>}}} RpgWriter */
/** @typedef {{status:'playable',data:RpgData,writer:RpgWriter}|{status:'waiting_host'|'loading'|'initializing'}|{status:'load_error'|'initialization_error'|'invalid_state'|'unsupported_version',message:string}} RpgSessionState */
/** @typedef {{bridge:{ready:()=>Promise<void>,state:{get:(key:string)=>Promise<unknown>,set:(key:string,value:RpgSave)=>Promise<void>}},setTimer:(fn:()=>void,ms:number)=>number,clearTimer:(id:number)=>void,onChange?:(state:RpgSessionState)=>void}} RpgSessionDeps */
/** 읽기 실패와 신규를 분리하고 데이터 ACK 뒤 meta로 초기화를 완료한다. */
var BackyardRpgSession = (() => {
  /** 저장·시계 경계를 주입한다. @param {RpgSessionDeps} deps */
  function createSession(deps) {
    const codec=BackyardRpgCodec;
    /** @type {RpgSessionState} */ let state={status:'waiting_host'};
    let generation=0,destroyed=false;
    /** @type {Set<()=>void>} */ const cancels=new Set();
    /** @type {(()=>void)|undefined} */ let dispose;
    /** 상태를 알린다. @param {RpgSessionState} next */
    function publish(next) {if(!destroyed){state=next;deps.onChange?.(next);}}
    /** 8초 이후 응답은 버리며 취소 시 타이머도 정리한다. @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
    function request(operation) {
      return new Promise((resolve,reject)=>{
        let settled=false;
        /** 완료 경로 하나만 허용한다. @param {()=>void} fn */
        const finish=fn=>{if(settled)return;settled=true;deps.clearTimer(timer);cancels.delete(cancel);fn();};
        const cancel=()=>finish(()=>reject({code:'cancelled'}));
        const timer=deps.setTimer(()=>finish(()=>reject({code:'timeout'})),8000);
        cancels.add(cancel);
        try{operation().then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));}
        catch(error){finish(()=>reject(error));}
      });
    }
    /** 정상 검증된 데이터에서만 writer를 생성한다. @param {RpgData} initial @param {number} token */
    function play(initial,token) {
      let data=initial,alive=true;
      const active=()=>alive&&!destroyed&&generation===token;
      /** @type {Record<RpgKey,RpgWriteState>} */
      const writes=/** @type {Record<RpgKey,RpgWriteState>} */({});
      /** @type {Partial<Record<RpgKey,number>>} */ const retry={};
      /** @type {Partial<Record<RpgKey,number>>} */ const attempts={};
      /** @type {RpgPlayer|undefined} */ let pendingPlayer;
      /** @type {number|undefined} */ let checkpointTimer;
      /** @type {number|undefined} */ let stopTimer;
      let wasMoving=false;
      for(const key of codec.keys)writes[key]={localSequence:0,ackedSequence:0,inFlight:false,error:null,permanent:false};
      const changed=(/** @type {RpgKey} */ key)=>writes[key].localSequence>writes[key].ackedSequence;
      const locked=()=>codec.keys.some(key=>key!=='rpg_player'&&changed(key));
      const dirty=()=>!!pendingPlayer||codec.keys.some(changed);
      const emit=()=>{if(active())publish({status:'playable',data,writer});};
      /** 단일 키 최신 스냅샷을 직렬 전송한다. @param {RpgKey} key */
      function send(key) {
        const slot=writes[key];
        if(!active()||slot.inFlight||slot.permanent||!changed(key))return;
        if(retry[key]!==undefined){deps.clearTimer(/** @type {number} */(retry[key]));delete retry[key];}
        const sequence=slot.localSequence,snapshot=data[key];
        slot.inFlight=true;emit();
        void request(()=>deps.bridge.state.set(key,snapshot)).then(()=>{
          if(!active())return;
          slot.ackedSequence=Math.max(slot.ackedSequence,sequence);slot.inFlight=false;slot.error=null;attempts[key]=0;
          emit();send(key);
        },error=>{
          if(!active())return;
          slot.inFlight=false;slot.error=error;
          const code=typeof error==='object'&&error!==null&&'code' in error?error.code:'';
          slot.permanent=typeof code==='string'&&['invalid_state','invalid_params','invalid_request','invalid_response','unsupported_version','version_mismatch','permission_denied','forbidden','unauthorized'].includes(code);
          if(!slot.permanent){
            const delays=[1000,2000,4000,8000,16000,30000],index=attempts[key]??0;
            attempts[key]=index+1;retry[key]=deps.setTimer(()=>{delete retry[key];send(key);},delays[Math.min(index,5)]);
          }
          emit();
        });
      }
      /** 검증된 단일 키 행동만 수용한다. @param {RpgKey} key @param {RpgSave} value */
      function commit(key,value) {
        if(!active()||key==='rpg_meta'||(key!=='rpg_player'&&locked()))return false;
        const checked=codec.decode(key,value);if(checked.status!=='ok')return false;
        if(key==='rpg_world'){
          const next=codec.owned(/** @type {RpgWorld} */(checked.value));
          // 슬롯 삭제·종류 변경은 화분 수확 시각을 우회하므로 금지한다.
          if(codec.owned(data.rpg_world).some(old=>!next.some(n=>n.id===old.id&&n.kind===old.kind)))return false;
        }
        if(key==='rpg_collection'){
          const next=/** @type {RpgCollection} */(checked.value);
          if(data.rpg_collection.completed&&!next.completed)return false;
          if(next.nodes.some(n=>n.startsWith('pot-')&&!codec.owned(data.rpg_world).some(i=>i.kind==='pot'&&'pot-'+i.id===n.split(':')[0])))return false;
          // 보관 중인 화분도 이미 기록한 시각을 지울 수 없다.
          if(data.rpg_collection.nodes.some(n=>n.startsWith('pot-')&&!next.nodes.some(v=>v.split(':')[0]===n.split(':')[0]&&Number(v.split(':')[1])>=Number(n.split(':')[1]))))return false;
        }
        if(key==='rpg_collection'){
          const next=/** @type {RpgCollection} */(checked.value);
          // 채집·보여주기는 기존 표본과 최초 발견 시각을 줄이거나 바꾸지 않는다.
          if(data.rpg_collection.species.some(old=>{const [id,count,first]=old.split(':');return !next.species.some(value=>{const p=value.split(':');return p[0]===id&&Number(p[1])>=Number(count)&&p[2]===first&&p[3]===old.split(':')[3];});}))return false;
          if(data.rpg_collection.nodes.some(old=>{const [id,time]=old.split(':');return !next.nodes.some(value=>{const p=value.split(':');return p[0]===id&&Number(p[1])>=Number(time);});}))return false;
        }
        if(key==='rpg_residents'){
          const next=/** @type {RpgResidents} */(checked.value);
          if(data.rpg_residents.items.some(old=>{const [id,mask]=old.split(':');return !next.items.some(value=>{const p=value.split(':');return p[0]===id&&(Number(p[1])&Number(mask))===Number(mask);});}))return false;
        }
        if(JSON.stringify(data[key])===JSON.stringify(checked.value))return true;
        data={...data,[key]:checked.value};writes[key].localSequence++;emit();send(key);return true;
      }
      /** 최신 위치 하나를 저장하고 프레임 관측값은 요청으로 보내지 않는다. */
      function checkpoint() {
        if(pendingPlayer){const snapshot=pendingPlayer;pendingPlayer=undefined;commit('rpg_player',snapshot);}
      }
      /** 걷기 중 최대 10초마다 저장한다. */
      function scheduleWalking() {
        if(checkpointTimer!==undefined)return;
        checkpointTimer=deps.setTimer(()=>{checkpointTimer=undefined;checkpoint();if(wasMoving)scheduleWalking();},10000);
      }
      /** 위치는 프레임에서 관측하되 정지 1초 또는 10초 checkpoint에만 저장한다. @param {RpgPlayer} value @param {boolean} moving */
      function observePlayer(value,moving) {
        if(!active()||codec.decode('rpg_player',value).status!=='ok')return;
        const previous=pendingPlayer??data.rpg_player;
        if(['x','y','direction','outfit'].some(k=>previous[/** @type {'x'|'y'|'direction'|'outfit'} */(k)]!==value[/** @type {'x'|'y'|'direction'|'outfit'} */(k)]))pendingPlayer={...value,t:Math.max(value.t,previous.t)};
        if(moving){
          if(stopTimer!==undefined){deps.clearTimer(stopTimer);stopTimer=undefined;}
          scheduleWalking();
        }else if(wasMoving||pendingPlayer&&stopTimer===undefined){
          if(checkpointTimer!==undefined){deps.clearTimer(checkpointTimer);checkpointTimer=undefined;}
          stopTimer=deps.setTimer(()=>{stopTimer=undefined;checkpoint();},1000);
        }
        wasMoving=moving;
      }
      /** @type {RpgWriter} */
      const writer={commit,observePlayer,flush:()=>{if(!active())return;checkpoint();for(const key of codec.keys)send(key);},
        getSaveState:()=>({dirty:dirty(),locked:locked(),message:dirty()?'저장 안 됨':'저장됨',keys:/** @type {Record<RpgKey,RpgWriteState>} */(Object.fromEntries(codec.keys.map(k=>[k,{...writes[k]}])))})};
      dispose=()=>{
        alive=false;for(const timer of Object.values(retry))deps.clearTimer(timer);
        if(checkpointTimer!==undefined)deps.clearTimer(checkpointTimer);
        if(stopTimer!==undefined)deps.clearTimer(stopTimer);
      };
      emit();
    }
    /** 초기 읽기 전체 검증 전 PUT은 없고 dirty 상태에서는 원격 재로드를 차단한다. */
    async function load() {
      if(destroyed)return;
      if(state.status==='playable'&&state.writer.getSaveState().dirty){state.writer.flush();return;}
      const token=++generation;dispose?.();dispose=undefined;for(const cancel of [...cancels])cancel();
      publish({status:'loading'});let initializing=false;
      try {
        await request(()=>deps.bridge.ready());if(destroyed||token!==generation)return;
        /** @type {Partial<Record<RpgKey,unknown>>} */ const raw={};
        for(const key of codec.keys){raw[key]=await request(()=>deps.bridge.state.get(key));if(destroyed||token!==generation)return;}
        let data=codec.initial();
        if(raw.rpg_meta===null){
          const garden=await request(()=>deps.bridge.state.get('garden'));if(destroyed||token!==generation)return;
          if(garden!==null){
            const migrated=codec.migrate(garden);
            if(migrated.status!=='ok'){publish(migrated);return;}data=migrated.data;
          }
        }
        for(const key of codec.keys){
          const result=codec.decode(key,raw[key]);
          if(result.status==='missing'){
            if(raw.rpg_meta!==null){publish({status:'invalid_state',message:key+' 필수 저장이 없어요'});return;}
          }else if(result.status==='unsupported_version'){publish({status:'unsupported_version',message:key+' 저장 버전을 지원하지 않아요'});return;}
          else if(result.status==='invalid_state'){publish(result);return;}
          else data=/** @type {RpgData} */({...data,[key]:result.value});
        }
        if(data.rpg_collection.nodes.some(n=>n.startsWith('pot-')&&!codec.owned(data.rpg_world).some(i=>i.kind==='pot'&&'pot-'+i.id===n.split(':')[0]))){
          publish({status:'invalid_state',message:'화분과 수확 기록의 연결을 확인해 주세요'});return;
        }
        if(raw.rpg_meta===null){
          initializing=true;publish({status:'initializing'});
          for(const key of [...codec.keys.filter(k=>k!=='rpg_meta'),'rpg_meta']){
            const k=/** @type {RpgKey} */(key);
            if(raw[k]!==null)continue;
            await request(()=>deps.bridge.state.set(k,data[k]));if(destroyed||token!==generation)return;
          }
        }
        play(data,token);
      }catch(error){if(!destroyed&&token===generation)publish({status:initializing?'initialization_error':'load_error',message:initializing?'초기 저장을 마치지 못했어요 · 다시':'마당을 불러오지 못했어요 · 다시'});}
    }
    /** 세대와 모든 타이머를 폐기한다. */
    function destroy(){destroyed=true;generation++;dispose?.();for(const cancel of [...cancels])cancel();}
    return {getState:()=>state,load,destroy};
  }
  return Object.freeze({createSession});
})();
