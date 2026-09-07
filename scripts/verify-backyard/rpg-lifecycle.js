/** 같은 문서에서 제품의 pagehide 정리만으로 자원이 해제되는지 계측한다. */
(() => {
  const original = {
    add: EventTarget.prototype.addEventListener, remove: EventTarget.prototype.removeEventListener,
    raf: window.requestAnimationFrame.bind(window), cancel: window.cancelAnimationFrame.bind(window),
    timer: window.setTimeout.bind(window), clear: window.clearTimeout.bind(window),
    interval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window), observer: window.ResizeObserver,
  };
  const listeners = new Set(), frames = new Set(), timers = new Map(), intervals = new Set(), observers = new Set();
  const games = new Set(), scenes = new Set();
  let createdGames = 0, destroyedGames = 0, createdScenes = 0, destroyedScenes = 0, session;
  const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
  EventTarget.prototype.addEventListener = function(type, handler, options) {
    if (!handler || options?.signal?.aborted) return original.add.call(this,type,handler,options);
    const existing = [...listeners].find(r => r.target === this && r.type === type && r.handler === handler && r.capture === capture(options));
    if (existing) return;
    const record = {target:this,type,handler,capture:capture(options),wrapped:null};
    record.wrapped = function(event) {
      if(options?.once) listeners.delete(record);
      if(typeof handler === 'function') handler.call(this,event); else handler.handleEvent(event);
    };
    listeners.add(record);
    if(options?.signal) original.add.call(options.signal,'abort',()=>listeners.delete(record),{once:true});
    original.add.call(this,type,record.wrapped,options);
  };
  EventTarget.prototype.removeEventListener = function(type,handler,options) {
    const record = [...listeners].find(r=>r.target===this&&r.type===type&&r.handler===handler&&r.capture===capture(options));
    if(record) listeners.delete(record);
    original.remove.call(this,type,record?.wrapped??handler,options);
  };
  window.requestAnimationFrame = callback => {const id=original.raf(time=>{frames.delete(id);callback(time);});frames.add(id);return id;};
  window.cancelAnimationFrame = id=>{frames.delete(id);original.cancel(id);};
  window.setTimeout = (callback,ms,...args)=>{const id=original.timer(()=>{timers.delete(id);callback(...args);},ms);timers.set(id,ms);return id;};
  window.clearTimeout = id=>{timers.delete(id);original.clear(id);};
  window.setInterval = (callback,ms,...args)=>{const id=original.interval(callback,ms,...args);intervals.add(id);return id;};
  window.clearInterval = id=>{intervals.delete(id);original.clearInterval(id);};
  window.ResizeObserver = class extends original.observer {
    observe(...args){observers.add(this);super.observe(...args);}
    disconnect(){observers.delete(this);super.disconnect();}
  };
  const Game = Phaser.Game;
  Phaser.Game = class extends Game {
    constructor(config){super(config);games.add(this);createdGames++;}
    runDestroy(){
      super.runDestroy();
      if(games.delete(this)) destroyedGames++;
      window.__lastDestroyed = {loopRunning:this.loop.running,sceneCount:this.scene.scenes.length,canvasConnected:!!this.canvas?.isConnected,textureCount:Object.keys(this.textures.list).length};
    }
  };
  const sceneInit = Phaser.Scenes.Systems.prototype.init;
  Phaser.Scenes.Systems.prototype.init = function(game){
    const result=sceneInit.call(this,game);scenes.add(this);createdScenes++;
    this.events.once('destroy',()=>{if(scenes.delete(this))destroyedScenes++;});return result;
  };
  const createSession=BackyardRpgSession.createSession;
  // 반환 세션만 관찰하며 timer·writer·destroy 구현은 원본 그대로 사용한다.
  window.BackyardRpgSession={createSession(deps){session=createSession(deps);return session;}};
  if(!window.MiniApp) window.MiniApp={ready:async()=>{},state:{get:async key=>BackyardRpgCodec.initial()[key]??null,set:async()=>{throw {code:'host_error'};}}};
  window.__life={
    counts:()=>({games:games.size,scenes:scenes.size,listeners:listeners.size,pointerListeners:[...listeners].filter(r=>r.type.startsWith('pointer')||r.type==='lostpointercapture').length,raf:frames.size,timers:timers.size,intervals:intervals.size,observers:observers.size,canvas:document.querySelectorAll('#world canvas').length}),
    totals:()=>({createdGames,destroyedGames,createdScenes,destroyedScenes}),
    details:()=>[...listeners].map(r=>({type:r.type,target:r.target.constructor.name})),
    failSave:()=>{const state=session.getState();if(state.status!=='playable')throw Error('세션 준비 안 됨');if(!state.writer.commit('rpg_collection',{...state.data.rpg_collection,species:['s0:1:1000:node-0']}))throw Error('실패 저장 주입 거절');},
    retryPending:()=>session.getState().status==='playable'&&!!session.getState().writer.getSaveState().keys.rpg_collection.error&&[...timers.values()].includes(1000),
    wait:ms=>new Promise(done=>original.timer(done,ms)),
  };
})();
