// @ts-check
/// <reference path="../../../types/three-r128.d.ts" />
/// <reference path="rpg-rules.js" />
/// <reference path="rpg3d-terrain.js" />
/// <reference path="rpg3d-models.js" />
/// <reference path="rpg3d-world.js" />
/** 고정 fixture와 걷기 화면이 공유하는 r128 장면. */
var BackyardRpg3dScene = {
/** 장면 자원의 소유권을 호출자에게 돌려준다.
 * @param {HTMLElement} host @param {HTMLCanvasElement} canvas
 * @param {{walking?:boolean,outfit?:number,onError:(error:unknown)=>void}} options */
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
    if(options.walking&&typeof BackyardRpg3dModels==='undefined')throw Error('마당 모델을 불러오지 못했습니다');
    const rules=BackyardRpgRules,terrain=BackyardRpg3dTerrain;
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
    const view=renderer;
    view.outputEncoding=THREE.sRGBEncoding;view.toneMapping=THREE.NoToneMapping;
    view.shadowMap.enabled=true;view.shadowMap.type=THREE.PCFSoftShadowMap;
    view.shadowMap.autoUpdate=false;view.info.autoReset=false;
    /** 팔레트 sRGB 값을 r128의 선형 작업 색공간으로 변환한다. @param {string} hex */
    const color=hex=>new THREE.Color(hex).convertSRGBToLinear();
    /** geometry 해제 소유권을 등록한다. @template {import('three').BufferGeometry} T @param {T} geometry @returns {T} */
    function geometry(geometry){geometries.add(geometry);return geometry;}
    /** material 해제 소유권을 등록한다. @template {import('three').Material} T @param {T} material @returns {T} */
    function material(material){materials.add(material);return material;}
    /** @param {string} hex */
    const lambert=hex=>material(new THREE.MeshLambertMaterial({color:color(hex)}));
    const scene=new THREE.Scene();scene.background=new THREE.Color('#E7EAD0');scene.fog=new THREE.Fog(color('#DCE4C8'),25,55);
    const camera=new THREE.PerspectiveCamera(45,1,0.1,80);
    // 필수 통행점 중 나무 옆 지점을 사용한다. 나무·지도 좌표는 복제하지 않는다.
    const anchor=terrain.toWorld(options.walking?rules.fixture():rules.required[2]);
    const foot=terrain.heightAt(anchor.x,anchor.z);
    camera.position.set(anchor.x,foot+6.4,anchor.z+8);
    camera.lookAt(anchor.x,foot+0.65,anchor.z-1.1);
    const hemisphere=new THREE.HemisphereLight(color('#FFF2D4'),color('#779067'),0.75);
    const sun=new THREE.DirectionalLight(color('#FFF0D0'),0.9);
    sun.position.set(anchor.x-10,16,anchor.z+8);sun.target.position.set(anchor.x,0,anchor.z);
    sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);
    Object.assign(sun.shadow.camera,{left:-10,right:10,top:10,bottom:-10,near:1,far:40});
    sun.shadow.bias=-0.0002;sun.shadow.normalBias=0.02;
    scene.add(hemisphere,sun,sun.target);

    const groundGeometry=geometry(new THREE.BufferGeometry());
    /** @type {number[]} */ const positions=[],colors=[],indices=[];
    const grass=['#A9BF83','#B7CB91','#97B575'].map(color);
    for(let row=0;row<=rules.rows;row++)for(let col=0;col<=rules.cols;col++){
      const x=col-rules.cols/2,z=row-rules.rows/2;
      positions.push(x,terrain.heights[row*(rules.cols+1)+col],z);
      const patch=Math.sin(x*0.36+0.5)+Math.cos(z*0.42-x*0.12);
      const tint=grass[patch < -0.45?2:patch>0.55?1:0];colors.push(tint.r,tint.g,tint.b);
      if(col<rules.cols&&row<rules.rows && !(options.walking && rules.water.some(r=>col*32>=r.x&&col*32<r.x+r.width&&row*32>=r.y&&row*32<r.y+r.height))){const a=row*(rules.cols+1)+col,b=a+1,c=a+rules.cols+1,d=c+1;indices.push(a,c,b,b,c,d);}
    }
    groundGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    groundGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));groundGeometry.setIndex(indices);groundGeometry.computeVertexNormals();
    const ground=new THREE.Mesh(groundGeometry,material(new THREE.MeshLambertMaterial({vertexColors:true})));
    ground.name='terrain';ground.receiveShadow=true;scene.add(ground);
    // 경계 밖 2단위 띠만 추가한다. 플레이 지형 아래 겹친 면은 만들지 않는다.
    const borderGeometry=geometry(new THREE.BufferGeometry());
    /** @type {number[]} */ const borderPositions=[],borderIndices=[];
    /** @type {number[][]} */ const perimeter=[];
    for(let i=0;i<rules.cols;i++)perimeter.push([i-rules.cols/2,-rules.rows/2]);
    for(let i=0;i<rules.rows;i++)perimeter.push([rules.cols/2,i-rules.rows/2]);
    for(let i=0;i<rules.cols;i++)perimeter.push([rules.cols/2-i,rules.rows/2]);
    for(let i=0;i<rules.rows;i++)perimeter.push([-rules.cols/2,rules.rows/2-i]);
    for(let i=0;i<perimeter.length;i++){
      const a=perimeter[i],b=perimeter[(i+1)%perimeter.length],base=borderPositions.length/3;
      borderPositions.push(a[0],terrain.heightAt(a[0],a[1]),a[1],b[0],terrain.heightAt(b[0],b[1]),b[1],b[0]*(rules.cols+4)/rules.cols,-0.05,b[1]*(rules.rows+4)/rules.rows,a[0]*(rules.cols+4)/rules.cols,-0.05,a[1]*(rules.rows+4)/rules.rows);
      borderIndices.push(base,base+2,base+1,base,base+3,base+2);
    }
    borderGeometry.setAttribute('position',new THREE.Float32BufferAttribute(borderPositions,3));borderGeometry.setIndex(borderIndices);borderGeometry.computeVertexNormals();
    const border=new THREE.Mesh(borderGeometry,lambert('#A9BF83'));border.receiveShadow=true;scene.add(border);

    const trunkGeometry=geometry(new THREE.CylinderGeometry(0.15,0.18,1.1,8));
    const leafGeometry=geometry(new THREE.SphereGeometry(1,12,8));
    const trunks=new THREE.InstancedMesh(trunkGeometry,lambert('#947657'),rules.trees.length);
    const crowns=new THREE.InstancedMesh(leafGeometry,lambert('#FFFFFF'),rules.trees.length*3);
    const transform=new THREE.Object3D();
    rules.trees.forEach((tree,i)=>{
      const point=terrain.toWorld(tree),y=terrain.heightAt(point.x,point.z);
      transform.position.set(point.x,y+0.55,point.z);transform.scale.set(1,1,1);transform.updateMatrix();trunks.setMatrixAt(i,transform.matrix);
      const variation=0.94+(i%4)*0.035;
      for(const [part,[dx,dy,dz,radius]] of [[-0.27,1.62,0.04,0.65],[0.2,1.86,-0.03,0.8],[0.01,2.13,0.07,0.55]].entries()){
        transform.position.set(point.x+dx,y+dy,point.z+dz);transform.scale.setScalar(radius*variation);transform.updateMatrix();
        crowns.setMatrixAt(i*3+part,transform.matrix);crowns.setColorAt(i*3+part,color(part===1?'#6F965D':'#85AA6B'));
      }
    });
    // r128은 인스턴스별 경계를 계산하지 않는다. 고정 12그루 fixture는 전체를 제출한다.
    trunks.frustumCulled=false;crowns.frustumCulled=false;crowns.castShadow=true;
    scene.add(trunks,crowns);

    const gradient=new THREE.DataTexture(new Uint8Array([140,255]),2,1,THREE.LuminanceFormat);
    gradient.minFilter=gradient.magFilter=THREE.NearestFilter;gradient.generateMipmaps=false;gradient.needsUpdate=true;textures.add(gradient);
    /** @param {string} hex */
    const toon=hex=>material(new THREE.MeshToonMaterial({color:color(hex),gradientMap:gradient}));
    const models=options.walking?BackyardRpg3dModels.create({geometry,material,color}):null;
    if(models)textures.add(models.gradient);
    const outline=material(new THREE.MeshBasicMaterial({color:color('#4D5C48'),side:THREE.BackSide}));
    const player=new THREE.Group();player.name='player';player.position.set(anchor.x,foot,anchor.z);scene.add(player);
    const sphere=geometry(new THREE.SphereGeometry(1,16,12));
    /** @type {ReturnType<NonNullable<typeof models>['player']>|null} */ let rig=null;
    if(models){
      rig=models.player(options.outfit===1?1:0);player.add(rig.group);
    }else{
      const skin=toon('#EBC7A1'),shirt=toon('#DD9A67'),hair=toon('#695643'),pants=toon('#6B7B67');
      const dark=material(new THREE.MeshBasicMaterial({color:color('#394535')}));
      /** 정규화된 geometry를 배치하고 필요한 큰 파츠에만 외곽선을 만든다.
       * @param {import('three').BufferGeometry} shape @param {import('three').Material} surface
       * @param {number[]} position @param {number[]} scale @param {boolean} [hull] @param {boolean} [cast] */
      const part=(shape,surface,position,scale,hull=false,cast=true)=>{
        const mesh=new THREE.Mesh(shape,surface);mesh.position.set(position[0],position[1],position[2]);mesh.scale.set(scale[0],scale[1],scale[2]);mesh.castShadow=cast;player.add(mesh);
        if(hull){
          // 비균일 스케일을 먼저 굽고 월드 단위 0.014만큼 법선 방향으로 팽창한다.
          const shellGeometry=geometry(shape.clone());shellGeometry.scale(scale[0],scale[1],scale[2]);
          const p=shellGeometry.getAttribute('position'),n=shellGeometry.getAttribute('normal');
          for(let i=0;i<p.count;i++)p.setXYZ(i,p.getX(i)+n.getX(i)*0.014,p.getY(i)+n.getY(i)*0.014,p.getZ(i)+n.getZ(i)*0.014);
          const shell=new THREE.Mesh(shellGeometry,outline);shell.position.copy(mesh.position);player.add(shell);
        }
        return mesh;
      };
      // 키 1.35, 머리 지름 0.66, 몸 높이 0.48, 다리 0.23, 팔 0.30.
      part(sphere,skin,[0,1.02,0],[0.33,0.33,0.33],true);
      // 원기둥과 위아래 반구를 한 geometry로 합쳐 외곽선의 내부 검은 링을 줄인다.
      const bodyParts=[new THREE.CylinderGeometry(0.22,0.22,0.2,16,1,true).scale(1,1,0.17/0.22).translate(0,0.47,0),
        new THREE.SphereGeometry(1,16,8,0,Math.PI*2,0,Math.PI/2).scale(0.22,0.14,0.17).translate(0,0.57,0),
        new THREE.SphereGeometry(1,16,8,0,Math.PI*2,Math.PI/2,Math.PI/2).scale(0.22,0.14,0.17).translate(0,0.37,0)];
      /** @type {number[]} */ const bodyPositions=[],bodyNormals=[];
      for(const source of bodyParts){const flat=source.toNonIndexed();bodyPositions.push(...Array.from(flat.getAttribute('position').array));bodyNormals.push(...Array.from(flat.getAttribute('normal').array));flat.dispose();source.dispose();}
      const body=geometry(new THREE.BufferGeometry());body.setAttribute('position',new THREE.Float32BufferAttribute(bodyPositions,3));body.setAttribute('normal',new THREE.Float32BufferAttribute(bodyNormals,3));
      part(body,shirt,[0,0,0],[1,1,1],true);
      for(const side of [-1,1]){
        part(sphere,pants,[side*0.12,0.115,0.015],[0.095,0.115,0.12]);
        const arm=part(sphere,shirt,[side*0.265,0.48,0],[0.085,0.15,0.09]);arm.rotation.z=side*0.16;
        part(sphere,skin,[side*0.29,0.355,0.02],[0.072,0.075,0.075]);
        part(sphere,skin,[side*0.326,1.005,0],[0.065,0.085,0.07],true);
        part(sphere,dark,[side*0.108,1.04,0.304],[0.024,0.035,0.018],false,false);
      }
      const hairCap=geometry(new THREE.SphereGeometry(1,16,10,0,Math.PI*2,0,1.29));
      part(hairCap,hair,[0,1.02,0],[0.35,0.348,0.35]);
      part(sphere,hair,[-0.15,1.21,0.22],[0.13,0.10,0.09]);
      part(sphere,skin,[0,0.963,0.324],[0.043,0.033,0.034],false,false);
    }

    // 반구 아래에 짧은 하늘 치마를 이어 하향 카메라에서도 검은 빈 공간이 생기지 않게 한다.
    const skyGeometry=geometry(new THREE.SphereGeometry(60,16,8,0,Math.PI*2,0,Math.PI*0.75));
    const skyPosition=skyGeometry.getAttribute('position');/** @type {number[]} */ const skyColors=[];
    const horizon=color('#E7EAD0'),zenith=color('#99CBDA');
    for(let i=0;i<skyPosition.count;i++){const tint=horizon.clone().lerp(zenith,Math.max(0,skyPosition.getY(i)/60));skyColors.push(tint.r,tint.g,tint.b);}
    skyGeometry.setAttribute('color',new THREE.Float32BufferAttribute(skyColors,3));
    const sky=new THREE.Mesh(skyGeometry,material(new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,depthWrite:false,fog:false})));
    sky.position.copy(camera.position);sky.renderOrder=-1;scene.add(sky);

    /** @type {Map<string,ReturnType<NonNullable<typeof models>['resident']>>} */ const residents=new Map();
    /** @type {Map<string,number>} */ const travelled=new Map();
    /** @type {Map<string,import('three').Mesh>} */ const nodeMeshes=new Map();
    /** @type {Map<string,import('three').InstancedMesh>} */ const furniture=new Map();
    /** @type {import('three').InstancedMesh|null} */ let berries=null;
    /** @type {import('three').Mesh|null} */ let rod=null;
    /** @type {import('three').Mesh|null} */ let net=null;
    /** @type {import('three').Mesh|null} */ let ghost=null;
    /** @type {import('three').Mesh|null} */ let marker=null;
    /** @type {import('three').Mesh[]} */ const ripples=[];

    if(options.walking){
      /** 마스크 합집합의 셀을 한 번씩만 그려 겹친 면을 없앤다. @param {readonly RpgRect[]} masks @param {number} elevation @param {import('three').Material} surface @param {boolean} follow */
      function maskMesh(masks,elevation,surface,follow){
        const vertices=[],triangles=[];
        for(let row=0;row<rules.rows;row++)for(let col=0;col<rules.cols;col++){
          if(!masks.some(r=>col*32>=r.x&&col*32<r.x+r.width&&row*32>=r.y&&row*32<r.y+r.height))continue;
          const base=vertices.length/3,x=col-16,z=row-12;
          for(const [dx,dz] of [[0,0],[1,0],[0,1],[1,1]])vertices.push(x+dx,(follow?terrain.heightAt(x+dx,z+dz):0)+elevation,z+dz);
          triangles.push(base,base+2,base+1,base+1,base+2,base+3);
        }
        const shape=geometry(new THREE.BufferGeometry());shape.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));shape.setIndex(triangles);shape.computeVertexNormals();
        const mesh=new THREE.Mesh(shape,surface);mesh.receiveShadow=follow;scene.add(mesh);return mesh;
      }
      maskMesh(rules.paths,0.01,lambert('#D9C9A3'),true).name='paths';
      maskMesh(rules.water,-0.18,lambert('#688E83'),false).name='pond-floor';
      maskMesh(rules.water,-0.08,material(new THREE.MeshLambertMaterial({color:color('#7FB8B4'),opacity:0.72,transparent:true,depthWrite:false})),false).name='water';
      // 물 셀의 외곽 간선만 둑으로 세워 시각 경계와 충돌 마스크를 일치시킨다.
      const bankVertices=[],bankIndices=[];
      const wet=(/** @type {number} */ x,/** @type {number} */ y)=>rules.water.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
      for(const r of rules.water)for(let u=r.x;u<r.x+r.width;u+=32){
        const x=u/32-16,z=r.y/32-12;
        for(const [dx,dz,ax,az,bx,bz] of [[0,-1,0,0,1,0],[0,1,1,1,0,1],[-1,0,0,1,0,0],[1,0,1,0,1,1]]){
          if(wet(u+16+dx*32,r.y+16+dz*32))continue;
          const base=bankVertices.length/3;
          bankVertices.push(x+ax,0,z+az,x+bx,0,z+bz,x+ax,-0.18,z+az,x+bx,-0.18,z+bz);
          bankIndices.push(base,base+1,base+2,base+1,base+3,base+2);
        }
      }
      const bankShape=geometry(new THREE.BufferGeometry());bankShape.setAttribute('position',new THREE.Float32BufferAttribute(bankVertices,3));bankShape.setIndex(bankIndices);bankShape.computeVertexNormals();
      scene.add(new THREE.Mesh(bankShape,material(new THREE.MeshLambertMaterial({color:color('#D9C9A3'),side:THREE.DoubleSide}))));
      const h=rules.house,home=terrain.toWorld({x:h.x+h.width/2,y:h.y+h.height/2});
      const wall=new THREE.Mesh(geometry(new THREE.BoxGeometry(h.width/32,1.7,h.height/32)),lambert('#E6D4AE'));wall.position.set(home.x,0.85,home.z);wall.castShadow=wall.receiveShadow=true;scene.add(wall);
      const roofShape=new THREE.Shape();roofShape.moveTo(-2,0);roofShape.lineTo(0,1.2);roofShape.lineTo(2,0);roofShape.closePath();
      const roof=new THREE.Mesh(geometry(new THREE.ExtrudeGeometry(roofShape,{depth:2,bevelEnabled:false})),lambert('#A67558'));roof.position.set(home.x,1.7,home.z-1);roof.castShadow=true;scene.add(roof);
      const door=new THREE.Mesh(geometry(new THREE.BoxGeometry(0.65,1.05,0.03)),lambert('#947657'));door.position.set(home.x,0.525,home.z+1.02);scene.add(door);

      const shop=/** @type {NonNullable<typeof models>} */(models);
      // 지도 끝의 빈 배경을 막는 울타리(설계서 §5). 논리 경계 벽과 같은 자리이므로
      // 통행은 바뀌지 않고, cast 목록(캐릭터·수관·집·가구)에 넣지 않는다.
      const box=shop.shapes.box;
      const fencePosts=[];
      for(let x=-16;x<=16;x+=2)for(const z of [-12,12])fencePosts.push([x,z]);
      for(let z=-10;z<=10;z+=2)for(const x of [-16,16])fencePosts.push([x,z]);
      const posts=new THREE.InstancedMesh(geometry(new THREE.BoxGeometry(0.09,0.52,0.09)),lambert('#A98C63'),fencePosts.length);
      fencePosts.forEach(([x,z],i)=>{
        transform.position.set(x,terrain.heightAt(x,z)+0.2,z);transform.rotation.set(0,0,0);transform.scale.set(1,1,1);transform.updateMatrix();posts.setMatrixAt(i,transform.matrix);
      });
      posts.frustumCulled=false;posts.receiveShadow=true;scene.add(posts);
      const rails=[];
      for(const height of [0.24,0.42]){
        for(const z of [-12,12])rails.push({shape:box,hex:'#B79A70',position:[0,height,z],scale:[32.1,0.05,0.06]});
        for(const x of [-16,16])rails.push({shape:box,hex:'#B79A70',position:[x,height,0],scale:[0.06,0.05,24.1]});
      }
      const fence=new THREE.Mesh(shop.merge(rails),shop.materials.lambert);fence.receiveShadow=true;scene.add(fence);
      // 작업대는 규칙이 정한 고정 장소다. 새 가구 종류를 만들지 않는다.
      for(const site of rules.sites){
        if(site.kind!=='workbench')continue;
        const point=terrain.toWorld(site);
        const mesh=new THREE.Mesh(shop.furnitureGeometry('workbench'),shop.materials.lambert);
        mesh.position.set(point.x,terrain.heightAt(point.x,point.z),point.z);mesh.castShadow=true;scene.add(mesh);
      }
      // 낚시점 물결은 물리·획득 판정과 독립인 표현이다.
      for(const site of rules.sites.filter(s=>s.kind==='fishing')){
        const point=terrain.toWorld(site);
        const ripple=shop.marker('#CFE7E2');ripple.position.set(point.x+0.7,-0.07,point.z);ripple.scale.setScalar(0.4);
        scene.add(ripple);ripples.push(ripple);
      }
      for(const definition of BackyardRpgLife.residents){
        const model=shop.resident(definition.shape);model.group.visible=false;scene.add(model.group);residents.set(definition.id,model);
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
      berries=new THREE.InstancedMesh(shop.berryGeometry(),shop.materials.lambert,48);
      berries.castShadow=true;berries.count=0;berries.frustumCulled=false;scene.add(berries);
      rod=shop.tool('rod');net=shop.tool('net');rod.visible=net.visible=false;
      // 도구는 오른팔 관절에 붙는다. 같은 관절의 짧은 포즈로 이어진다(설계서 §6).
      rig?.hand.add(rod);rig?.hand.add(net);
      rod.position.set(0.05,-0.16,0.06);net.position.set(0.05,-0.16,0.06);
      rod.rotation.x=net.rotation.x=1.1;
      ghost=new THREE.Mesh(shop.furnitureGeometry('pot'),material(new THREE.MeshLambertMaterial({vertexColors:true,transparent:true,opacity:0.45,depthWrite:false})));
      ghost.visible=false;scene.add(ghost);
      marker=shop.marker('#53744B');marker.visible=false;marker.scale.setScalar(0.5);scene.add(marker);
    }

    // 도감은 세계 렌더를 멈추고 **같은 renderer의 scissor 영역**으로 표본만 그린다.
    const albumScene=new THREE.Scene();
    const albumCamera=new THREE.PerspectiveCamera(30,1,0.1,10);
    albumCamera.position.set(0.32,0.42,0.95);albumCamera.lookAt(0,0.15,0);
    albumScene.add(new THREE.HemisphereLight(color('#FFF6DF'),color('#B7A788'),0.85));
    const albumSun=new THREE.DirectionalLight(color('#FFF0D0'),0.75);albumSun.position.set(-1.4,2.2,1.6);albumScene.add(albumSun);
    const albumMesh=new THREE.Mesh(geometry(new THREE.BufferGeometry()),models?models.materials.lambert:lambert('#FFFFFF'));
    albumScene.add(albumMesh);
    const silhouette=material(new THREE.MeshBasicMaterial({color:color('#B9BFA6')}));
    const albumBackground=color('#FFF6DF');

    const crownMatrices=Array.from({length:rules.trees.length*3},(_,i)=>{const matrix=new THREE.Matrix4();crowns.getMatrixAt(i,matrix);return matrix;});
    const crownScales=rules.trees.map(()=>1),ray=new THREE.Raycaster();
    const follow=new THREE.Vector3(anchor.x,foot,anchor.z);
    let elapsed=0;
    /** 논리 px 위치를 접지된 3D 좌표로 바꾼다. @param {{x:number,y:number}} point */
    function ground3d(point){const world=terrain.toWorld(point);return {x:world.x,y:terrain.heightAt(world.x,world.z),z:world.z};}
    /**
     * 콘텐츠 스냅샷을 장면에 반영한다. 규칙이 계산한 것만 그린다.
     * @param {ReturnType<ReturnType<typeof BackyardRpg3dWorld.create>['snapshot']>} state @param {number} delta
     */
    function content(state,delta){
      if(!models)return;
      elapsed+=delta;
      for(const [id,model] of residents){
        const actor=state.actors.find(a=>a.id===id);
        if(!actor){model.group.visible=false;continue;}
        const point=ground3d(actor);
        model.group.visible=true;model.group.position.set(point.x,point.y,point.z);
        model.group.rotation.y=Math.PI/2-actor.direction*Math.PI/4;
        // 24px/s로 걷는 실제 이동거리로 위상을 진행한다. 누적 거리가 이 프레임에
        // 늘어나지 않았으면 쉬는 중이거나 길이 막힌 것이므로 발도 멈춘다.
        const moved=actor.distance>(travelled.get(id)??0);travelled.set(id,actor.distance);
        models.animate(model,actor.distance,moved,1,{sitting:actor.sitting});
      }
      for(const [id,mesh] of nodeMeshes){
        const node=state.nodes.find(n=>n.id===id);
        if(!node||!node.visible){mesh.visible=false;continue;}
        const point=ground3d(node);
        mesh.visible=true;
        // 벌레는 잎 위에서 작게 떠 있고 바닥 채집물은 접지한다(2D의 같은 구분).
        mesh.position.set(point.x,point.y+(node.species>=4?0.22+Math.sin(elapsed/700+node.species)*0.03:0),point.z);
        mesh.scale.setScalar(node.species>=4?0.85:1);
      }
      /** @type {Record<string,number>} */ const counts={pot:0,well:0,chair:0};
      let berryCount=0;
      for(const item of state.decorations){
        const mesh=furniture.get(item.kind);if(!mesh)continue;
        const point=ground3d({x:item.col*32+16,y:item.row*32+16});
        transform.position.set(point.x,point.y,point.z);transform.rotation.set(0,0,0);transform.scale.set(1,1,1);transform.updateMatrix();
        mesh.setMatrixAt(counts[item.kind]++,transform.matrix);
        if(item.kind==='pot'&&item.ready&&berries){berries.setMatrixAt(berryCount++,transform.matrix);}
      }
      for(const [kind,mesh] of furniture){mesh.count=counts[kind];mesh.instanceMatrix.needsUpdate=true;}
      if(berries){berries.count=berryCount;berries.instanceMatrix.needsUpdate=true;}
      // 익은 화분에만 열매가 달린다. 검증이 화분 시각을 규칙과 대조할 수 있게 노출한다.
      host?.setAttribute('data-furniture',counts.pot+','+counts.well+','+counts.chair);
      host?.setAttribute('data-berries',String(berryCount));
      if(ghost&&marker){
        const spot=state.ghost;
        ghost.visible=marker.visible=!!spot;
        if(spot){
          const point=ground3d({x:spot.col*32+16,y:spot.row*32+16});
          ghost.geometry=models.furnitureGeometry(spot.kind);
          ghost.position.set(point.x,point.y,point.z);
          marker.position.set(point.x,point.y+0.02,point.z);
          // 색만으로 알리지 않는다. 거절 이유 문구는 HUD가 함께 띄운다(설계서 §7).
          const surface=/** @type {import('three').MeshBasicMaterial} */(marker.material);
          surface.color.copy(color(spot.reason?'#B46555':'#53744B'));
        }
      }
      if(rod&&net){
        rod.visible=state.fishing.phase!=='idle';
        net.visible=!!state.gathering;
      }
      for(const [index,ripple] of ripples.entries()){
        const cycle=(elapsed/1000+index*1.3)%4;
        ripple.scale.setScalar(0.3+cycle*0.16);
        /** @type {import('three').MeshBasicMaterial} */(ripple.material).opacity=Math.max(0,0.6-cycle*0.15);
      }
    }
    /** 고정 방위각으로 추종하고 수관 가림만 줄인다.
     * @param {{x:number,y:number,z:number}} point @param {number} direction @param {number} delta
     * @param {boolean} [snap] @param {{distance?:number,moving?:boolean,sitting?:boolean,reaching?:boolean}} [pose] */
    function update(point,direction,delta,snap=false,pose={}){
      player.position.set(point.x,point.y,point.z);player.rotation.y=Math.PI/2-direction*Math.PI/4;
      if(rig&&models)models.animate(rig,pose.distance??0,pose.moving===true,1,{sitting:pose.sitting,reaching:pose.reaching});
      const blend=snap?1:1-Math.exp(-Math.min(100,Math.max(0,delta))/150);
      follow.lerp(new THREE.Vector3(Math.max(-15,Math.min(15,point.x)),point.y,Math.max(-11,Math.min(11,point.z))),blend);
      camera.position.set(follow.x,follow.y+8,follow.z+10);camera.lookAt(follow.x,follow.y+0.65,follow.z-0.9);sky.position.copy(camera.position);
      scene.updateMatrixWorld(true);
      const sight=new THREE.Vector3(point.x,point.y+0.9,point.z).sub(camera.position);ray.set(camera.position,sight.clone().normalize());ray.far=sight.length();
      // 원래 수관으로 판정해 축소된 순간 가림 해제/재진입이 반복되지 않게 한다.
      crownMatrices.forEach((matrix,i)=>crowns.setMatrixAt(i,matrix));crowns.instanceMatrix.needsUpdate=true;
      const hidden=new Set(ray.intersectObject(crowns).map(hit=>Math.floor((hit.instanceId??-3)/3)));
      crownScales.forEach((scale,i)=>{crownScales[i]=scale+((hidden.has(i)?0.08:1)-scale)*blend;});
      crownMatrices.forEach((matrix,i)=>{const next=matrix.clone();next.scale(new THREE.Vector3().setScalar(crownScales[Math.floor(i/3)]));crowns.setMatrixAt(i,next);});crowns.instanceMatrix.needsUpdate=true;
      const texel=20/1024,shadowX=Math.round(follow.x/texel)*texel,shadowZ=Math.round(follow.z/texel)*texel;
      sun.position.set(shadowX-10,16,shadowZ+8);sun.target.position.set(shadowX,0,shadowZ);view.shadowMap.needsUpdate=true;
    }

    let lit=true;
    /** 조명은 승인된 설정을 유지한다. */
    function applyLighting(){hemisphere.visible=sun.visible=lit;view.shadowMap.enabled=lit;view.shadowMap.needsUpdate=true;}
    /** 정적 장면은 변경 시에만 렌더링한다. 첫 프레임은 shader 컴파일을 포함한다. */
    function render(){
      if(disposed)return;view.info.reset();view.autoClear=true;view.setScissorTest(false);
      const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);view.setViewport(0,0,width,height);
      const start=performance.now();view.render(scene,camera);if(sun.shadow.map instanceof THREE.WebGLRenderTarget)targets.add(sun.shadow.map);
      host?.setAttribute('data-render-cpu-ms',(performance.now()-start).toFixed(2));
      host?.setAttribute('data-calls',String(view.info.render.calls));host?.setAttribute('data-triangles',String(view.info.render.triangles));
    }
    /**
     * 보이는 도감 카드의 표본만 같은 renderer의 scissor로 그린다.
     * **카드마다 WebGL context를 만들지 않는다**(설계서 §6). 스크롤 영역과 교차한
     * 부분만 그려 패널 밖으로 표본이 새지 않는다.
     * @param {readonly {index:number,found:boolean,left:number,top:number,width:number,height:number}[]} cards
     * @param {{left:number,top:number,width:number,height:number}|null} clip
     */
    function specimens(cards,clip){
      if(disposed||!models)return;
      const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);
      view.info.reset();view.autoClear=false;view.setScissorTest(false);
      view.setViewport(0,0,width,height);view.setClearColor(albumBackground,1);view.clear();
      for(const card of cards){
        const left=Math.max(card.left,clip?clip.left:0),right=Math.min(card.left+card.width,clip?clip.left+clip.width:width);
        const top=Math.max(card.top,clip?clip.top:0),bottom=Math.min(card.top+card.height,clip?clip.top+clip.height:height);
        if(right-left<1||bottom-top<1)continue;
        view.setViewport(card.left,height-(card.top+card.height),card.width,card.height);
        view.setScissor(left,height-bottom,right-left,bottom-top);view.setScissorTest(true);
        albumMesh.geometry=models.speciesGeometry(card.index);
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

    window.addEventListener('resize',resize,{signal:listeners.signal});
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();cancelAnimationFrame(frame);fail(Error('3D 연결이 끊겼습니다. 다시 열어 주세요'));},{signal:listeners.signal});
    canvas.addEventListener('webglcontextrestored',()=>{if(disposed)return;resize();host.dataset.ready='true';},{signal:listeners.signal});
    applyLighting();resize();
    // GPU 완료 시간이 아니라 최초 제출 후 다음 RAF까지의 경과 시간이다.
    host.dataset.firstSubmitMs=performance.now().toFixed(2);
    host.dataset.treeCount=String(trunks.count);host.dataset.terrainVertices=String(groundGeometry.getAttribute('position').count);
    host.dataset.anchor=JSON.stringify({logical:rules.required[2],world:{...anchor,y:foot}});
    host.dataset.ready='true';
    return {dispose,resize,update,render,content,specimens};
  }catch(error){dispose();fail(error);return null;}
}
};
