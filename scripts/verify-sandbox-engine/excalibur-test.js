/** 엔진과 자산의 성공 여부를 독립적으로 검사한다. */
async function verifyExcalibur() {
  const game = new ex.Engine({width:400,height:280,suppressPlayButton:true,suppressConsoleBootMessage:true,backgroundColor:ex.Color.fromHex('#193047')});
  await game.start();
  report('engine','PASS',{version:ex.EX_VERSION, renderer:game.graphicsContext.constructor.name});
  const actor = new ex.Actor({x:280,y:100,width:32,height:32,color:ex.Color.Yellow});
  game.add(actor);
  let frames=0;
  game.on('postupdate',()=>{if(++frames===60)report('loop','PASS',{frames});});
  for(const [key,path,x] of [['external-image','tile.png',80],['inline-image',inlinePng,180]]) {
    const resource = new ex.ImageSource(path);
    resource.load().then(()=>{
      const sprite = new ex.Actor({x,y:100});
      sprite.graphics.use(resource.toSprite());
      game.add(sprite);
      report(key,'PASS',{width:resource.width});
    }).catch(error=>report(key,'FAIL',String(error)));
  }
  const json = new ex.Resource('map.json','json');
  json.load().then(data=>report('external-json','PASS',data)).catch(error=>report('external-json','FAIL',String(error)));
}
verifyExcalibur().catch(error=>report('engine','FAIL',String(error)));
