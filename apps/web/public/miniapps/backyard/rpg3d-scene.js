// @ts-check
/// <reference path="../../../types/three-r128.d.ts" />
/// <reference path="rpg-rules.js" />
/// <reference path="rpg3d-terrain.js" />
/// <reference path="rpg3d-models.js" />
/// <reference path="rpg3d-world.js" />
/**
 * 걷기 화면의 r128 장면. 규칙이 계산한 것만 그린다.
 *
 * ## 벤치마크(ACNH)에서 가져온 네 가지
 *
 * 1. **구면 곡률** — 모든 세계 재질의 vertex shader에서 카메라 거리의 제곱만큼 아래로
 *    굽힌다. 지평선이 생기고 하늘이 보인다. 그림자 좌표는 월드 위치로 계산되므로
 *    (`shadowmap_vertex`) 곡률과 무관하게 맞는다. 하늘 돔은 굽히지 않는다.
 * 2. **높은 키의 따뜻한 조명** — 그림자가 검지 않고 따뜻한 회녹색이다. 정점색 잔디 위에
 *    캔버스로 그린 삼각 패턴 텍스처를 곱한다(이미지 파일 0).
 * 3. **실시간 시간대** — 새벽·낮·저녁·밤의 하늘·태양·안개를 시각으로 보간한다. 밤에는
 *    집 창문이 켜진다. 규칙은 몰라도 되는 순수 표현이다.
 * 4. **접지·피드백** — 캐릭터 발밑 접지 그림자, 표본 등장 튀어오름, 획득 반짝이, 입질에
 *    잠기는 찌, 대화 중 카메라 접근.
 */
