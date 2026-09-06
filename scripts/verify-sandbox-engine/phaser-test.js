const game = new Phaser.Game({
  type:Phaser.AUTO, width:400, height:280, backgroundColor:'#193047', audio:{noAudio:true},
  scene:{
    preload() {
      this.load.on('loaderror', file => report(file.key, 'FAIL', {type:file.type, url:file.url, status:file.xhrLoader?.status}));
      this.load.image('external-image', 'tile.png');
      this.load.image('inline-image', inlinePng);
      this.load.json('external-json', 'map.json');
    },
    create() {
      report('engine', 'PASS', {version:Phaser.VERSION, renderer:this.game.renderer.type});
      for (const [index,key] of ['external-image','inline-image'].entries()) {
        if (this.textures.exists(key)) {
          this.add.image(80+index*100,100,key);
          report(key,'PASS',{width:this.textures.get(key).getSourceImage().width});
        }
      }
      if(this.cache.json.exists('external-json')) report('external-json','PASS',this.cache.json.get('external-json'));
      const texture = this.textures.createCanvas('generated',32,32);
      texture.context.fillStyle = '#ffcc44';
      texture.context.fillRect(0,0,32,32);
      texture.refresh();
      this.add.image(280,100,'generated');
      report('canvas-texture','PASS',{width:texture.width});
      this.input.on('pointerdown', pointer => report('pointer','PASS',{type:pointer.event.type, pointerType:pointer.event.pointerType, wasTouch:pointer.wasTouch, isTrusted:pointer.event.isTrusted, x:pointer.x,y:pointer.y}));
      let frames=0;
      this.events.on('update',()=>{ if(++frames === 60) report('loop','PASS',{frames}); });
    }
  }
});
