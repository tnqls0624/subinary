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
        ctx.fillStyle='#d8c7a0';ctx.fillRect(208,560,368,64);ctx.fillRect(496,224,64,400);ctx.fillRect(528,288,112,64);
        ctx.strokeStyle='#829462';ctx.lineWidth=14;ctx.strokeRect(8,8,1008,752);
        const pond=rules.pond;ctx.fillStyle='#80b8b8';ctx.fillRect(pond.x,pond.y,pond.width,pond.height);
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
        rules.trees.forEach(t=>this.add.image(t.x,t.y+5,'tree').setOrigin(0.5,1).setDepth(t.y));
        this.physics.world.setBounds(0,0,rules.width,rules.height);
        const solids=this.physics.add.staticGroup();
        for(const rect of rules.obstacles){
          const solid=this.add.rectangle(rect.x,rect.y,rect.width,rect.height).setOrigin(0).setVisible(false);
          solids.add(solid);
        }
        const fixture=rules.fixture();direction=fixture.direction;
        player=this.physics.add.sprite(fixture.x,fixture.y,`walker-${fixture.outfit}-${direction}-0`).setOrigin(0.5,0.9);
        player.setSize(14,10).setOffset(9,26).setCollideWorldBounds(true);
        this.physics.add.collider(player,solids);
        const camera=this.cameras.main;
        camera.setBounds(0,0,rules.width,rules.height).startFollow(player,false,0.35,0.35).setDeadzone(64,48);
        camera.centerOn(player.x,player.y);
        input=BackyardRpgInput.create(/** @type {HTMLElement} */(pad), velocity=>{
          intent=velocity;player?.setVelocity(velocity.x,velocity.y);
        });
        this.events.once('shutdown',()=>{input?.destroy();input=null;player=null;intent={x:0,y:0};});
        worldHost.dataset.ready='true';
      }catch(error){console.error(error);fail();}
    }
    /** 프레임 복귀 시 입력을 버려 큰 delta 이동을 막는다. @param {number} time @param {number} delta */
    update(time,delta){
      if(!player) return;
      if(delta>100) input?.reset();
      const moving=!!(player.body && (Math.abs(player.body.velocity.x)>0.01||Math.abs(player.body.velocity.y)>0.01));
      if(intent.x||intent.y) direction=(Math.round(Math.atan2(intent.y,intent.x)/(Math.PI/4))+8)%8;
      walkingTime=moving?walkingTime+Math.min(delta,50):0;
      player.setTexture(`walker-0-${direction}-${moving?1+Math.floor(walkingTime/125)%4:0}`).setDepth(player.y);
      const nextPlace=player.x>570 && player.y<448?'연못가':player.y<420?'나무 그늘':'집 앞 마당';
      if(placeLabel.textContent!==nextPlace) placeLabel.textContent=nextPlace;
      player.setVelocity(intent.x,intent.y);
      this.cameras.main.setLerp(1-Math.exp(-Math.min(delta,50)/40));
    }
  }
  const observer=new ResizeObserver(()=>{
    if(game) game.scale.resize(Math.max(1,Math.min(rules.width,worldHost.clientWidth)),Math.max(1,Math.min(rules.height,worldHost.clientHeight)));
    input?.reset();
  });
  try {
    if(typeof Phaser==='undefined' || Phaser.VERSION!=='4.2.1') throw Error('Phaser 4.2.1을 불러오지 못했어요');
    game=new Phaser.Game({type:Phaser.AUTO,parent:worldHost,width:Math.min(rules.width,worldHost.clientWidth),height:Math.min(rules.height,worldHost.clientHeight),backgroundColor:'#adbf88',banner:false,audio:{noAudio:true},physics:{default:'arcade',arcade:{gravity:{x:0,y:0},fixedStep:true}},scene:[Boot,World]});
    observer.observe(worldHost);
    window.addEventListener('pagehide',()=>{observer.disconnect();input?.destroy();game?.destroy(true);game=null;},{once:true});
  }catch(error){console.error(error);fail();}
})();
