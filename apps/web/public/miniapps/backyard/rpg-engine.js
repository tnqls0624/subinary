// @ts-check
/// <reference path="../../../types/phaser/phaser.d.ts" />
/** Phaser 객체는 이 어댑터 안에서만 소유한다. 저장 브리지는 연결하지 않는다. */
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
  let paused = window.innerHeight < 300, editing = false, chosen = 'pot', nextId = 0;
  let decorations = rules.decorationFixture();
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
    if(paused||!player||!worldScene)return;
    if(editing) {
      const cell=rules.preview(player,direction),reason=rules.placementReason(decorations,cell,[player]);
      if(reason){feedback.textContent=reason;return;}
      decorations=[...decorations,{id:`placed-${nextId++}`,kind:chosen,...cell}];renderFurniture();
      feedback.textContent='앞에 놓았어요 · 이번 산책에서만 유지돼요';return;
    }
    const current=rules.target(player,direction,[...rules.sites,...rules.decorationTargets(decorations)],decorations);
    if(!current){feedback.textContent='조금 더 다가가 바라봐 주세요';return;}
    if(current.kind==='workbench') {editing=true;editor.hidden=false;feedback.textContent='걸어서 앞 칸을 고른 뒤 놓아 주세요';return;}
    reactionUntil=worldScene.time.now+1400;
    feedback.textContent=current.kind==='chair'?'의자에 잠시 앉아 쉬어요':current.kind==='well'?'우물에 동그란 물결이 번져요':current.kind==='fishing'?'물 아래 작은 그림자가 지나가요':current.kind==='bug'?'잎 사이에서 작은 날개가 움직여요':'잎과 열매가 살랑여요';
    input?.reset();
  }
  action.addEventListener('click',act);
  document.getElementById('cancel')?.addEventListener('click',()=>{editing=false;editor.hidden=true;feedback.textContent='산책을 계속해요';pad?.focus({preventScroll:true});});
  document.querySelectorAll('[data-kind]').forEach(button=>button.addEventListener('click',()=>{
    chosen=/** @type {HTMLElement} */(button).dataset.kind||'pot';
    document.querySelectorAll('[data-kind]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  }));
  document.getElementById('store')?.addEventListener('click',()=>{
    if(paused||!player)return;
    const current=rules.target(player,direction,rules.decorationTargets(decorations),decorations);
    if(!current){feedback.textContent='보관할 물건 가까이 다가가 바라봐 주세요';return;}
    decorations=decorations.filter(d=>d.id!==current.id);renderFurniture();feedback.textContent='보관했어요 · 원하는 곳에 다시 놓을 수 있어요';
  });
  /** 부모 신원 확인 후 숨겨진 게임의 물리와 입력을 함께 멈춘다. */
  function syncPause() {
    input?.reset();
    if(paused)worldScene?.physics.world.pause();else worldScene?.physics.world.resume();
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
        const fixture=rules.fixture();direction=fixture.direction;
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
        },()=>!paused,act);
        syncPause();
        this.events.once('shutdown',()=>{input?.destroy();input=null;player=null;intent={x:0,y:0};});
        worldHost.dataset.ready='true';
      }catch(error){console.error(error);fail();}
    }
    /** 프레임 복귀 시 입력을 버려 큰 delta 이동을 막는다. @param {number} time @param {number} delta */
    update(time,delta){
      if(!player||paused) return;
      if(delta>100) input?.reset();
      const moving=!!(player.body && (Math.abs(player.body.velocity.x)>0.01||Math.abs(player.body.velocity.y)>0.01));
      if(intent.x||intent.y) direction=(Math.round(Math.atan2(intent.y,intent.x)/(Math.PI/4))+8)%8;
      walkingTime=moving?walkingTime+Math.min(delta,50):0;
      player.setTexture(`walker-0-${direction}-${moving?1+Math.floor(walkingTime/125)%4:0}`).setDepth(player.y);
      player.setScale(1,!moving && time<reactionUntil && nearest?.kind==='chair'?0.78:1);
      berries.forEach(item=>item.image.y=item.y+Math.sin(time/1400*Math.PI*2)*2);
      nearest=rules.target(player,direction,[...rules.sites,...rules.decorationTargets(decorations)],decorations);
      if(editing) {
        const cell=rules.preview(player,direction),reason=rules.placementReason(decorations,cell,[player]);
        outline?.setVisible(true).setPosition(cell.col*32+16,cell.row*32+16).setStrokeStyle(2,reason?0xb46555:0x536e49);
        ghost?.setVisible(true).setTexture(chosen).setPosition(cell.col*32+16,cell.row*32+32);
        const message=`${decorations.length}/48 · ${reason||'앞 칸에 놓을 수 있어요'}`;
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
  try {
    if(typeof Phaser==='undefined' || Phaser.VERSION!=='4.2.1') throw Error('Phaser 4.2.1을 불러오지 못했어요');
    game=new Phaser.Game({type:Phaser.AUTO,parent:worldHost,width:Math.min(rules.width,worldHost.clientWidth),height:Math.min(rules.height,worldHost.clientHeight),backgroundColor:'#adbf88',banner:false,audio:{noAudio:true},physics:{default:'arcade',arcade:{gravity:{x:0,y:0},fixedStep:true}},scene:[Boot,World]});
    observer.observe(worldHost);
    window.addEventListener('pagehide',()=>{observer.disconnect();input?.destroy();game?.destroy(true);game=null;},{once:true});
  }catch(error){console.error(error);fail();}
})();
