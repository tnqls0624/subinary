// @ts-check
/** @typedef {Readonly<{localSequence:number,ackedSequence:number,dirty:boolean,inFlight:boolean,retryScheduled:boolean,error:unknown,permanentFailure:boolean,message:string}>} GardenSaveState */
/** @typedef {Readonly<{dispatch:(action:Action)=>ActionResult,flush:()=>void,getSaveState:()=>GardenSaveState}>} GardenWriter */
/** @typedef {Readonly<{status:'playable',garden:Garden,warnings:readonly TupleIssue[],writer:GardenWriter}>} PlayableGardenSession */
/** @typedef {Readonly<{status:'waiting_host'|'loading'}>|Readonly<{status:'load_error',error:unknown,message:string}>|Readonly<{status:'unsupported_version',version:unknown,message:string}>|Readonly<{status:'invalid_state',issues:readonly GardenIssue[]}>|PlayableGardenSession} GardenSessionState */
/** @typedef {{ready:()=>Promise<void>,state:{get:(key:string)=>Promise<unknown>,set:(key:string,value:GardenSaveV1)=>Promise<void>}}} GardenBridge */
/** @typedef {{bridge:GardenBridge,nowSec:()=>number,seed:()=>number,setTimer:(callback:()=>void,delayMs:number)=>number,clearTimer:(id:number)=>void,onChange?:(state:GardenSessionState)=>void,rules?:ReturnType<typeof BackyardRules.createRules>,codec?:ReturnType<typeof BackyardCodec.createCodec>}} GardenSessionDependencies */
/** 주입된 통신·시계·타이머만 사용하는 세션 팩토리다. */
var BackyardSession = (() => {
  /** @param {GardenSessionDependencies} deps @returns {{getState:()=>GardenSessionState,load:()=>Promise<void>,destroy:()=>void}} 명시적인 load 호출 전에는 통신하지 않는다. */
  function createSession(deps) {
    const rules = deps.rules ?? BackyardRules.createRules();
    const codec = deps.codec ?? BackyardCodec.createCodec();
    /** @type {GardenSessionState} */ let state = Object.freeze({status:'waiting_host'});
    let generation = 0;
    let destroyed = false;
    /** @type {(()=>void)|undefined} */ let disposePlayable;
    /** @type {(()=>void)|undefined} */ let cancelRead;
    /** @returns {GardenSessionState} 판별 유니온으로 현재 상태를 제공한다. */
    function getState() { return state; }
    /** @param {GardenSessionState} next 현재 세대의 변경만 구독자에게 알린다. */
    function publish(next) {
      if (destroyed) return;
      state = Object.freeze(next);
      deps.onChange?.(state);
    }
    /** @param {unknown} error @returns {boolean} 영구 오류는 자동 반복하지 않는다. */
    function isPermanent(error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : error;
      return typeof code === 'string' && ['invalid_request','invalid_params','invalid_state','invalid_response','unsupported_version','version_mismatch','permission_denied','forbidden','unauthorized'].includes(code);
    }
    /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} 읽기와 ready의 무응답을 8초로 제한한다. */
    function readWithTimeout(operation) {
      return new Promise((resolve,reject) => {
        let settled = false;
        /** @param {()=>void} finish */
        function settle(finish) {
          if (settled) return;
          settled = true;
          deps.clearTimer(timer);
          if (cancelRead === cancel) cancelRead = undefined;
          finish();
        }
        const timer = deps.setTimer(() => settle(() => reject({code:'timeout',message:'불러오기 응답 시간이 지났어요'})),8000);
        const cancel = () => settle(() => reject({code:'cancelled'}));
        cancelRead = cancel;
        try { Promise.resolve(operation()).then(value => settle(() => resolve(value)),error => settle(() => reject(error))); }
        catch (error) { settle(() => reject(error)); }
      });
    }
    /** @param {Garden} initial @param {readonly TupleIssue[]} warnings @param {number} token @param {boolean} isNew 정상 읽기 이후 이 함수 안에서만 writer를 만든다. */
    function enterPlayable(initial, warnings, token, isNew) {
      let garden = initial;
      let localSequence = 0;
      let ackedSequence = 0;
      /** @type {GardenSaveV1|undefined} */ let latestSnapshot;
      let inFlight = false;
      /** @type {number|undefined} */ let retryTimer;
      let retryAttempt = 0;
      /** @type {unknown} */ let error;
      let permanentFailure = false;
      const delays = [1000,2000,4000,8000,16000,30000];
      const active = () => !destroyed && generation === token;
      const notify = () => { if (active()) publish(playable); };
      function clearRetry() { if (retryTimer !== undefined) { deps.clearTimer(retryTimer); retryTimer = undefined; } }
      disposePlayable = clearRetry;
      /** @returns {GardenSaveState} ACK는 보낸 순번까지만 반영한다. */
      function getSaveState() {
        return Object.freeze({localSequence,ackedSequence,dirty:localSequence > ackedSequence,inFlight,retryScheduled:retryTimer !== undefined,error,permanentFailure,message:error === undefined ? '' : '저장 안 됨'});
      }
      /** 최신 전체 스냅샷 하나만 직렬 전송한다. */
      function pump() {
        if (!active() || inFlight || permanentFailure || !latestSnapshot || localSequence <= ackedSequence) return;
        clearRetry();
        const sequence = localSequence;
        const snapshot = latestSnapshot;
        inFlight = true;
        notify();
        /** @param {unknown} failure */
        function failed(failure) {
          if (!active()) return;
          inFlight = false;
          error = failure ?? {code:'host_error',message:'저장에 실패했어요'};
          permanentFailure = isPermanent(failure);
          if (!permanentFailure) {
            const delay = delays[Math.min(retryAttempt,delays.length - 1)];
            retryAttempt += 1;
            retryTimer = deps.setTimer(() => { retryTimer = undefined; pump(); },delay);
          }
          notify();
        }
        try {
          Promise.resolve(deps.bridge.state.set('garden',snapshot)).then(() => {
            if (!active()) return;
            inFlight = false;
            ackedSequence = Math.max(ackedSequence,sequence);
            retryAttempt = 0;
            error = undefined;
            notify();
            pump();
          },failed);
        } catch (failure) { failed(failure); }
      }
      /** @param {number} savedAtSec 확정 행동과 같은 호출 흐름에서 스냅샷을 만든다. */
      function enqueue(savedAtSec) {
        localSequence += 1;
        clearRetry();
        const result = codec.serializeGarden(garden,savedAtSec);
        if (result.status !== 'ok') {
          error = {code:'invalid_state',issues:result.issues};
          permanentFailure = true;
          latestSnapshot = undefined;
          notify();
          return;
        }
        // 저장 요청의 시각을 메모리에도 고정하여 ACK 대기 중 시계 역행을 막는다.
        garden = rules.freezeGarden({...garden,lastSavedAtSec:result.value.t});
        latestSnapshot = result.value;
        notify();
        pump();
      }
      /** @param {Action} action @returns {ActionResult} 성공한 변경만 즉시 저장 큐에 넣는다. */
      function dispatch(action) {
        if (!active()) return {status:'error',code:'inactive_session',message:'이미 종료된 마당이에요'};
        const now = deps.nowSec();
        const result = rules.applyAction(garden,action,now);
        if (result.status === 'ok') { garden = result.garden; enqueue(now); return {...result,garden}; }
        return result;
      }
      /** 숨김 이벤트 등에서 미저장 상태의 보조 전송을 요청한다. */
      function flush() { if (active()) pump(); }
      /** @type {PlayableGardenSession} */
      const playable = Object.freeze({status:'playable',get garden() { return garden; },warnings:Object.freeze([...warnings]),writer:Object.freeze({dispatch,flush,getSaveState})});
      publish(playable);
      if (isNew) enqueue(initial.lastSavedAtSec);
    }
    /** @returns {Promise<void>} 이전 세대의 쓰기·타이머를 폐기하고 새 읽기를 시작한다. */
    async function load() {
      if (destroyed) return;
      const token = ++generation;
      cancelRead?.();
      disposePlayable?.();
      disposePlayable = undefined;
      const active = () => !destroyed && generation === token;
      publish({status:'waiting_host'});
      try {
        await readWithTimeout(() => deps.bridge.ready());
        if (!active()) return;
        publish({status:'loading'});
        const raw = await readWithTimeout(() => deps.bridge.state.get('garden'));
        if (!active()) return;
        if (raw === null) { enterPlayable(rules.createInitialGarden(deps.nowSec(),deps.seed()),[],token,true); return; }
        const decoded = codec.deserializeGarden(raw);
        if (decoded.status === 'ok') enterPlayable(decoded.garden,decoded.warnings,token,false);
        else if (decoded.status === 'unsupported_version') publish({...decoded,message:'앱을 업데이트해 주세요'});
        else publish(decoded);
      } catch (error) { if (active()) publish({status:'load_error',error,message:'불러오지 못했어요 · 다시'}); }
    }
    /** 모든 타이머를 정리하고 늦은 응답 및 보관된 writer를 무효화한다. */
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      cancelRead?.();
      disposePlayable?.();
      disposePlayable = undefined;
      state = Object.freeze({status:'waiting_host'});
    }
    return Object.freeze({getState,load,destroy});
  }
  return Object.freeze({createSession});
})();