var BackyardRpg3dScene = {
/** 장면 자원의 소유권을 호출자에게 돌려준다.
 * @param {HTMLElement} host @param {HTMLCanvasElement} canvas
 * @param {{walking?:boolean,outfit?:number,hour?:number,onError:(error:unknown)=>void}} options */
create(host,canvas,options) {
  const listeners=new AbortController();
  /** @type {import('three').WebGLRenderer|null} */ let renderer=null;
  /** @type {Set<import('three').BufferGeometry>} */ const geometries=new Set();
  /** @type {Set<import('three').Material>} */ const materials=new Set();
  /** @type {Set<import('three').Texture>} */ const textures=new Set();
  /** @type {Set<import('three').WebGLRenderTarget>} */ const targets=new Set();
  let disposed=false,frame=0;
  /** 오류는 빈 캔버스 대신 HTML로 표시한다. @param {unknown} error */
  function fail(error) {options.onError(error);host.removeAttribute('data-ready');}
  /** 소유 자원을 한 번만 해제한다. */
  function dispose(){
    if(disposed)return;disposed=true;listeners.abort();cancelAnimationFrame(frame);
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());targets.forEach(t=>t.dispose());
    renderer?.dispose();renderer=null;host?.removeAttribute('data-ready');
  }
  try {
    if(typeof THREE==='undefined'||THREE.REVISION!=='128')throw Error('동봉한 Three.js r128을 불러오지 못했습니다');
    if(typeof BackyardRpgRules==='undefined'||typeof BackyardRpg3dTerrain==='undefined')throw Error('지도 규칙을 불러오지 못했습니다');
    if(typeof BackyardRpg3dModels==='undefined'||typeof BackyardRpgLife==='undefined')throw Error('마당 모델을 불러오지 못했습니다');
    const rules=BackyardRpgRules,terrain=BackyardRpg3dTerrain;
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
    const view=renderer;
    view.outputEncoding=THREE.sRGBEncoding;view.toneMapping=THREE.NoToneMapping;
    view.shadowMap.enabled=true;view.shadowMap.type=THREE.PCFShadowMap;
    view.shadowMap.autoUpdate=false;view.info.autoReset=false;
    /** 팔레트 sRGB 값을 r128의 선형 작업 색공간으로 변환한다. @param {string} hex */
    const color=hex=>new THREE.Color(hex).convertSRGBToLinear();

    // ── 구면 곡률 ──────────────────────────────────────────────────────────────
    // (k, 시작 거리). 시작 거리 안쪽(플레이어 주변)은 굽히지 않아 발 위치와 화면이 일치한다.
    const curve={value:new THREE.Vector2(0.0082,9)};
    const sway={value:0};
    const bentProject=THREE.ShaderChunk.project_vertex.replace('gl_Position = projectionMatrix * mvPosition;',
      'float bendDistance=max(0.0,-mvPosition.z-uCurve.y);mvPosition.y-=bendDistance*bendDistance*uCurve.x;\ngl_Position = projectionMatrix * mvPosition;');
    /**
     * 재질 등록 + 곡률 주입. `sway`는 수관 전용으로 인스턴스 위치 기준 바람 흔들림을 더한다.
     * @template {import('three').Material} T @param {T} material @param {{bend?:boolean,sway?:boolean}} [flags] @returns {T}
     */
    function material(material,flags={}){
      materials.add(material);
      if(flags.bend===false)return material;
      const windy=flags.sway===true;
      material.onBeforeCompile=shader=>{
        shader.uniforms.uCurve=curve;shader.uniforms.uSway=sway;
        let vertex=shader.vertexShader.replace('#include <common>','#include <common>\nuniform vec2 uCurve;uniform float uSway;');
        if(windy)vertex=vertex.replace('#include <begin_vertex>','#include <begin_vertex>\n#ifdef USE_INSTANCING\nvec2 windSeed=instanceMatrix[3].xz;\ntransformed.x+=sin(uSway*0.0011+windSeed.x*0.7+windSeed.y*0.3)*0.045*(transformed.y+1.0);\ntransformed.z+=cos(uSway*0.0009+windSeed.y*0.8)*0.03*(transformed.y+1.0);\n#endif');
        shader.vertexShader=vertex.replace('#include <project_vertex>',bentProject);
      };
      material.customProgramCacheKey=()=>windy?'bend-sway':'bend';
      return material;
    }
    /** geometry 해제 소유권을 등록한다. @template {import('three').BufferGeometry} T @param {T} geometry @returns {T} */
    function geometry(geometry){geometries.add(geometry);return geometry;}
    /** @param {string} hex */
    const lambert=hex=>material(new THREE.MeshLambertMaterial({color:color(hex)}));
    const models=BackyardRpg3dModels.create({geometry,material:m=>material(m),color});
    models.textures.forEach(t=>textures.add(t));
    const shop=models;

    // ── 시간대 ────────────────────────────────────────────────────────────────
    /** @typedef {{zenith:string,horizon:string,sun:string,sunPower:number,skyLight:string,groundLight:string,fill:number,fog:string,windows:number}} RpgAtmosphere */
    /** 시각(0~24)별 키프레임. 사이 값은 선형 보간한다. @type {[number,RpgAtmosphere][]} */
    const keyframes=[
      [0,{zenith:'#1E2C52',horizon:'#3E4F7C',sun:'#93ADE6',sunPower:0.44,skyLight:'#7A92CF',groundLight:'#33415A',fill:0.7,fog:'#3A4A6E',windows:1}],
      [5,{zenith:'#33487A',horizon:'#7A7E9A',sun:'#B7BFE0',sunPower:0.4,skyLight:'#98A4C8',groundLight:'#4E5A58',fill:0.7,fog:'#6B7590',windows:0.8}],
      [6.5,{zenith:'#7FA9D6',horizon:'#F5CFA5',sun:'#FFD6A6',sunPower:0.72,skyLight:'#FFE3C4',groundLight:'#8A9670',fill:0.9,fog:'#E6D2B8',windows:0.2}],
      [8.5,{zenith:'#62AEE3',horizon:'#C6E0EE',sun:'#FFF3DA',sunPower:0.86,skyLight:'#FFF8E6',groundLight:'#A3B983',fill:1.02,fog:'#DCE6CC',windows:0}],
      [16,{zenith:'#66B0E2',horizon:'#CFE3EA',sun:'#FFF0D0',sunPower:0.86,skyLight:'#FFF6E0',groundLight:'#A3B983',fill:1,fog:'#DCE6CC',windows:0}],
      [18,{zenith:'#7C97C9',horizon:'#F8C48C',sun:'#FFC47E',sunPower:0.74,skyLight:'#FFD9B4',groundLight:'#8E8E70',fill:0.88,fog:'#EBCBA6',windows:0.35}],
      [19.5,{zenith:'#3E4E80',horizon:'#C08A86',sun:'#D9A98E',sunPower:0.5,skyLight:'#B9A6BE',groundLight:'#5D5E60',fill:0.74,fog:'#8F7F8E',windows:0.9}],
      [21,{zenith:'#1E2C52',horizon:'#3E4F7C',sun:'#93ADE6',sunPower:0.44,skyLight:'#7A92CF',groundLight:'#33415A',fill:0.7,fog:'#3A4A6E',windows:1}],
      [24,{zenith:'#1E2C52',horizon:'#3E4F7C',sun:'#93ADE6',sunPower:0.44,skyLight:'#7A92CF',groundLight:'#33415A',fill:0.7,fog:'#3A4A6E',windows:1}],
    ];
    /** 시각에 맞는 분위기 값. 색은 선형 색공간에서 보간한다. @param {number} hour */
    function atmosphere(hour){
      const at=((hour%24)+24)%24;
      let index=0;while(index<keyframes.length-2&&keyframes[index+1][0]<=at)index++;
      const [h0,a]=keyframes[index],[h1,b]=keyframes[index+1],t=Math.min(1,Math.max(0,(at-h0)/(h1-h0)));
      /** @param {string} x @param {string} y */
      const mix=(x,y)=>color(x).lerp(color(y),t);
      return {zenith:mix(a.zenith,b.zenith),horizon:mix(a.horizon,b.horizon),sun:mix(a.sun,b.sun),sunPower:a.sunPower+(b.sunPower-a.sunPower)*t,
        skyLight:mix(a.skyLight,b.skyLight),groundLight:mix(a.groundLight,b.groundLight),fill:a.fill+(b.fill-a.fill)*t,fog:mix(a.fog,b.fog),windows:a.windows+(b.windows-a.windows)*t};
    }
    const clockHour=()=>{const now=new Date();return now.getHours()+now.getMinutes()/60;};
    let hour=Number.isFinite(options.hour)?Number(options.hour):clockHour();

    const scene=new THREE.Scene();scene.fog=new THREE.Fog(color('#DCE6CC'),22,64);
    // 좁은 시야각이 원근을 눌러 캐릭터가 통통해 보인다(벤치마크의 카메라도 좁다).
    const camera=new THREE.PerspectiveCamera(38,1,0.1,120);
    const anchor=terrain.toWorld(rules.fixture());
    const foot=terrain.heightAt(anchor.x,anchor.z);
    const hemisphere=new THREE.HemisphereLight(color('#FFF6E0'),color('#A3B983'),1);
    const sun=new THREE.DirectionalLight(color('#FFF0D0'),0.86);
    sun.position.set(anchor.x-9,17,anchor.z+7);sun.target.position.set(anchor.x,0,anchor.z);
    sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.radius=3;
    Object.assign(sun.shadow.camera,{left:-11,right:11,top:11,bottom:-11,near:1,far:44});
    sun.shadow.bias=-0.0003;sun.shadow.normalBias=0.03;
    scene.add(hemisphere,sun,sun.target);

    // ── 하늘 ─────────────────────────────────────────────────────────────────
    // 카메라 피치가 낮아 보이는 하늘은 지평선 위 0~8° 띠다. 세로 분할을 촘촘히 해 그 띠 안에서 색이 바뀌게 한다.
    const skyGeometry=geometry(new THREE.SphereGeometry(90,24,40,0,Math.PI*2,0,Math.PI*0.78));
    const skyMaterial=material(new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,depthWrite:false,fog:false}),{bend:false});
    const sky=new THREE.Mesh(skyGeometry,skyMaterial);sky.renderOrder=-1;scene.add(sky);
    // 별: 하늘 돔에 붙어 카메라를 따라간다. 밤에만 보인다.
    const starGeometry=geometry(new THREE.BufferGeometry());
    /** @type {number[]} */ const starPositions=[];
    // 화면에 보이는 하늘 띠는 수평선 아래 -18°~-8°다(위 주석). 별은 그 띠에 뿌린다.
    for(let i=0;i<220;i++){const yaw=(i*2.399963)%(Math.PI*2),pitch=-0.31+Math.pow(((i*7919)%1000)/1000,1.2)*0.19,r=86;starPositions.push(Math.cos(yaw)*Math.cos(pitch)*r,Math.sin(pitch)*r,Math.sin(yaw)*Math.cos(pitch)*r);}
    starGeometry.setAttribute('position',new THREE.Float32BufferAttribute(starPositions,3));
    const starMaterial=material(new THREE.PointsMaterial({color:color('#FFF8E0'),size:2.4,sizeAttenuation:false,transparent:true,opacity:0,depthWrite:false,fog:false}),{bend:false});
    const stars=new THREE.Points(starGeometry,starMaterial);stars.frustumCulled=false;stars.renderOrder=-1;sky.add(stars);
    // 달: 북쪽 하늘 낮은 곳. 별과 같은 투명도로 밤에만 떠오른다.
    const moonMaterial=material(new THREE.MeshBasicMaterial({color:color('#FFF4D2'),transparent:true,opacity:0,depthWrite:false,fog:false}),{bend:false});
    const moon=new THREE.Mesh(shop.shapes.sphere,moonMaterial);moon.scale.setScalar(2.2);moon.position.set(-14,-15,-83);moon.renderOrder=-1;sky.add(moon);
    /** 하늘 정점색을 시간대에 맞춰 다시 칠한다. @param {import('three').Color} zenith @param {import('three').Color} horizon */
    function paintSky(zenith,horizon){
      const position=skyGeometry.getAttribute('position');/** @type {number[]} */ const skyColors=[];
      for(let i=0;i<position.count;i++){
        // 카메라 피치 26.6°·시야각 38°라 화면 상단은 수평선 **아래** 7.6°다. 곡률로 땅이 사라지는
        // 시각적 지평선은 약 -18°. 그라디언트는 그 띠(-18°~-8°)에서 지평선색→천정색으로 바뀐다.
        const lifted=position.getY(i)/90+0.31;
        const t=Math.pow(Math.min(1,Math.max(0,lifted)*5.5),0.7);
        const tint=horizon.clone().lerp(zenith,t);skyColors.push(tint.r,tint.g,tint.b);
      }
      skyGeometry.setAttribute('color',new THREE.Float32BufferAttribute(skyColors,3));
    }

    // ── 지형 ─────────────────────────────────────────────────────────────────
    // 잔디 패턴: 한 타일(1단위)에 부드러운 삼각 잎 4개. 정점색이 큰 규모의 변화를 곱한다.
    const grassTexture=shop.painted(64,(context,size)=>{
      context.fillStyle='#A9C47F';context.fillRect(0,0,size,size);
      /** @param {number} x @param {number} y @param {number} r @param {string} fill */
      const leaf=(x,y,r,fill)=>{context.fillStyle=fill;context.beginPath();context.moveTo(x,y-r);context.quadraticCurveTo(x+r*0.95,y+r*0.6,x,y+r*0.75);context.quadraticCurveTo(x-r*0.95,y+r*0.6,x,y-r);context.fill();};
      for(const [x,y] of [[16,16],[48,16],[16,48],[48,48]])leaf(x,y+3,11,'#B1CB85');
      for(const [x,y] of [[32,32],[0,32],[64,32],[32,0],[32,64]])leaf(x,y+2,7,'#A2BE79');
      for(const [x,y] of [[8,38],[40,6],[56,44],[24,60]]){context.fillStyle='#BDD68F';context.beginPath();context.arc(x,y,1.4,0,Math.PI*2);context.fill();}
    });
    // 캔버스 색은 sRGB 값이다. 선형으로 읽으면 잔디가 크림색으로 바랜다.
    grassTexture.encoding=THREE.sRGBEncoding;grassTexture.wrapS=grassTexture.wrapT=THREE.RepeatWrapping;grassTexture.anisotropy=Math.min(8,view.capabilities.getMaxAnisotropy());
    const groundGeometry=geometry(new THREE.BufferGeometry());
    /** @type {number[]} */ const positions=[],colors=[],indices=[],uvs=[];
    for(let row=0;row<=rules.rows;row++)for(let col=0;col<=rules.cols;col++){
      const x=col-rules.cols/2,z=row-rules.rows/2;
      positions.push(x,terrain.heights[row*(rules.cols+1)+col],z);uvs.push(x*1.6,z*1.6);
      // 큰 규모의 완만한 밝기 변화만 남긴다. 예전 3색 얼룩은 노이즈로 보였다.
      const patch=0.93+0.07*Math.sin(x*0.21+0.5)*Math.cos(z*0.17-x*0.08);
      colors.push(patch,patch,patch*0.985);
      if(col<rules.cols&&row<rules.rows && !rules.water.some(r=>col*32>=r.x&&col*32<r.x+r.width&&row*32>=r.y&&row*32<r.y+r.height)){const a=row*(rules.cols+1)+col,b=a+1,c=a+rules.cols+1,d=c+1;indices.push(a,c,b,b,c,d);}
    }
    groundGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    groundGeometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    groundGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));groundGeometry.setIndex(indices);groundGeometry.computeVertexNormals();
    const ground=new THREE.Mesh(groundGeometry,material(new THREE.MeshLambertMaterial({map:grassTexture,vertexColors:true})));
    ground.name='terrain';ground.receiveShadow=true;scene.add(ground);

    // 울타리 밖: 경계 띠 + 지평선까지 이어지는 풀밭 + 언덕. 곡률이 지평선을 만든다.
    const meadowGeometry=geometry(new THREE.BufferGeometry());
    /** @type {number[]} */ const meadowPositions=[],meadowIndices=[],meadowUvs=[];
    const segments=72,innerX=rules.cols/2,innerZ=rules.rows/2,outer=75;
    for(let i=0;i<=segments;i++){
      const angle=i/segments*Math.PI*2,dx=Math.cos(angle),dz=Math.sin(angle);
      // 방향 벡터를 지도 사각형 경계에 붙인다. 안쪽 정점은 울타리 바로 밑, 바깥은 먼 원.
      const scale=1/Math.max(Math.abs(dx)/innerX,Math.abs(dz)/innerZ);
      const ix=dx*scale,iz=dz*scale;
      meadowPositions.push(ix,terrain.heightAt(Math.max(-innerX,Math.min(innerX,ix)),Math.max(-innerZ,Math.min(innerZ,iz)))-0.01,iz,dx*outer,-0.05,dz*outer);
      meadowUvs.push(ix*1.6,iz*1.6,dx*outer*1.6,dz*outer*1.6);
      if(i<segments){const base=i*2;meadowIndices.push(base,base+1,base+2,base+1,base+3,base+2);}
    }
    meadowGeometry.setAttribute('position',new THREE.Float32BufferAttribute(meadowPositions,3));
    meadowGeometry.setAttribute('uv',new THREE.Float32BufferAttribute(meadowUvs,2));
    meadowGeometry.setIndex(meadowIndices);meadowGeometry.computeVertexNormals();
    const meadow=new THREE.Mesh(meadowGeometry,material(new THREE.MeshLambertMaterial({map:grassTexture,color:color('#EEF3E2')})));
    meadow.receiveShadow=true;scene.add(meadow);
    const hillGeometry=geometry(new THREE.SphereGeometry(1,14,10));
    // 인스턴스 색은 재질 색과 **곱해진다**. 재질은 흰색으로 두고 색은 인스턴스에만 준다.
    const hills=new THREE.InstancedMesh(hillGeometry,lambert('#FFFFFF'),14);
    const transform=new THREE.Object3D();
    // 낮은 언덕. 곡률이 먼 것을 끌어내리므로 지평선 위로 살짝만 솟는다.
    [[0,-40,15,3.2],[-21,-36,12,2.6],[24,-35,13,2.8],[-38,-16,11,2.3],[40,-12,12,2.4],[-44,6,12,2.5],[46,8,11,2.2],
      [-32,28,10,2.1],[32,30,11,2.2],[8,38,13,2.6],[-12,42,11,2.2],[-50,-28,14,2.9],[52,-26,13,2.7],[0,-54,20,3.8]].forEach(([x,z,r,h],i)=>{
      transform.position.set(x,-0.4,z);transform.scale.set(r,h,r*0.85);transform.rotation.set(0,0,0);transform.updateMatrix();hills.setMatrixAt(i,transform.matrix);
      hills.setColorAt(i,color(i%3===0?'#8FB86E':i%3===1?'#9AC178':'#86AF67'));
    });
    hills.frustumCulled=false;scene.add(hills);
    // 울타리 바깥의 둥근 덤불. 지도 끝 뒤에 빈 풀밭만 보이지 않게 한다.
    const bushes=new THREE.InstancedMesh(hillGeometry,lambert('#FFFFFF'),34);
    for(let i=0;i<34;i++){
      const t=i/34,angle=t*Math.PI*2+0.13,dx=Math.cos(angle),dz=Math.sin(angle);
      const edge=1/Math.max(Math.abs(dx)/(rules.cols/2),Math.abs(dz)/(rules.rows/2)),gap=2.6+(i*29%17)/6;
      const size=0.65+(i*13%9)/12;
      transform.position.set(dx*(edge+gap),size*0.5,dz*(edge+gap));transform.scale.set(size*1.25,size,size*1.15);transform.rotation.set(0,0,0);transform.updateMatrix();bushes.setMatrixAt(i,transform.matrix);
      bushes.setColorAt(i,color(i%3===0?'#7FAF63':i%3===1?'#8CBA6C':'#74A45B'));
    }
    bushes.frustumCulled=false;bushes.castShadow=false;scene.add(bushes);

    // ── 나무 ─────────────────────────────────────────────────────────────────
    const trunkGeometry=geometry(new THREE.CylinderGeometry(0.13,0.2,1.15,8));
    const leafGeometry=geometry(new THREE.SphereGeometry(1,14,10).scale(1,0.86,1));
    const trunks=new THREE.InstancedMesh(trunkGeometry,lambert('#8F6B4E'),rules.trees.length);
    // 수관은 5개 잎덩이. 위가 밝고 아래가 어두워 부피가 생긴다. 바람은 vertex shader가 흔든다.
    const lobes=[[-0.34,1.5,0.06,0.6],[0.32,1.54,-0.1,0.6],[0.04,1.46,0.36,0.54],[-0.04,1.58,-0.34,0.54],[0.0,2.0,0.0,0.72]];
    const crowns=new THREE.InstancedMesh(leafGeometry,material(new THREE.MeshLambertMaterial({color:color('#FFFFFF')}),{sway:true}),rules.trees.length*lobes.length);
    rules.trees.forEach((tree,i)=>{
      const point=terrain.toWorld(tree),y=terrain.heightAt(point.x,point.z);
      transform.position.set(point.x,y+0.57,point.z);transform.scale.set(1,1,1);transform.rotation.set(0,0,0);transform.updateMatrix();trunks.setMatrixAt(i,transform.matrix);
      const variation=0.94+(i%4)*0.035,warm=(i%3)/2;
      for(const [part,[dx,dy,dz,radius]] of lobes.entries()){
        transform.position.set(point.x+dx,y+dy,point.z+dz);transform.scale.setScalar(radius*variation);transform.updateMatrix();
        crowns.setMatrixAt(i*lobes.length+part,transform.matrix);
        const base=part===4?color('#94C06E'):part<2?color('#79A85B'):color('#84B364');
        crowns.setColorAt(i*lobes.length+part,base.lerp(color('#A6C46A'),warm*0.25));
      }
    });
    // r128은 인스턴스별 경계를 계산하지 않는다. 고정 12그루는 전체를 제출한다.
    trunks.frustumCulled=false;crowns.frustumCulled=false;crowns.castShadow=true;trunks.castShadow=true;
    scene.add(trunks,crowns);

    // ── 구름 ─────────────────────────────────────────────────────────────────
    /** @type {import('three').Mesh[]} */ const clouds=[];
    const cloudMaterial=material(new THREE.MeshLambertMaterial({vertexColors:true,emissive:color('#FFFFFF'),emissiveIntensity:0.32,fog:false}));
    for(let i=0;i<7;i++){
      const cloud=new THREE.Mesh(shop.cloudGeometry(i),cloudMaterial);
      // 구름은 세계 좌표라 곡률로 함께 내려간다. 먼 곳의 낮은 높이가 화면의 하늘 띠에 들어온다.
      const angle=i/7*Math.PI*2+0.6,radius=30+(i*11%14);
      cloud.position.set(Math.cos(angle)*radius,3.2+(i*7%4)*0.7,Math.sin(angle)*radius-6);
      cloud.scale.setScalar(2.4+(i*5%4)*0.5);cloud.userData.speed=0.12+(i%3)*0.05;
      scene.add(cloud);clouds.push(cloud);
    }

    // ── 플레이어 ───────────────────────────────────────────────────────────────
    const player=new THREE.Group();player.name='player';player.position.set(anchor.x,foot,anchor.z);scene.add(player);
    const rig=shop.player(options.outfit===1?1:0);player.add(rig.group);
    const playerBlob=shop.blob(0.42);playerBlob.position.y=0.035;player.add(playerBlob);

    /** @type {Map<string,ReturnType<typeof shop.resident>>} */ const residents=new Map();
    /** @type {Map<string,import('three').Mesh>} */ const residentBlobs=new Map();
    /** @type {Map<string,number>} */ const travelled=new Map();
    /** @type {Map<string,import('three').Mesh>} */ const nodeMeshes=new Map();
    /** @type {Map<string,number>} */ const appeared=new Map();
    /** @type {Map<string,import('three').InstancedMesh>} */ const furniture=new Map();
    /** @type {import('three').Mesh[]} */ const ripples=[];

    /** 마스크 합집합의 셀을 한 번씩만 그려 겹친 면을 없앤다. @param {readonly RpgRect[]} masks @param {number} elevation @param {import('three').Material} surface @param {boolean} follow */
    function maskMesh(masks,elevation,surface,follow){
      const vertices=[],triangles=[],uv=[];
      for(let row=0;row<rules.rows;row++)for(let col=0;col<rules.cols;col++){
        if(!masks.some(r=>col*32>=r.x&&col*32<r.x+r.width&&row*32>=r.y&&row*32<r.y+r.height))continue;
        const base=vertices.length/3,x=col-16,z=row-12;
        for(const [dx,dz] of [[0,0],[1,0],[0,1],[1,1]]){vertices.push(x+dx,(follow?terrain.heightAt(x+dx,z+dz):0)+elevation,z+dz);uv.push((x+dx)*0.5,(z+dz)*0.5);}
        triangles.push(base,base+2,base+1,base+1,base+2,base+3);
      }
      const shape=geometry(new THREE.BufferGeometry());shape.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));shape.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));shape.setIndex(triangles);shape.computeVertexNormals();
      const mesh=new THREE.Mesh(shape,surface);mesh.receiveShadow=follow;scene.add(mesh);return mesh;
    }
    // 길: 잔디보다 밝고 따뜻한 흙. 자갈 몇 점을 찍어 평면이 아니게 한다.
    const pathTexture=shop.painted(64,(context,size)=>{
      context.fillStyle='#E4D3A6';context.fillRect(0,0,size,size);
      for(const [x,y,r] of [[10,12,3],[40,8,2.4],[54,30,3.2],[22,40,2.2],[46,52,2.8],[6,56,2.4],[30,24,1.8]]){context.fillStyle='#D9C598';context.beginPath();context.arc(x,y,r,0,Math.PI*2);context.fill();}
      for(const [x,y] of [[18,26],[50,42],[34,58]]){context.fillStyle='#EEDFB6';context.beginPath();context.arc(x,y,1.4,0,Math.PI*2);context.fill();}
    });
    pathTexture.encoding=THREE.sRGBEncoding;pathTexture.wrapS=pathTexture.wrapT=THREE.RepeatWrapping;
    maskMesh(rules.paths,0.012,material(new THREE.MeshLambertMaterial({map:pathTexture})),true).name='paths';
    maskMesh(rules.water,-0.2,lambert('#5F8E86'),false).name='pond-floor';
    // 물: 밝은 얼룩 텍스처를 천천히 흘려 잔물결을 낸다.
    const waterTexture=shop.painted(64,(context,size)=>{
      context.fillStyle='#8CCBC6';context.fillRect(0,0,size,size);
      for(const [x,y,rx,ry] of [[14,12,9,4],[44,20,11,4.5],[26,38,8,3.5],[52,50,10,4],[8,54,7,3]]){
        const glow=context.createRadialGradient(x,y,0,x,y,rx);glow.addColorStop(0,'rgba(232,247,244,0.9)');glow.addColorStop(1,'rgba(232,247,244,0)');
        context.save();context.translate(x,y);context.scale(1,ry/rx);context.translate(-x,-y);context.fillStyle=glow;context.beginPath();context.arc(x,y,rx,0,Math.PI*2);context.fill();context.restore();
      }
    });
    waterTexture.encoding=THREE.sRGBEncoding;waterTexture.wrapS=waterTexture.wrapT=THREE.RepeatWrapping;
    const waterMaterial=material(new THREE.MeshLambertMaterial({map:waterTexture,color:color('#EAF7F3'),opacity:0.8,transparent:true,depthWrite:false}));
    maskMesh(rules.water,-0.08,waterMaterial,false).name='water';
    // 물 셀의 외곽 간선만 둑으로 세워 시각 경계와 충돌 마스크를 일치시킨다.
    const bankVertices=[],bankIndices=[];
    const wet=(/** @type {number} */ x,/** @type {number} */ y)=>rules.water.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
    for(const r of rules.water)for(let u=r.x;u<r.x+r.width;u+=32){
      const x=u/32-16,z=r.y/32-12;
      for(const [dx,dz,ax,az,bx,bz] of [[0,-1,0,0,1,0],[0,1,1,1,0,1],[-1,0,0,1,0,0],[1,0,1,0,1,1]]){
        if(wet(u+16+dx*32,r.y+16+dz*32))continue;
        const base=bankVertices.length/3;
        bankVertices.push(x+ax,0,z+az,x+bx,0,z+bz,x+ax,-0.2,z+az,x+bx,-0.2,z+bz);
        bankIndices.push(base,base+1,base+2,base+1,base+3,base+2);
      }
    }
    const bankShape=geometry(new THREE.BufferGeometry());bankShape.setAttribute('position',new THREE.Float32BufferAttribute(bankVertices,3));bankShape.setIndex(bankIndices);bankShape.computeVertexNormals();
    scene.add(new THREE.Mesh(bankShape,material(new THREE.MeshLambertMaterial({color:color('#DCCB9F'),side:THREE.DoubleSide}))));

    // ── 집 ───────────────────────────────────────────────────────────────────
    const h=rules.house,home=terrain.toWorld({x:h.x+h.width/2,y:h.y+h.height/2});
    const wall=new THREE.Mesh(geometry(new THREE.BoxGeometry(h.width/32,1.7,h.height/32)),lambert('#EFDFB8'));wall.position.set(home.x,0.85,home.z);wall.castShadow=wall.receiveShadow=true;scene.add(wall);
    const roofShape=new THREE.Shape();roofShape.moveTo(-2.15,-0.05);roofShape.lineTo(0,1.25);roofShape.lineTo(2.15,-0.05);roofShape.closePath();
    const roof=new THREE.Mesh(geometry(new THREE.ExtrudeGeometry(roofShape,{depth:2.2,bevelEnabled:false})),lambert('#B37A5C'));roof.position.set(home.x,1.7,home.z-1.1);roof.castShadow=true;scene.add(roof);
    const door=new THREE.Mesh(geometry(new THREE.BoxGeometry(0.62,1.05,0.05)),lambert('#8F6B4E'));door.position.set(home.x,0.525,home.z+1.02);scene.add(door);
    const knob=new THREE.Mesh(shop.shapes.ball,lambert('#E9C25B'));knob.scale.setScalar(0.035);knob.position.set(home.x+0.2,0.55,home.z+1.05);scene.add(knob);
    // 창문은 밤에 켜진다. 정점색 없이 emissive만 시간대가 조절한다.
    const windowMaterial=material(new THREE.MeshLambertMaterial({color:color('#B9D9E6'),emissive:color('#FFD98A'),emissiveIntensity:0}));
    for(const dx of [-1.1,1.1]){const pane=new THREE.Mesh(geometry(new THREE.BoxGeometry(0.5,0.45,0.05)),windowMaterial);pane.position.set(home.x+dx,1.05,home.z+1.02);scene.add(pane);
      const sill=new THREE.Mesh(geometry(new THREE.BoxGeometry(0.58,0.05,0.1)),lambert('#8F6B4E'));sill.position.set(home.x+dx,0.8,home.z+1.04);scene.add(sill);}

    // ── 울타리·작업대·물결 ─────────────────────────────────────────────────────
    // 지도 끝의 빈 배경을 막는 울타리(설계서 §5). 논리 경계 벽과 같은 자리이므로 통행은 바뀌지 않는다.
    const box=shop.shapes.box;
    const fencePosts=[];
    for(let x=-16;x<=16;x+=2)for(const z of [-12,12])fencePosts.push([x,z]);
    for(let z=-10;z<=10;z+=2)for(const x of [-16,16])fencePosts.push([x,z]);
    const posts=new THREE.InstancedMesh(geometry(new THREE.BoxGeometry(0.1,0.56,0.1)),lambert('#B39470'),fencePosts.length);
    fencePosts.forEach(([x,z],i)=>{
      transform.position.set(x,terrain.heightAt(x,z)+0.22,z);transform.rotation.set(0,0,0);transform.scale.set(1,1,1);transform.updateMatrix();posts.setMatrixAt(i,transform.matrix);
    });
    posts.frustumCulled=false;posts.receiveShadow=true;scene.add(posts);
    const rails=[];
    for(const height of [0.26,0.44]){
      for(const z of [-12,12])rails.push({shape:box,hex:'#C2A47A',position:[0,height,z],scale:[32.1,0.05,0.06]});
      for(const x of [-16,16])rails.push({shape:box,hex:'#C2A47A',position:[x,height,0],scale:[0.06,0.05,24.1]});
    }
    const fence=new THREE.Mesh(shop.merge(rails),shop.materials.lambert);fence.receiveShadow=true;scene.add(fence);
    for(const site of rules.sites){
      if(site.kind!=='workbench')continue;
      const point=terrain.toWorld(site);
      const mesh=new THREE.Mesh(shop.furnitureGeometry('workbench'),shop.materials.lambert);
      mesh.position.set(point.x,terrain.heightAt(point.x,point.z),point.z);mesh.castShadow=true;scene.add(mesh);
    }
    // 낚시점 물결은 물리·획득 판정과 독립인 표현이다.
    for(const site of rules.sites.filter(s=>s.kind==='fishing')){
      const point=terrain.toWorld(site);
      const ripple=shop.marker('#E3F4F0');ripple.position.set(point.x+0.7,-0.07,point.z);ripple.scale.setScalar(0.4);
      scene.add(ripple);ripples.push(ripple);
    }
    for(const definition of BackyardRpgLife.residents){
      const model=shop.resident(definition.shape);model.group.visible=false;scene.add(model.group);residents.set(definition.id,model);
      const shade=shop.blob(definition.shape==='bear'?0.5:0.38);shade.position.y=0.035;model.group.add(shade);residentBlobs.set(definition.id,shade);
    }
    for(const node of BackyardRpgLife.nodes){
      const mesh=new THREE.Mesh(shop.speciesGeometry(node.species),shop.materials.lambert);
      mesh.castShadow=true;mesh.visible=false;scene.add(mesh);nodeMeshes.set(node.id,mesh);
    }
    // 48개까지 한 종류당 InstancedMesh 하나로 제출한다. 드로우콜은 개수와 무관하다.
    for(const kind of ['pot','well','chair']){
      const mesh=new THREE.InstancedMesh(shop.furnitureGeometry(kind),shop.materials.lambert,48);
      mesh.castShadow=true;mesh.receiveShadow=true;mesh.count=0;mesh.frustumCulled=false;scene.add(mesh);furniture.set(kind,mesh);
    }
    const berries=new THREE.InstancedMesh(shop.berryGeometry(),shop.materials.lambert,48);
    berries.castShadow=true;berries.count=0;berries.frustumCulled=false;scene.add(berries);
    const rod=shop.tool('rod'),net=shop.tool('net');rod.visible=net.visible=false;
    // 도구는 오른팔 관절에 붙는다. 같은 관절의 짧은 포즈로 이어진다(설계서 §6).
    rig.hand.add(rod);rig.hand.add(net);
    rod.position.set(0.05,-0.16,0.06);net.position.set(0.05,-0.16,0.06);
    rod.rotation.x=net.rotation.x=1.1;
    const bobber=shop.bobber();bobber.visible=false;scene.add(bobber);
    // 낚싯줄: 낚싯대 끝에서 찌까지. 두 점만 매 프레임 갱신한다.
    const lineGeometry=geometry(new THREE.BufferGeometry());lineGeometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(6),3));
    const fishingLine=new THREE.Line(lineGeometry,material(new THREE.LineBasicMaterial({color:color('#FFFFFF'),transparent:true,opacity:0.85})));
    fishingLine.frustumCulled=false;fishingLine.visible=false;scene.add(fishingLine);
    const fishingSites=rules.sites.filter(s=>s.kind==='fishing').map(s=>terrain.toWorld(s));
    const rodTip=new THREE.Vector3();
    const biteRing=shop.marker('#FFFFFF');biteRing.visible=false;scene.add(biteRing);
    const ghost=new THREE.Mesh(shop.furnitureGeometry('pot'),material(new THREE.MeshLambertMaterial({vertexColors:true,transparent:true,opacity:0.45,depthWrite:false})));
    ghost.visible=false;scene.add(ghost);
    const marker=shop.marker('#53744B');marker.visible=false;marker.scale.setScalar(0.5);scene.add(marker);
    const burst=shop.sparkles(26,'#FFF1B8');scene.add(burst);
    /** @type {{start:number,origin:import('three').Vector3,velocity:number[]}|null} */ let burstState=null;

    // ── 도감 ─────────────────────────────────────────────────────────────────
    // 도감은 세계 렌더를 멈추고 **같은 renderer의 scissor 영역**으로 표본만 그린다.
    const albumScene=new THREE.Scene();
    const albumCamera=new THREE.PerspectiveCamera(30,1,0.1,10);
    albumCamera.position.set(0.32,0.42,0.95);albumCamera.lookAt(0,0.15,0);
    albumScene.add(new THREE.HemisphereLight(color('#FFF6DF'),color('#B7A788'),0.85));
    const albumSun=new THREE.DirectionalLight(color('#FFF0D0'),0.75);albumSun.position.set(-1.4,2.2,1.6);albumScene.add(albumSun);
    const albumMesh=new THREE.Mesh(geometry(new THREE.BufferGeometry()),shop.materials.lambert);
    albumScene.add(albumMesh);
    const silhouette=material(new THREE.MeshBasicMaterial({color:color('#B9BFA6')}));
    const albumBackground=color('#FFF6DF');

    // ── 상태 ─────────────────────────────────────────────────────────────────
    const crownMatrices=Array.from({length:rules.trees.length*lobes.length},(_,i)=>{const matrix=new THREE.Matrix4();crowns.getMatrixAt(i,matrix);return matrix;});
    const crownScales=rules.trees.map(()=>1),ray=new THREE.Raycaster();
    const follow=new THREE.Vector3(anchor.x,foot,anchor.z);
    const gaze=new THREE.Vector3(anchor.x,foot+0.7,anchor.z-0.6);
    let zoom=0,elapsed=0,lastAtmosphere=-1,firstContent=true;
    let previousCard=false,previousPhase='idle';
    /** 논리 px 위치를 접지된 3D 좌표로 바꾼다. @param {{x:number,y:number}} point */
    function ground3d(point){const world=terrain.toWorld(point);return {x:world.x,y:terrain.heightAt(world.x,world.z),z:world.z};}

    /** 시간대를 조명·하늘·안개·창문에 적용한다. @param {number} at */
    function applyAtmosphere(at){
      const a=atmosphere(at);
      hemisphere.color.copy(a.skyLight);hemisphere.groundColor.copy(a.groundLight);hemisphere.intensity=a.fill;
      sun.color.copy(a.sun);sun.intensity=a.sunPower;
      if(scene.fog instanceof THREE.Fog)scene.fog.color.copy(a.fog);
      scene.background=a.horizon.clone();
      paintSky(a.zenith,a.horizon);
      windowMaterial.emissiveIntensity=a.windows*0.9;
      starMaterial.opacity=moonMaterial.opacity=Math.min(1,Math.max(0,(0.6-a.sunPower)/0.16));
      cloudMaterial.emissiveIntensity=0.1+0.25*Math.min(1,a.sunPower);
      view.shadowMap.needsUpdate=true;
      host.dataset.hour=at.toFixed(2);
    }

    /** 반짝이 터짐을 시작한다. @param {import('three').Vector3} origin */
    function sparkle(origin){
      const velocity=[];
      for(let i=0;i<26;i++){const angle=i/26*Math.PI*2+(i%3)*0.4,speed=0.9+(i*7%5)*0.25;velocity.push(Math.cos(angle)*speed,1.6+(i*11%6)*0.3,Math.sin(angle)*speed);}
      burstState={start:elapsed,origin:origin.clone(),velocity};burst.visible=true;
    }
    /** 터짐의 입자 위치·투명도를 진행한다. */
    function advanceBurst(){
      if(!burstState)return;
      const t=(elapsed-burstState.start)/1000;
      if(t>0.9){burstState=null;burst.visible=false;return;}
      const attribute=/** @type {import('three').BufferAttribute} */(burst.geometry.getAttribute('position'));
      for(let i=0;i<attribute.count;i++){
        const v=burstState.velocity;
        attribute.setXYZ(i,burstState.origin.x+v[i*3]*t,burstState.origin.y+0.3+v[i*3+1]*t-2.6*t*t,burstState.origin.z+v[i*3+2]*t);
      }
      attribute.needsUpdate=true;
      const surface=/** @type {import('three').PointsMaterial} */(burst.material);
      surface.opacity=Math.max(0,1-t/0.9);surface.size=0.22*(1-t*0.5);
    }

    /**
     * 콘텐츠 스냅샷을 장면에 반영한다. 규칙이 계산한 것만 그린다.
     * @param {ReturnType<ReturnType<typeof BackyardRpg3dWorld.create>['snapshot']>} state @param {number} delta
     * @param {{talkingId?:string|null,talking?:boolean}} [extra]
     */
    function content(state,delta,extra={}){
      elapsed+=Math.min(100,Math.max(0,delta));sway.value=elapsed;
      for(const [id,model] of residents){
        const actor=state.actors.find(a=>a.id===id);
        if(!actor){model.group.visible=false;continue;}
        const point=ground3d(actor);
        const fresh=!model.group.visible;
        model.group.visible=true;model.group.position.set(point.x,point.y,point.z);
        shop.face(model,Math.PI/2-actor.direction*Math.PI/4,delta,fresh);
        // 24px/s로 걷는 실제 이동거리로 위상을 진행한다. 누적 거리가 이 프레임에
        // 늘어나지 않았으면 쉬는 중이거나 길이 막힌 것이므로 발도 멈춘다.
        const moved=actor.distance>(travelled.get(id)??0);travelled.set(id,actor.distance);
        shop.animate(model,actor.distance,moved,delta,{sitting:actor.sitting,talking:extra.talking===true&&extra.talkingId===id});
      }
      for(const [id,mesh] of nodeMeshes){
        const node=state.nodes.find(n=>n.id===id);
        if(!node||!node.visible){mesh.visible=false;appeared.delete(id);continue;}
        const point=ground3d(node);
        // 처음 나타나는 표본은 튀어오르며 등장한다. 첫 프레임의 일괄 등장은 제외한다.
        if(!mesh.visible)appeared.set(id,firstContent?-Infinity:elapsed);
        mesh.visible=true;
        const age=(elapsed-(appeared.get(id)??-Infinity))/350,pop=age>=1?1:(1-Math.pow(1-age,3))*(1+0.22*Math.sin(age*Math.PI));
        // 벌레는 잎 위에서 작게 떠 있고 바닥 채집물은 접지한다(2D의 같은 구분).
        const flying=node.species>=4;
        mesh.position.set(point.x,point.y+(flying?0.22+Math.sin(elapsed/700+node.species)*0.03:0),point.z);
        mesh.scale.setScalar((flying?0.85:1)*pop);
        if(flying)mesh.rotation.y=Math.sin(elapsed/900+node.species*2)*0.6;
      }
      firstContent=false;
      /** @type {Record<string,number>} */ const counts={pot:0,well:0,chair:0};
      let berryCount=0;
      for(const item of state.decorations){
        const mesh=furniture.get(item.kind);if(!mesh)continue;
        const point=ground3d({x:item.col*32+16,y:item.row*32+16});
        transform.position.set(point.x,point.y,point.z);transform.rotation.set(0,0,0);transform.scale.set(1,1,1);transform.updateMatrix();
        mesh.setMatrixAt(counts[item.kind]++,transform.matrix);
        if(item.kind==='pot'&&item.ready){berries.setMatrixAt(berryCount++,transform.matrix);}
      }
      for(const [kind,mesh] of furniture){mesh.count=counts[kind];mesh.instanceMatrix.needsUpdate=true;}
      berries.count=berryCount;berries.instanceMatrix.needsUpdate=true;
      // 익은 화분에만 열매가 달린다. 검증이 화분 시각을 규칙과 대조할 수 있게 노출한다.
      host?.setAttribute('data-furniture',counts.pot+','+counts.well+','+counts.chair);
      host?.setAttribute('data-berries',String(berryCount));
      const spot=state.ghost;
      ghost.visible=marker.visible=!!spot;
      if(spot){
        const point=ground3d({x:spot.col*32+16,y:spot.row*32+16});
        ghost.geometry=shop.furnitureGeometry(spot.kind);
        ghost.position.set(point.x,point.y,point.z);
        marker.position.set(point.x,point.y+0.02,point.z);
        // 색만으로 알리지 않는다. 거절 이유 문구는 HUD가 함께 띄운다(설계서 §7).
        const surface=/** @type {import('three').MeshBasicMaterial} */(marker.material);
        surface.color.copy(color(spot.reason?'#B46555':'#53744B'));
      }
      rod.visible=state.fishing.phase!=='idle';
      net.visible=!!state.gathering;
      // 찌: 낚시점에서 물 쪽으로 1.3단위 들어간 수면(낚시점은 둑 위에 있다). 기다릴 땐 살짝
      // 흔들리고, 입질에 잠기고, 끌어올릴 땐 튀어오른다. 획득 판정은 규칙이 하고 이것은 표현이다.
      const phase=state.fishing.phase;
      bobber.visible=fishingLine.visible=phase!=='idle';
      if(bobber.visible){
        const site=state.fishing.phase!=='idle'?fishingSites[state.fishing.spot]??fishingSites[0]:fishingSites[0];
        bobber.position.set(site.x+0.95,-0.07,site.z);
        if(phase==='waiting')bobber.position.y=-0.07+Math.sin(elapsed/450)*0.012;
        if(phase==='bite')bobber.position.y=-0.22+Math.abs(Math.sin(elapsed/60))*0.05;
        if(phase==='pulling')bobber.position.y=0.25+Math.sin(elapsed/80)*0.04;
        if(phase==='bite'&&previousPhase!=='bite'){biteRing.visible=true;biteRing.userData.start=elapsed;}
        scene.updateMatrixWorld(true);
        rod.localToWorld(rodTip.set(0,0.78,0.5));
        const points=/** @type {import('three').BufferAttribute} */(lineGeometry.getAttribute('position'));
        points.setXYZ(0,rodTip.x,rodTip.y,rodTip.z);points.setXYZ(1,bobber.position.x,bobber.position.y+0.14,bobber.position.z);points.needsUpdate=true;
      }
      if(biteRing.visible){
        const t=(elapsed-(biteRing.userData.start??elapsed))/700;
        if(t>1||phase==='idle')biteRing.visible=false;
        else {biteRing.position.set(bobber.position.x,-0.06,bobber.position.z);biteRing.scale.setScalar(0.15+t*0.7);/** @type {import('three').MeshBasicMaterial} */(biteRing.material).opacity=0.8*(1-t);}
      }
      previousPhase=phase;
      // 획득 카드가 새로 뜨면 플레이어 정면에서 반짝인다.
      if(state.card&&!previousCard){
        const yaw=rig.motion.yaw??player.rotation.y;
        sparkle(new THREE.Vector3(player.position.x+Math.sin(yaw)*0.6,player.position.y,player.position.z+Math.cos(yaw)*0.6));
      }
      previousCard=!!state.card;
      advanceBurst();
      for(const [index,ripple] of ripples.entries()){
        const cycle=(elapsed/1000+index*1.3)%4;
        ripple.scale.setScalar(0.3+cycle*0.16);
        /** @type {import('three').MeshBasicMaterial} */(ripple.material).opacity=Math.max(0,0.6-cycle*0.15);
      }
      waterTexture.offset.set(elapsed*0.000012,elapsed*0.000019);
      for(const cloud of clouds){cloud.position.x+=cloud.userData.speed*Math.min(100,delta)/1000;if(cloud.position.x>70)cloud.position.x=-70;}
      // 시간대는 1분마다 다시 읽는다. 미리보기가 시각을 고정하면 그대로 둔다.
      if(!Number.isFinite(options.hour)&&elapsed-lastAtmosphere>60000){lastAtmosphere=elapsed;hour=clockHour();applyAtmosphere(hour);}
    }
    /**
     * 고정 방위각으로 추종하고 수관 가림만 줄인다. 대화 중에는 주민 쪽으로 다가간다.
     * @param {{x:number,y:number,z:number}} point @param {number} direction @param {number} delta
     * @param {boolean} [snap] @param {{distance?:number,moving?:boolean,sitting?:boolean,reaching?:boolean,focusId?:string|null,talking?:boolean,fishing?:boolean}} [pose] */
    function update(point,direction,delta,snap=false,pose={}){
      player.position.set(point.x,point.y,point.z);
      shop.face(rig,Math.PI/2-direction*Math.PI/4,delta,snap);
      shop.animate(rig,pose.distance??0,pose.moving===true,delta,{sitting:pose.sitting,reaching:pose.reaching});
      const blend=snap?1:1-Math.exp(-Math.min(100,Math.max(0,delta))/150);
      const focus=pose.focusId?residents.get(pose.focusId):null;
      const focused=focus&&focus.group.visible?focus.group.position:null;
      zoom+=((focused?1:0)-zoom)*(snap?1:1-Math.exp(-Math.min(100,Math.max(0,delta))/260));
      // 세로 화면은 가로 시야가 좁다. 다가가는 정도와 옆으로 비키는 거리를 시야 반폭에 비례시킨다.
      const portrait=Math.min(1,camera.aspect),halfWidth=Math.tan(camera.fov/2*Math.PI/180)*7*camera.aspect;
      // 대화 중에는 두 사람의 중간에서 오른쪽(+x)으로 비켜 선다 — 화면 오른쪽에 선택지가 뜬다.
      let targetX=focused?(point.x+focused.x)/2+halfWidth*0.36*zoom:point.x,targetZ=focused?(point.z+focused.z)/2:point.z;
      // 낚시 중에는 찌 쪽으로 시선을 나눈다. 찌가 화면 밖이면 입질을 볼 수 없다.
      if(pose.fishing&&bobber.visible){targetX=point.x+(bobber.position.x-point.x)*0.5;targetZ=point.z+(bobber.position.z-point.z)*0.35;}
      follow.lerp(new THREE.Vector3(Math.max(-15,Math.min(15,targetX)),point.y,Math.max(-11,Math.min(11,targetZ))),blend);
      // 기본 카메라는 뒤로 10·위로 6.4(약 33°). 대화 중에는 다가가며 시야각을 좁힌다(세로는 덜 다가간다).
      const back=10-(2.6+1.4*portrait)*zoom,up=6.4-(1.8+1*portrait)*zoom;
      camera.position.set(follow.x,follow.y+up,follow.z+back);
      gaze.set(follow.x,follow.y+0.95+0.1*zoom,follow.z-0.9+0.6*zoom);camera.lookAt(gaze);
      const fov=38-4*zoom;if(Math.abs(camera.fov-fov)>0.01){camera.fov=fov;camera.updateProjectionMatrix();}
      sky.position.copy(camera.position);
      scene.updateMatrixWorld(true);
      const sight=new THREE.Vector3(point.x,point.y+0.9,point.z).sub(camera.position);ray.set(camera.position,sight.clone().normalize());ray.far=sight.length();
      // 원래 수관으로 판정해 축소된 순간 가림 해제/재진입이 반복되지 않게 한다.
      crownMatrices.forEach((matrix,i)=>crowns.setMatrixAt(i,matrix));crowns.instanceMatrix.needsUpdate=true;
      const hidden=new Set(ray.intersectObject(crowns).map(hit=>Math.floor((hit.instanceId??-lobes.length)/lobes.length)));
      crownScales.forEach((scale,i)=>{crownScales[i]=scale+((hidden.has(i)?0.08:1)-scale)*blend;});
      crownMatrices.forEach((matrix,i)=>{const next=matrix.clone();next.scale(new THREE.Vector3().setScalar(crownScales[Math.floor(i/lobes.length)]));crowns.setMatrixAt(i,next);});crowns.instanceMatrix.needsUpdate=true;
      const texel=22/1024,shadowX=Math.round(follow.x/texel)*texel,shadowZ=Math.round(follow.z/texel)*texel;
      sun.position.set(shadowX-9,17,shadowZ+7);sun.target.position.set(shadowX,0,shadowZ);view.shadowMap.needsUpdate=true;
    }

    /** 정적 장면은 변경 시에만 렌더링한다. 첫 프레임은 shader 컴파일을 포함한다. */
    function render(){
      if(disposed)return;view.info.reset();view.autoClear=true;view.setScissorTest(false);
      const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);view.setViewport(0,0,width,height);
      const start=performance.now();view.render(scene,camera);if(sun.shadow.map instanceof THREE.WebGLRenderTarget)targets.add(sun.shadow.map);
      host?.setAttribute('data-render-cpu-ms',(performance.now()-start).toFixed(2));
      host?.setAttribute('data-calls',String(view.info.render.calls));host?.setAttribute('data-triangles',String(view.info.render.triangles));
      host?.setAttribute('data-points',String(view.info.render.points));
    }
    /**
     * 보이는 도감 카드의 표본만 같은 renderer의 scissor로 그린다.
     * **카드마다 WebGL context를 만들지 않는다**(설계서 §6). 스크롤 영역과 교차한
     * 부분만 그려 패널 밖으로 표본이 새지 않는다.
     * @param {readonly {index:number,found:boolean,left:number,top:number,width:number,height:number}[]} cards
     * @param {{left:number,top:number,width:number,height:number}|null} clip
     */
    function specimens(cards,clip){
      if(disposed)return;
      const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);
      view.info.reset();view.autoClear=false;view.setScissorTest(false);
      view.setViewport(0,0,width,height);view.setClearColor(albumBackground,1);view.clear();
      for(const card of cards){
        const left=Math.max(card.left,clip?clip.left:0),right=Math.min(card.left+card.width,clip?clip.left+clip.width:width);
        const top=Math.max(card.top,clip?clip.top:0),bottom=Math.min(card.top+card.height,clip?clip.top+clip.height:height);
        if(right-left<1||bottom-top<1)continue;
        view.setViewport(card.left,height-(card.top+card.height),card.width,card.height);
        view.setScissor(left,height-bottom,right-left,bottom-top);view.setScissorTest(true);
        albumMesh.geometry=shop.speciesGeometry(card.index);
        albumScene.overrideMaterial=card.found?null:silhouette;
        albumCamera.aspect=card.width/card.height;albumCamera.updateProjectionMatrix();
        view.render(albumScene,albumCamera);
      }
      view.setScissorTest(false);view.autoClear=true;
      host?.setAttribute('data-album-calls',String(view.info.render.calls));
      host?.setAttribute('data-album-cards',String(cards.length));
    }
    /** 회전 시 수직 시야를 유지하고 내부 해상도 예산을 적용한다. */
    function resize(){
      if(disposed||!host)return;const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);
      view.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5,Math.sqrt(1500000/(width*height))));
      view.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();view.shadowMap.needsUpdate=true;render();
      const top=new THREE.Vector3(anchor.x,foot+1.35,anchor.z).project(camera),bottom=new THREE.Vector3(anchor.x,foot,anchor.z).project(camera);
      host.dataset.characterHeightPercent=((top.y-bottom.y)/2*100).toFixed(2);
      host.dataset.characterCenterPercent=((1-(top.y+bottom.y)/2)/2*100).toFixed(2);
    }
    /** 미리보기·검증이 시간대를 바꿔 볼 수 있다. @param {number} at */
    function setHour(at){if(Number.isFinite(at)){hour=at;options.hour=at;applyAtmosphere(at);render();}}

    window.addEventListener('resize',resize,{signal:listeners.signal});
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();cancelAnimationFrame(frame);fail(Error('3D 연결이 끊겼습니다. 다시 열어 주세요'));},{signal:listeners.signal});
    canvas.addEventListener('webglcontextrestored',()=>{if(disposed)return;resize();host.dataset.ready='true';},{signal:listeners.signal});
    applyAtmosphere(hour);lastAtmosphere=0;
    update({x:anchor.x,y:foot,z:anchor.z},rules.fixture().direction,0,true);
    resize();
    // GPU 완료 시간이 아니라 최초 제출 후 다음 RAF까지의 경과 시간이다.
    host.dataset.firstSubmitMs=performance.now().toFixed(2);
    host.dataset.treeCount=String(trunks.count);host.dataset.terrainVertices=String(groundGeometry.getAttribute('position').count);
    host.dataset.anchor=JSON.stringify({logical:rules.fixture(),world:{...anchor,y:foot}});
    host.dataset.ready='true';
    return {dispose,resize,update,render,content,specimens,setHour};
  }catch(error){dispose();fail(error);return null;}
}
};
