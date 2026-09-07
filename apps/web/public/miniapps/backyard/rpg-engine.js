// @ts-check
/// <reference path="../../../types/phaser/phaser.d.ts" />
/** Phaser 객체는 이 어댑터 안에서만 소유한다. 세션의 검증된 논리 상태만 사용한다. */
(() => {
  const host = document.getElementById('world');
  const pad = document.getElementById('pad');
  const place = document.getElementById('place');
  const failure = document.getElementById('failure');
  if(!host || !pad || !place || !failure) throw Error('마당 화면 요소가 없어요');
  const worldHost = host, placeLabel = place, errorPanel = failure;
  const rules = BackyardRpgRules, life = BackyardRpgLife;
  const action = /** @type {HTMLButtonElement} */(document.getElementById('action'));
  const editor = /** @type {HTMLElement} */(document.getElementById('editor'));
  const feedback = /** @type {HTMLElement} */(document.getElementById('feedback'));
  const placement = /** @type {HTMLElement} */(document.getElementById('placement'));
  let paused = window.innerHeight < 300, editing = false, chosen = 'pot';
  /** @type {RpgDecoration[]} */ let decorations = [];
  /** @type {RpgOwned[]} */ let owned = [];
  /** @type {RpgPlayer} */ let restored = BackyardRpgCodec.initial().rpg_player;
  /** @type {RpgWriter|undefined} */ let currentWriter;
  /** @type {string|null} */ let movingId = null;
  let loaded=false;
  let actors=life.walkers();
  /** @type {Phaser.GameObjects.Image[]} */ let actorImages=[];
  /** @type {{node:RpgNode,image:Phaser.GameObjects.Image}[]} */ let nodeImages=[];
  /** @type {RpgFishing} */ let fishing={phase:'idle'};
  /** @type {{node:string,remaining:number}|null} */ let gathering=null;
  /** @type {Phaser.GameObjects.Image|null} */ let fishingArt=null;
  /** @type {Phaser.GameObjects.Image|null} */ let netArt=null;
  let dialogueId='',cardName='',panelPaused=false,sittingTogether=false;
  const dialogue=/** @type {HTMLElement} */(document.getElementById('dialogue'));
  const dialogueText=/** @type {HTMLElement} */(document.getElementById('dialogue-text'));
  const card=/** @type {HTMLElement} */(document.getElementById('catch-card'));
  const cancelFishing=/** @type {HTMLButtonElement} */(document.getElementById('cancel-fishing'));
  /** 진행 시간과 걷기를 멈추는 공통 경계다. */
  function suspended(){return paused||document.hidden||panelPaused||!loaded;}
  /** 벽시계를 초 단위로 읽고 역행은 채집점 readyAt 검사에서 차단한다. */
  function now(){return Math.max(0,Math.floor(Date.now()/1000));}
  /** 실제 존재하는 근접 대상만 만든다. */
  function targets(){
    const state=session.getState();if(state.status!=='playable')return [];
    const collection=state.data.rpg_collection;
    return [...rules.sites.filter(t=>t.kind==='workbench'||t.kind==='fishing').map(t=>({...t,label:t.kind==='fishing'?'낚시하기':t.label})),
      ...life.nodes.filter(n=>now()>=life.readyAt(collection,n.id)),
      ...actors.map(a=>({...a,kind:'resident',label:'말 걸기 · '+life.residents.find(r=>r.id===a.id)?.name})),
      ...rules.decorationTargets(decorations).map(t=>t.kind==='pot'?{...t,label:now()>=life.readyAt(collection,'pot-'+t.id)?'따기 · 노란 열매':'열매가 자라는 중'}:t)];
  }
  /** 이름 카드는 ACK가 오기 전까지 저장 중으로 표시한다. @param {number} index */
  function showCatch(index){
    cardName=life.species[index].name;card.hidden=false;
    const icon=/** @type {HTMLCanvasElement} */(document.getElementById('catch-icon'));
    const context=icon.getContext('2d');if(context){context.clearRect(0,0,64,64);drawSpecies(context,index,64);}
    updateCard();
  }
  /** 저장 실패는 숨기지 않고 재시도할 수 있게 한다. */
  function updateCard(){
    if(!cardName)return;
    const state=currentWriter?.getSaveState(),slot=state?.keys.rpg_collection;
    const message=slot&&slot.localSequence>slot.ackedSequence?(slot.error?'저장 후 계속할 수 있어요 · 다시':'저장 중'):'도감에 남겼어요';
    const label=document.getElementById('catch-text');if(label)label.textContent=cardName+' · '+message;
  }
  /** 주민 앞에서만 소비 없는 관계 행동을 확정한다. @param {'talk'|'sample'|'sit'} mode */
  function converse(mode){
    if(suspended()||!player||!writable())return;
    const state=session.getState(),actor=actors.find(a=>a.id===dialogueId);
    if(state.status!=='playable'||!actor||Math.hypot(actor.x-player.x,actor.y-player.y)>40)return;
    if(mode==='sample'&&!state.data.rpg_collection.species.length){dialogueText.textContent='표본을 하나 만난 뒤 함께 살펴봐요';return;}
    if(mode==='sit'&&!life.layout(actor,decorations).nearby.some(d=>d.kind==='chair')){dialogueText.textContent='가까이에 의자를 놓으면 함께 앉을 수 있어요';return;}
    const result=life.talk(state.data.rpg_residents,actor.id,actor,decorations,state.data.rpg_collection,mode);
    if(!result||!state.writer.commit('rpg_residents',result.state))return;
    sittingTogether=mode==='sit';dialogueText.textContent=result.text;
    const title=document.getElementById('dialogue-title');if(title)title.textContent=life.residents.find(r=>r.id===actor.id)?.name+' · 함께한 경험 '+result.friendship+'/12';
    dialogue.hidden=false;input?.reset();syncPause();
  }
  document.getElementById('talk-next')?.addEventListener('click',()=>converse('talk'));
  document.getElementById('show-sample')?.addEventListener('click',()=>converse('sample'));
  document.getElementById('sit-together')?.addEventListener('click',()=>converse('sit'));
  document.getElementById('close-dialogue')?.addEventListener('click',()=>{dialogueId='';sittingTogether=false;dialogue.hidden=true;syncPause();action.focus();});
  dialogue.addEventListener('keydown',event=>{
    if(event.key==='Escape'){document.getElementById('close-dialogue')?.click();return;}
    if(event.key!=='Tab')return;
    const buttons=Array.from(dialogue.querySelectorAll('button'));const index=buttons.indexOf(/** @type {HTMLButtonElement} */(document.activeElement));
    event.preventDefault();buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
  });
  document.getElementById('close-card')?.addEventListener('click',()=>{card.hidden=true;cardName='';action.focus();});
  document.getElementById('retry-save')?.addEventListener('click',()=>currentWriter?.flush());
  cancelFishing.addEventListener('click',()=>{fishing={phase:'idle'};gathering=null;cancelFishing.hidden=true;fishingArt?.setVisible(false);netArt?.setVisible(false);syncPause();feedback.textContent='산책을 계속해요';action.focus();});

  const saveLabel=/** @type {HTMLElement} */(document.getElementById('save'));
  /** 저장 ACK 전에는 의미 있는 편집을 잠근다. */
  function writable() {return loaded&&!!currentWriter&&!currentWriter.getSaveState().locked;}
  /** 검증 후 world 한 키만 저장한다. @param {RpgOwned[]} next */
  function saveWorld(next) {
    const state=session.getState();
    if(state.status!=='playable'||!writable())return false;
    return state.writer.commit('rpg_world',BackyardRpgCodec.world(next,state.data.rpg_world.legacyFruit));
  }
  /** 막힌 저장 위치는 가까운 통행 타일로만 복원한다. @param {RpgPlayer} saved */
  function safePosition(saved) {
    const point={x:saved.x*2,y:saved.y*2};
    if(rules.canStand(point.x,point.y,decorations))return point;
    const cells=[];
    for(let row=0;row<24;row++)for(let col=0;col<32;col++){
      const cell={x:col*32+16,y:row*32+16};
      if(rules.canStand(cell.x,cell.y,decorations))cells.push(cell);
    }
    cells.sort((a,b)=>Math.hypot(a.x-point.x,a.y-point.y)-Math.hypot(b.x-point.x,b.y-point.y));
    return cells[0]??{x:240,y:592};
  }
  /** @type {World|null} */ let worldScene = null;
  /** @type {Phaser.Physics.Arcade.StaticGroup|null} */ let furnitureSolids = null;
  /** @type {Phaser.GameObjects.Image[]} */ let furnitureImages = [];
  /** @type {{image:Phaser.GameObjects.Image,y:number}[]} */ let berries = [];
  /** @type {Phaser.GameObjects.Rectangle|null} */ let outline = null;
  /** @type {Phaser.GameObjects.Image|null} */ let ghost = null;
  /** @type {RpgTarget|null} */ let nearest = null;
  let reactionUntil = 0;
  /** 배치 변경 후 물리·외형을 같은 규칙 상태로 갱신한다. */
  function renderFurniture() {
    if(!worldScene || !furnitureSolids)return;
    furnitureSolids.clear(true,true);furnitureImages.forEach(image=>image.destroy());furnitureImages=[];
    for(const d of decorations) {
      furnitureImages.push(worldScene.add.image(d.col*32+16,d.row*32+32,d.kind).setOrigin(0.5,1).setDepth(d.row*32+16));
      furnitureSolids.add(worldScene.add.rectangle(d.col*32,d.row*32,32,32).setOrigin(0).setVisible(false));
    }
  }
  /** 행동 순간에 대상/배치를 재검증한다. 먼 곳에서의 획득은 없다. */
  function act() {
    if(suspended()||!player||!worldScene||dialogueId||gathering)return;
    if(fishing.phase!=='idle'){fishing=life.pull(fishing);return;}
    if(editing) {
      if(!writable()){feedback.textContent='저장 완료를 기다려 주세요';return;}
      const cell=rules.preview(player,direction),reason=rules.placementReason(decorations.filter(d=>d.id!==movingId),cell,[player,...actors]);
      if(reason){feedback.textContent=reason;return;}
      const reused=owned.find(i=>i.id===movingId)??owned.find(i=>i.stored&&i.kind===chosen);
      if(!reused&&owned.length>=48){feedback.textContent='보관 포함 48개예요 · 보관한 물건을 다시 놓아 주세요';return;}
      const id=reused?.id??String(Array.from({length:48},(_,i)=>i).find(i=>!owned.some(o=>o.id===String(i))));
      const next={id,kind:reused?.kind??chosen,...cell,stored:false};
      if(saveWorld([...owned.filter(i=>i.id!==id),next])){movingId=null;feedback.textContent='앞에 놓았어요';}
      return;
    }
    const current=rules.target(player,direction,targets(),decorations);
    if(!current){feedback.textContent='조금 더 다가가 바라봐 주세요';return;}
    if(!writable()){feedback.textContent='저장 후 계속할 수 있어요 · 다시';return;}
    if(current.kind==='resident'){dialogueId=current.id;converse('talk');document.getElementById('close-dialogue')?.focus();return;}
    if(current.kind==='gather'||current.kind==='pot'){
      const node=current.kind==='pot'?'pot-'+current.id:current.id;
      const state=session.getState();if(state.status!=='playable')return;
      if(!life.gather(state.data.rpg_collection,node,now(),owned)){feedback.textContent=now()<life.readyAt(state.data.rpg_collection,node)?'조금 더 자라면 만나요':'충분히 모았어요 · 수량은 그대로예요';return;}
      gathering={node,remaining:current.kind==='gather'&&(life.nodes.find(n=>n.id===node)?.species??0)>=4?400:350};
      input?.reset();syncPause();feedback.textContent='조심스럽게 손을 뻗어요';return;
    }
    if(current.kind==='fishing'){
      fishing=life.cast(Number(current.id.slice(-1)),Math.random());direction=0;cancelFishing.hidden=false;
      input?.reset();syncPause();feedback.textContent='찌를 바라보며 천천히 기다려요';return;
    }
    if(current.kind==='workbench') {editing=true;editor.hidden=false;feedback.textContent='걸어서 앞 칸을 고른 뒤 놓아 주세요';return;}
    reactionUntil=worldScene.time.now+1400;
    feedback.textContent=current.kind==='chair'?'의자에 잠시 앉아 쉬어요':current.kind==='well'?'우물에 동그란 물결이 번져요':current.kind==='fishing'?'물 아래 작은 그림자가 지나가요':current.kind==='bug'?'잎 사이에서 작은 날개가 움직여요':'잎과 열매가 살랑여요';
    input?.reset();
  }
  action.addEventListener('click',act);
  document.getElementById('cancel')?.addEventListener('click',()=>{editing=false;movingId=null;editor.hidden=true;feedback.textContent='산책을 계속해요';pad?.focus({preventScroll:true});});
  document.querySelectorAll('[data-kind]').forEach(button=>button.addEventListener('click',()=>{
    movingId=null;chosen=/** @type {HTMLElement} */(button).dataset.kind||'pot';
    document.querySelectorAll('[data-kind]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  }));
  document.getElementById('store')?.addEventListener('click',()=>{
    if(paused||!player||!writable())return;
    const current=rules.target(player,direction,rules.decorationTargets(decorations),decorations);
    if(!current){feedback.textContent='보관할 물건 가까이 다가가 바라봐 주세요';return;}
    if(saveWorld(owned.map(i=>i.id===current.id?{...i,stored:true}:i)))feedback.textContent='보관했어요 · 같은 종류를 고르면 다시 놓아요';
  });
  document.getElementById('move')?.addEventListener('click',()=>{
    if(paused||!player||!writable())return;
    const current=rules.target(player,direction,rules.decorationTargets(decorations),decorations);
    if(!current){feedback.textContent='옮길 물건 가까이 다가가 바라봐 주세요';return;}
    movingId=current.id;chosen=current.kind;editing=true;editor.hidden=false;feedback.textContent='걸어서 새 자리를 골라 주세요';
  });
  /** 부모 신원 확인 후 숨겨진 게임의 물리와 입력을 함께 멈춘다. */
  function syncPause() {
    input?.reset();
    if(suspended()||dialogueId||fishing.phase!=='idle'||gathering)worldScene?.physics.world.pause();else worldScene?.physics.world.resume();
  }
  window.addEventListener('message',event=>{
    if(event.source!==window.parent || event.data?.type!=='backyard.viewport' || typeof event.data.paused!=='boolean')return;
    paused=event.data.paused;syncPause();
  });
  document.addEventListener('backyard.panel',event=>{panelPaused=/** @type {CustomEvent<{open:boolean}>} */(event).detail?.open===true;syncPause();});
  window.addEventListener('blur',()=>{panelPaused=true;syncPause();});
  window.addEventListener('focus',()=>{panelPaused=false;syncPause();});
  /** @type {Phaser.Game|null} */ let game = null;
  /** @type {Phaser.Physics.Arcade.Sprite|null} */ let player = null;
  /** @type {ReturnType<typeof BackyardRpgInput.create>|null} */ let input = null;
  let direction = 6, walkingTime = 0;
  /** @type {RpgVector} */ let intent = {x:0,y:0};
  /** 실패 시 루프와 입력을 해제하고 HTML 재시도를 제공한다. */
  function fail() { input?.destroy(); input=null; game?.destroy(true);game=null;errorPanel.hidden=false; }
  document.getElementById('retry')?.addEventListener('click',()=>location.reload());
  /** 생성 캔버스에 타원 도형을 그린다.
   * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y
   * @param {number} rx @param {number} ry @param {string} color */
  function oval(ctx,x,y,rx,ry,color) {ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.fill();}
  /** 색 외에 날개·몸통·무늬로 16종을 구분한다. @param {CanvasRenderingContext2D} c @param {number} index @param {number} size */
  function drawSpecies(c,index,size){
    c.save();c.scale(size/40,size/40);
    const ink='#53604a';
    if(index<2){oval(c,20,25,index===0?8:6,8,index===0?'#d7b461':'#c16d58');oval(c,24,14,6,3,'#688a58');}
    else if(index===2){c.fillStyle='#ebd8ac';c.fillRect(17,21,6,13);oval(c,20,19,12,7,'#c88b68');oval(c,16,17,2,2,'#eee2c6');}
    else if(index===3){for(let row=0;row<4;row++)for(let col=0;col<2;col++)oval(c,16+col*7,11+row*6,5,4,row%2?'#827451':'#b18a62');}
    else if(index===4||index===5){const color=index===4?'#f5f1e7':'#d7b461';oval(c,13,17,index===4?7:5,8,color);oval(c,27,17,index===4?7:5,8,color);oval(c,14,27,5,5,color);oval(c,26,27,5,5,color);oval(c,20,23,2,9,ink);}
    else if(index===6){oval(c,20,24,8,9,'#c16d58');oval(c,20,14,4,3,ink);for(const x of [16,24])for(const y of [21,27])oval(c,x,y,1.5,1.5,ink);c.fillStyle=ink;c.fillRect(19,17,2,15);}
    else if(index===7){for(const x of [12,28])for(const y of [17,24])oval(c,x,y,9,3,'#e1e8d6');oval(c,20,24,2,13,'#659da7');oval(c,20,11,3,3,ink);}
    else{
      const fish=index-8,colors=['#d7b461','#b18a62','#e1e8d6','#88a7a0','#827451','#72979b','#c8d9d3','#c88b68'];
      const rx=fish===0?10:fish===2?9:fish===4?15:12,ry=fish===0?10:fish===2?3:fish===4?3:fish===5?8:6;
      c.fillStyle=colors[fish];c.beginPath();c.moveTo(27,22);c.lineTo(37,15);c.lineTo(37,29);c.fill();
      if(fish===6){c.beginPath();c.moveTo(5,22);c.lineTo(19,12);c.lineTo(31,22);c.lineTo(19,32);c.fill();}else oval(c,18,22,rx,ry,colors[fish]);
      oval(c,10,20,1.4,1.4,ink);
      if(fish===1||fish===5){c.strokeStyle=ink;c.lineWidth=1;for(const y of [23,26]){c.beginPath();c.moveTo(7,23);c.lineTo(1,y+3);c.stroke();}}
      if(fish===3){c.fillStyle=ink;for(let x=17;x<28;x+=4)c.fillRect(x,18,1,8);}
      if(fish===7)for(const x of [16,22,27])oval(c,x,22+(x%2?2:-2),1.5,1.5,ink);
    }
    c.restore();
  }
  if(typeof Phaser==='undefined' || Phaser.VERSION!=='4.2.1') { fail(); return; }
  class Boot extends Phaser.Scene {
    constructor(){super('Boot');}
    create(){
      try {
        for(let outfit=0;outfit<2;outfit++) for(let d=0;d<8;d++) for(let frame=0;frame<5;frame++) {
          const texture=this.textures.createCanvas(`walker-${outfit}-${d}-${frame}`,32,40);
          if(!texture) throw Error('캐릭터 텍스처를 만들지 못했어요');
          const ctx=texture.context, phase=frame===0?0:Math.sin((frame-1)*Math.PI/2)*2;
          const angle=d*Math.PI/4, back=Math.sin(angle)<-0.4;
          oval(ctx,16,36,10,3,'#536e4933');
          oval(ctx,11,34+phase,4,2,'#53604a');oval(ctx,21,34-phase,4,2,'#53604a');
          ctx.fillStyle=outfit===0?'#c88b68':'#72979b';ctx.beginPath();ctx.roundRect(7,18,18,15,5);ctx.fill();
          oval(ctx,5,25-phase,3,4,'#ebc6a0');oval(ctx,27,25+phase,3,4,'#ebc6a0');
          oval(ctx,16,13,10,10,'#ebc6a0');
          oval(ctx,16,7,10,5,'#645847');
          if(back) oval(ctx,16,13,10,8,'#645847');
          else {const gaze=Math.cos(angle)*3;oval(ctx,13+gaze,14,1,1.4,'#454c3c');oval(ctx,19+gaze,14,1,1.4,'#454c3c');}
          texture.refresh();
        }
        for(const kind of ['pot','well','chair','berry','leaf','bug','fishing','workbench']) {
          const texture=this.textures.createCanvas(kind,40,48);
          if(!texture)throw Error('물건 텍스처를 만들지 못했어요');
          const c=texture.context;
          oval(c,20,43,16,4,'#536e4933');
          c.fillStyle='#827451';
          if(kind==='pot'||kind==='berry') {
            c.fillStyle='#c88b68';c.beginPath();c.roundRect(9,27,22,15,4);c.fill();
            oval(c,14,21,8,5,'#688a58');oval(c,26,15,7,8,'#688a58');oval(c,20,21,4,4,'#c88b68');
          }else if(kind==='well') {
            c.fillStyle='#d8c7a0';c.beginPath();c.roundRect(4,23,32,20,5);c.fill();oval(c,20,25,13,6,'#80b8b8');
            c.fillStyle='#827451';c.fillRect(5,8,4,25);c.fillRect(31,8,4,25);
            c.fillStyle='#c88b68';c.beginPath();c.moveTo(2,12);c.lineTo(20,1);c.lineTo(38,12);c.fill();
          }else if(kind==='chair'||kind==='workbench') {
            c.fillStyle='#827451';c.fillRect(8,28,5,16);c.fillRect(28,28,5,16);
            c.fillStyle='#d8c7a0';c.beginPath();c.roundRect(5,23,30,10,4);c.fill();
            if(kind==='chair'){c.beginPath();c.roundRect(6,8,28,17,4);c.fill();}else {c.fillStyle='#c88b68';c.fillRect(12,17,14,6);}
          }else if(kind==='fishing') {oval(c,20,32,16,7,'#80b8b8');oval(c,20,32,9,3,'#536e49');}
          else {oval(c,15,32,10,5,'#688a58');oval(c,26,27,9,5,'#688a58');if(kind==='bug')oval(c,20,28,4,5,'#c88b68');}
          texture.refresh();
        }
        for(const resident of life.residents)for(let d=0;d<8;d++)for(let frame=0;frame<5;frame++){
          const texture=this.textures.createCanvas(`${resident.id}-${d}-${frame}`,40,52);if(!texture)throw Error('주민 그림을 만들지 못했어요');
          const c=texture.context,phase=frame===0?0:Math.sin((frame-1)*Math.PI/2)*2,color=resident.shape==='bear'?'#b18a62':resident.shape==='bird'?'#88a7a0':'#eee2c6';
          oval(c,20,48,12,3,'#536e4933');oval(c,14,46+phase,4,3,'#77694d');oval(c,26,46-phase,4,3,'#77694d');
          oval(c,20,35,12,12,color);oval(c,20,22,12,11,color);
          if(resident.shape==='bear'){oval(c,11,12,5,5,color);oval(c,29,12,5,5,color);oval(c,20,26,6,4,'#ebd8ac');}
          if(resident.shape==='rabbit'){oval(c,14,8,4,10,color);oval(c,26,8,4,10,color);oval(c,14,8,1.5,7,'#c88b68');oval(c,26,8,1.5,7,'#c88b68');}
          if(resident.shape==='bird'){oval(c,8,34-phase,5,9,'#688a58');oval(c,32,34+phase,5,9,'#688a58');c.fillStyle='#d7b461';c.beginPath();c.moveTo(20,22);c.lineTo(34,26);c.lineTo(20,29);c.fill();}
          if(Math.sin(d*Math.PI/4)>=-0.4){const gaze=Math.cos(d*Math.PI/4)*3;oval(c,16+gaze,21,1.2,1.5,'#374b40');oval(c,24+gaze,21,1.2,1.5,'#374b40');}
          texture.refresh();
        }
        for(const item of life.species){const texture=this.textures.createCanvas(item.id,40,40);if(!texture)throw Error('표본 그림을 만들지 못했어요');drawSpecies(texture.context,item.index,40);texture.refresh();}
        for(const kind of ['rod','net']){
          const texture=this.textures.createCanvas(kind,100,64);if(!texture)throw Error('도구 그림을 만들지 못했어요');const c=texture.context;
          c.strokeStyle='#827451';c.lineWidth=2;c.beginPath();c.moveTo(4,58);c.lineTo(35,5);c.stroke();
          if(kind==='rod'){c.strokeStyle='#f5f1e7';c.lineWidth=1;c.beginPath();c.moveTo(35,5);c.lineTo(84,48);c.stroke();oval(c,84,48,3,5,'#c88b68');}
          else {c.strokeStyle='#f5f1e7';c.beginPath();c.ellipse(42,14,14,10,0,0,Math.PI*2);c.stroke();}
          texture.refresh();
        }
        this.scene.start('World');
      }catch(error){console.error(error);fail();}
    }
  }
  class World extends Phaser.Scene {
    constructor(){super('World');}
    create(){
      try {
        const texture=this.textures.createCanvas('ground',rules.width,rules.height);
        if(!texture) throw Error('지도를 만들지 못했어요');
        const ctx=texture.context;
        ctx.fillStyle='#adbf88';ctx.fillRect(0,0,rules.width,rules.height);
        for(let row=0;row<rules.rows;row++) for(let col=0;col<rules.cols;col++) {
          ctx.fillStyle=(col*7+row*11)%3===0?'#b4c58f':'#a8bb82';
          ctx.fillRect(col*32+8,row*32+13,3,2);
        }
        ctx.fillStyle='#d8c7a0';for(const path of rules.paths){ctx.beginPath();ctx.roundRect(path.x,path.y,path.width,path.height,5);ctx.fill();}
        ctx.strokeStyle='#829462';ctx.lineWidth=14;ctx.strokeRect(8,8,1008,752);
        ctx.fillStyle='#d8c7a0';for(const water of rules.water){ctx.beginPath();ctx.roundRect(water.x-6,water.y-5,water.width+12,water.height+10,5);ctx.fill();}
        ctx.fillStyle='#80b8b8';for(const water of rules.water)ctx.fillRect(water.x,water.y,water.width,water.height);
        ctx.strokeStyle='#659da7';ctx.lineWidth=3;
        for(let y=150;y<400;y+=40)for(let x=660;x<940;x+=64){ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+12,y+5,x+24,y);ctx.stroke();}
        const h=rules.house;ctx.fillStyle='#ebd8ac';ctx.fillRect(h.x,h.y,h.width,h.height);
        ctx.fillStyle='#ad7760';ctx.beginPath();ctx.moveTo(h.x-12,h.y+4);ctx.lineTo(h.x+64,h.y-44);ctx.lineTo(h.x+h.width+12,h.y+4);ctx.fill();
        ctx.fillStyle='#77694d';ctx.fillRect(224,510,24,34);ctx.fillStyle='#98b6ad';ctx.fillRect(178,501,26,22);
        texture.refresh();this.add.image(0,0,'ground').setOrigin(0);
        const treeTexture=this.textures.createCanvas('tree',72,96);
        if(!treeTexture) throw Error('나무를 만들지 못했어요');
        const tc=treeTexture.context;oval(tc,36,87,26,6,'#536e492b');tc.fillStyle='#827451';tc.fillRect(28,51,16,37);
        oval(tc,36,38,32,31,'#688a58');oval(tc,24,29,20,22,'#7e9d63');oval(tc,46,25,19,20,'#87a86b');treeTexture.refresh();
        rules.sites.filter(t=>t.kind==='workbench'||t.kind==='fishing').forEach(t=>{const image=this.add.image(t.x,t.y+12,t.kind).setOrigin(0.5,1).setDepth(t.y);if(t.kind==='berry')berries.push({image,y:t.y+12});});
        rules.trees.forEach(t=>this.add.image(t.x,t.y+5,'tree').setOrigin(0.5,1).setDepth(t.y));
        this.physics.world.setBounds(0,0,rules.width,rules.height);
        const solids=this.physics.add.staticGroup();
        for(const rect of rules.obstacles){
          const solid=this.add.rectangle(rect.x,rect.y,rect.width,rect.height).setOrigin(0).setVisible(false);
          solids.add(solid);
        }
        nodeImages=life.nodes.map(node=>({node,image:this.add.image(node.x,node.y+8,'s'+node.species).setOrigin(0.5,1).setDepth(node.y).setScale(node.species>=4?0.6:1)}));
        actorImages=actors.map(actor=>this.add.image(actor.x,actor.y,actor.id+'-0-0').setOrigin(0.5,0.92).setDepth(actor.y));
        fishingArt=this.add.image(0,0,'rod').setOrigin(0,1).setDepth(1900).setVisible(false);
        netArt=this.add.image(0,0,'net').setOrigin(0,1).setDepth(1900).setVisible(false);
        worldScene=this;furnitureSolids=this.physics.add.staticGroup();renderFurniture();
        const fixture={...safePosition(restored),direction:restored.direction,outfit:restored.outfit};direction=fixture.direction;
        player=this.physics.add.sprite(fixture.x,fixture.y,`walker-${fixture.outfit}-${direction}-0`).setOrigin(0.5,0.9);
        player.setSize(14,10).setOffset(9,26).setCollideWorldBounds(true);
        this.physics.add.collider(player,solids);
        this.physics.add.collider(player,furnitureSolids);
        outline=this.add.rectangle(0,0,32,32).setStrokeStyle(2,0x536e49).setFillStyle(0x688a58,0.12).setDepth(2000).setVisible(false);
        ghost=this.add.image(0,0,'pot').setOrigin(0.5,1).setAlpha(0.5).setDepth(2001).setVisible(false);
        const camera=this.cameras.main;
        camera.setBounds(0,0,rules.width,rules.height).startFollow(player,false,0.35,0.35).setDeadzone(64,48);
        camera.centerOn(player.x,player.y);
        input=BackyardRpgInput.create(/** @type {HTMLElement} */(pad), velocity=>{
          intent=velocity;player?.setVelocity(velocity.x,velocity.y);
        },()=>!suspended()&&!dialogueId&&fishing.phase==='idle'&&!gathering,act);
        syncPause();
        this.events.once('shutdown',()=>{input?.destroy();input=null;player=null;intent={x:0,y:0};});
        worldHost.dataset.ready='true';
      }catch(error){console.error(error);fail();}
    }
    /** 프레임 복귀 시 입력을 버려 큰 delta 이동을 막는다. @param {number} time @param {number} delta */
    update(time,delta){
      if(!player||suspended()) return;
      const elapsed=delta>100?0:Math.max(0,delta);
      const state=session.getState();if(state.status!=='playable')return;
      updateCard();
      fishing=life.tickFishing(fishing,elapsed,!!dialogueId);
      if(fishing.phase==='pulling'&&fishing.remaining===0){
        const spot=fishing.spot;fishing={phase:'idle'};cancelFishing.hidden=true;fishingArt?.setVisible(false);
        const result=life.catchFish(state.data.rpg_collection,spot,now(),state.data.rpg_meta.seed);
        if(result&&writable()&&state.writer.commit('rpg_collection',result.state))showCatch(result.index);
        else feedback.textContent='충분히 모았거나 저장을 기다리고 있어요 · 수량은 그대로예요';
        syncPause();
      }
      if(gathering){
        gathering.remaining=Math.max(0,gathering.remaining-elapsed);
        netArt?.setVisible((life.nodes.find(n=>n.id===gathering?.node)?.species??0)>=4).setPosition(player.x,player.y);
        if(gathering.remaining===0){
          const node=gathering.node;gathering=null;netArt?.setVisible(false);
          const result=life.gather(state.data.rpg_collection,node,now(),owned);
          if(result&&writable()&&state.writer.commit('rpg_collection',result))showCatch(life.nodes.find(n=>n.id===node)?.species??0);
          syncPause();
        }
      }
      if(fishing.phase!=='idle')fishingArt?.setVisible(true).setPosition(player.x,player.y+(fishing.phase==='bite'?Math.sin(time/200)*2:fishing.phase==='pulling'?-(600-fishing.remaining)/50:0));
      nodeImages.forEach(({node,image})=>image.setVisible(now()>=life.readyAt(state.data.rpg_collection,node.id)).setPosition(node.x,node.y+8+(node.species>=4?Math.sin(time/700+node.species)*2:0)));
      const playerPoint={x:player.x,y:player.y};
      actors=actors.map((actor,i)=>{
        const focused=!!rules.target(playerPoint,direction,[{...actor,kind:'resident',label:''}],decorations);
        const next=life.walk(actor,elapsed,decorations,focused||!!dialogueId);
        if(focused){next.direction=(Math.round(Math.atan2(playerPoint.y-next.y,playerPoint.x-next.x)/(Math.PI/4))+8)%8;}
        actorImages[i].setPosition(next.x,next.y).setDepth(next.y).setScale(1,sittingTogether&&dialogueId===next.id?0.8:1).setTexture(`${next.id}-${next.direction}-${next.phase?1+Math.floor(next.phase/125)%4:0}`);
        return next;
      });
      if(delta>100) input?.reset();
      const moving=!!(player.body && (Math.abs(player.body.velocity.x)>0.01||Math.abs(player.body.velocity.y)>0.01));
      if(intent.x||intent.y) direction=(Math.round(Math.atan2(intent.y,intent.x)/(Math.PI/4))+8)%8;
      currentWriter?.observePlayer({v:2,mapVersion:1,x:Math.max(0,Math.min(511,Math.round(player.x/2))),y:Math.max(0,Math.min(383,Math.round(player.y/2))),direction,outfit:restored.outfit,t:Math.floor(Date.now()/1000)},moving);
      if(currentWriter){const status=currentWriter.getSaveState();saveLabel.textContent=status.message;saveLabel.dataset.dirty=String(status.dirty);}
      walkingTime=moving?walkingTime+Math.min(delta,50):0;
      player.setTexture(`walker-${restored.outfit}-${direction}-${gathering?2:moving?1+Math.floor(walkingTime/125)%4:0}`).setDepth(player.y);
      player.setScale(1,sittingTogether||!moving&&time<reactionUntil&&nearest?.kind==='chair'?0.78:1);
      berries.forEach(item=>item.image.y=item.y+Math.sin(time/1400*Math.PI*2)*2);
      nearest=rules.target(player,direction,targets(),decorations);
      if(editing) {
        const cell=rules.preview(player,direction),reason=rules.placementReason(decorations.filter(d=>d.id!==movingId),cell,[player,...actors]);
        outline?.setVisible(true).setPosition(cell.col*32+16,cell.row*32+16).setStrokeStyle(2,reason?0xb46555:0x536e49);
        ghost?.setVisible(true).setTexture(chosen).setPosition(cell.col*32+16,cell.row*32+32);
        const message=`${owned.length}/48 (보관 포함) · ${reason||'앞 칸에 놓을 수 있어요'}`;
        if(placement.textContent!==message)placement.textContent=message;
        action.textContent='여기 놓기';
      }else {
        ghost?.setVisible(false);outline?.setVisible(!!nearest);
        if(nearest)outline?.setPosition(nearest.x,nearest.y).setStrokeStyle(2,0x536e49).setScale(time<reactionUntil?1+Math.sin(time/100)*0.08:1);
        action.textContent=fishing.phase==='bite'?'끌어올리기':fishing.phase==='pulling'?'끌어올리는 중':fishing.phase==='waiting'?'입질을 기다려요':gathering?'조심스럽게 채집 중':nearest?.label||'다가가 보기';
      }
      action.setAttribute('aria-disabled',String(!editing&&!nearest));
      const nextPlace=player.x>570 && player.y<448?'연못가':player.x>=496&&player.x<=560?'오솔길':player.y<420?'나무 그늘':'집 앞 마당';
      if(placeLabel.textContent!==nextPlace) placeLabel.textContent=nextPlace;
      player.setVelocity(dialogueId||fishing.phase!=='idle'||gathering?0:intent.x,dialogueId||fishing.phase!=='idle'||gathering?0:intent.y);
      this.cameras.main.setLerp(1-Math.exp(-Math.min(delta,50)/40));
    }
  }
  const observer=new ResizeObserver(()=>{
    if(game) game.scale.resize(Math.max(1,Math.min(rules.width,worldHost.clientWidth)),Math.max(1,Math.min(rules.height,worldHost.clientHeight)));
    paused=window.innerHeight<300;syncPause();
  });
  /** 초기화 ACK와 전체 검증 후에만 엔진을 연다. */
  function startGame() {
  try {
    if(typeof Phaser==='undefined' || Phaser.VERSION!=='4.2.1') throw Error('Phaser 4.2.1을 불러오지 못했어요');
    game=new Phaser.Game({type:Phaser.AUTO,parent:worldHost,width:Math.min(rules.width,worldHost.clientWidth),height:Math.min(rules.height,worldHost.clientHeight),backgroundColor:'#adbf88',banner:false,audio:{noAudio:true},physics:{default:'arcade',arcade:{gravity:{x:0,y:0},fixedStep:true}},scene:[Boot,World]});
    observer.observe(worldHost);

  }catch(error){console.error(error);fail();}
  }
  const bridge=(/** @type {typeof globalThis & {MiniApp?: RpgSessionDeps['bridge']}} */(globalThis)).MiniApp;
  if(!bridge){fail();return;}
  const session=BackyardRpgSession.createSession({bridge,setTimer:(fn,ms)=>window.setTimeout(fn,ms),clearTimer:id=>window.clearTimeout(id),
    onChange:state=>{
      loaded=state.status==='playable';
      errorPanel.hidden=loaded;
      if(state.status!=='playable'){
        const message=errorPanel.querySelector('p');
        if(message)message.textContent='message' in state?state.message:state.status==='initializing'?'처음 마당을 저장하고 있어요':'마당을 불러오고 있어요';
        editor.hidden=true;syncPause();return;
      }
      const fresh=currentWriter!==state.writer;currentWriter=state.writer;
      const next=BackyardRpgCodec.owned(state.data.rpg_world),visible=next.filter(i=>!i.stored);
      const changed=JSON.stringify(decorations)!==JSON.stringify(visible);
      owned=next;decorations=visible;
      saveLabel.textContent=currentWriter.getSaveState().message;
      const retrySave=document.getElementById('retry-save');if(retrySave)retrySave.hidden=!Object.values(currentWriter.getSaveState().keys).some(key=>!!key.error);
      if(fresh){
        restored=state.data.rpg_player;editing=false;movingId=null;dialogueId='';dialogue.hidden=true;
        if(player){const point=safePosition(restored);player.setPosition(point.x,point.y);direction=restored.direction;}
        feedback.textContent=state.data.rpg_world.legacyFruit?'예전 마당에서 모은 열매 '+state.data.rpg_world.legacyFruit+'개':'같은 마당을 공유해요. 동시에 바꾸면 마지막 저장이 남아요';
      }
      if(!game)startGame();else if(changed)renderFurniture();
      if(fresh)syncPause();
    }});
  document.addEventListener('visibilitychange',()=>{
    input?.reset();syncPause();
    if(document.hidden)currentWriter?.flush();else void session.load();
  });
  window.addEventListener('pagehide',()=>{currentWriter?.flush();session.destroy();observer.disconnect();input?.destroy();game?.destroy(true);game=null;},{once:true});
  void session.load();
})();
