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
  const rules = BackyardRpgRules;
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
    if(paused||!loaded||!player||!worldScene)return;
    if(editing) {
      if(!writable()){feedback.textContent='저장 완료를 기다려 주세요';return;}
      const cell=rules.preview(player,direction),reason=rules.placementReason(decorations.filter(d=>d.id!==movingId),cell,[player]);
      if(reason){feedback.textContent=reason;return;}
      const reused=owned.find(i=>i.id===movingId)??owned.find(i=>i.stored&&i.kind===chosen);
      if(!reused&&owned.length>=48){feedback.textContent='보관 포함 48개예요 · 보관한 물건을 다시 놓아 주세요';return;}
      const id=reused?.id??String(Array.from({length:48},(_,i)=>i).find(i=>!owned.some(o=>o.id===String(i))));
      const next={id,kind:reused?.kind??chosen,...cell,stored:false};
      if(saveWorld([...owned.filter(i=>i.id!==id),next])){movingId=null;feedback.textContent='앞에 놓았어요';}
      return;
    }
    const current=rules.target(player,direction,[...rules.sites,...rules.decorationTargets(decorations)],decorations);
    if(!current){feedback.textContent='조금 더 다가가 바라봐 주세요';return;}
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
    if(paused||!loaded)worldScene?.physics.world.pause();else worldScene?.physics.world.resume();
  }
  window.addEventListener('message',event=>{
    if(event.source!==window.parent || event.data?.type!=='backyard.viewport' || typeof event.data.paused!=='boolean')return;
    paused=event.data.paused;syncPause();
  });
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
        rules.sites.forEach(t=>{const image=this.add.image(t.x,t.y+12,t.kind).setOrigin(0.5,1).setDepth(t.y);if(t.kind==='berry')berries.push({image,y:t.y+12});});
        rules.trees.forEach(t=>this.add.image(t.x,t.y+5,'tree').setOrigin(0.5,1).setDepth(t.y));
        this.physics.world.setBounds(0,0,rules.width,rules.height);
        const solids=this.physics.add.staticGroup();
        for(const rect of rules.obstacles){
          const solid=this.add.rectangle(rect.x,rect.y,rect.width,rect.height).setOrigin(0).setVisible(false);
          solids.add(solid);
        }
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
        },()=>!paused&&loaded,act);
        syncPause();
        this.events.once('shutdown',()=>{input?.destroy();input=null;player=null;intent={x:0,y:0};});
        worldHost.dataset.ready='true';
      }catch(error){console.error(error);fail();}
    }
    /** 프레임 복귀 시 입력을 버려 큰 delta 이동을 막는다. @param {number} time @param {number} delta */
    update(time,delta){
      if(!player||paused||!loaded) return;
      if(delta>100) input?.reset();
      const moving=!!(player.body && (Math.abs(player.body.velocity.x)>0.01||Math.abs(player.body.velocity.y)>0.01));
      if(intent.x||intent.y) direction=(Math.round(Math.atan2(intent.y,intent.x)/(Math.PI/4))+8)%8;
      currentWriter?.observePlayer({v:2,mapVersion:1,x:Math.max(0,Math.min(511,Math.round(player.x/2))),y:Math.max(0,Math.min(383,Math.round(player.y/2))),direction,outfit:restored.outfit,t:Math.floor(Date.now()/1000)},moving);
      if(currentWriter){const status=currentWriter.getSaveState();saveLabel.textContent=status.message;saveLabel.dataset.dirty=String(status.dirty);}
      walkingTime=moving?walkingTime+Math.min(delta,50):0;
      player.setTexture(`walker-${restored.outfit}-${direction}-${moving?1+Math.floor(walkingTime/125)%4:0}`).setDepth(player.y);
      player.setScale(1,!moving && time<reactionUntil && nearest?.kind==='chair'?0.78:1);
      berries.forEach(item=>item.image.y=item.y+Math.sin(time/1400*Math.PI*2)*2);
      nearest=rules.target(player,direction,[...rules.sites,...rules.decorationTargets(decorations)],decorations);
      if(editing) {
        const cell=rules.preview(player,direction),reason=rules.placementReason(decorations.filter(d=>d.id!==movingId),cell,[player]);
        outline?.setVisible(true).setPosition(cell.col*32+16,cell.row*32+16).setStrokeStyle(2,reason?0xb46555:0x536e49);
        ghost?.setVisible(true).setTexture(chosen).setPosition(cell.col*32+16,cell.row*32+32);
        const message=`${owned.length}/48 (보관 포함) · ${reason||'앞 칸에 놓을 수 있어요'}`;
        if(placement.textContent!==message)placement.textContent=message;
        action.textContent='여기 놓기';
      }else {
        ghost?.setVisible(false);outline?.setVisible(!!nearest);
        if(nearest)outline?.setPosition(nearest.x,nearest.y).setStrokeStyle(2,0x536e49).setScale(time<reactionUntil?1+Math.sin(time/100)*0.08:1);
        action.textContent=nearest?.label||'다가가 보기';
      }
      action.setAttribute('aria-disabled',String(!editing&&!nearest));
      const nextPlace=player.x>570 && player.y<448?'연못가':player.x>=496&&player.x<=560?'오솔길':player.y<420?'나무 그늘':'집 앞 마당';
      if(placeLabel.textContent!==nextPlace) placeLabel.textContent=nextPlace;
      player.setVelocity(intent.x,intent.y);
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
      if(fresh){
        restored=state.data.rpg_player;editing=false;movingId=null;
        if(player){const point=safePosition(restored);player.setPosition(point.x,point.y);direction=restored.direction;}
        feedback.textContent=state.data.rpg_world.legacyFruit?'예전 마당에서 모은 열매 '+state.data.rpg_world.legacyFruit+'개':'같은 마당을 공유해요. 동시에 바꾸면 마지막 저장이 남아요';
      }
      if(!game)startGame();else if(changed)renderFurniture();
      if(fresh)syncPause();
    }});
  document.addEventListener('visibilitychange',()=>{
    input?.reset();
    if(document.hidden)currentWriter?.flush();else void session.load();
  });
  window.addEventListener('pagehide',()=>{currentWriter?.flush();session.destroy();observer.disconnect();input?.destroy();game?.destroy(true);game=null;},{once:true});
  void session.load();
})();
