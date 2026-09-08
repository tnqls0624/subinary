// @ts-check
/// <reference path="../../../types/three-r128.d.ts" />
/** 슬라이스 1 전용 고정 장면. 게임 저장·입력·세션을 소유하지 않는다. */
(() => {
  const host=document.getElementById('fixture'),canvas=document.getElementById('scene');
  const failure=document.getElementById('failure'),detail=document.getElementById('failure-detail');
  const toggle=document.getElementById('lighting'),retry=document.getElementById('retry');
  if(!(host instanceof HTMLElement)||!(canvas instanceof HTMLCanvasElement)||!failure||!detail||!toggle||!retry) return;
  const listeners=new AbortController();
  /** @type {import('three').WebGLRenderer|null} */ let renderer=null;
  /** @type {Set<import('three').BufferGeometry>} */ const geometries=new Set();
  /** @type {Set<import('three').Material>} */ const materials=new Set();
  /** @type {Set<import('three').Texture>} */ const textures=new Set();
  /** @type {Set<import('three').WebGLRenderTarget>} */ const targets=new Set();
  let disposed=false,frame=0;
  /** 오류는 빈 캔버스 대신 HTML로 표시한다. @param {unknown} error */
  function fail(error) {if(!failure||!detail)return;failure.hidden=false;detail.textContent=error instanceof Error?error.message:'3D 화면을 준비하지 못했습니다';host?.removeAttribute('data-ready');}
  /** 소유 자원을 한 번만 해제한다. */
  function dispose(){
    if(disposed)return;disposed=true;listeners.abort();cancelAnimationFrame(frame);
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());targets.forEach(t=>t.dispose());
    renderer?.dispose();renderer=null;host?.removeAttribute('data-ready');
  }
  retry.addEventListener('click',()=>location.reload(),{signal:listeners.signal});
  window.addEventListener('pagehide',dispose,{once:true,signal:listeners.signal});
  try {
    if(typeof THREE==='undefined'||THREE.REVISION!=='128')throw Error('동봉한 Three.js r128을 불러오지 못했습니다');
    if(typeof BackyardRpgRules==='undefined'||typeof BackyardRpg3dTerrain==='undefined')throw Error('지도 규칙을 불러오지 못했습니다');
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
    const anchor=terrain.toWorld(rules.required[2]);
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
      if(col<rules.cols&&row<rules.rows){const a=row*(rules.cols+1)+col,b=a+1,c=a+rules.cols+1,d=c+1;indices.push(a,c,b,b,c,d);}
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
    const skin=toon('#EBC7A1'),shirt=toon('#DD9A67'),hair=toon('#695643'),pants=toon('#6B7B67');
    const dark=material(new THREE.MeshBasicMaterial({color:color('#394535')}));
    const outline=material(new THREE.MeshBasicMaterial({color:color('#4D5C48'),side:THREE.BackSide}));
    const player=new THREE.Group();player.name='player';player.position.set(anchor.x,foot,anchor.z);scene.add(player);
    const sphere=geometry(new THREE.SphereGeometry(1,16,12));
    /** 정규화된 geometry를 배치하고 필요한 큰 파츠에만 외곽선을 만든다.
     * @param {import('three').BufferGeometry} shape @param {import('three').Material} surface
     * @param {number[]} position @param {number[]} scale @param {boolean} [hull] @param {boolean} [cast] */
    function part(shape,surface,position,scale,hull=false,cast=true){
      const mesh=new THREE.Mesh(shape,surface);mesh.position.set(position[0],position[1],position[2]);mesh.scale.set(scale[0],scale[1],scale[2]);mesh.castShadow=cast;player.add(mesh);
      if(hull){
        // 비균일 스케일을 먼저 굽고 월드 단위 0.014만큼 법선 방향으로 팽창한다.
        const shellGeometry=geometry(shape.clone());shellGeometry.scale(scale[0],scale[1],scale[2]);
        const p=shellGeometry.getAttribute('position'),n=shellGeometry.getAttribute('normal');
        for(let i=0;i<p.count;i++)p.setXYZ(i,p.getX(i)+n.getX(i)*0.014,p.getY(i)+n.getY(i)*0.014,p.getZ(i)+n.getZ(i)*0.014);
        const shell=new THREE.Mesh(shellGeometry,outline);shell.position.copy(mesh.position);player.add(shell);
      }
      return mesh;
    }
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

    // 반구 아래에 짧은 하늘 치마를 이어 하향 카메라에서도 검은 빈 공간이 생기지 않게 한다.
    const skyGeometry=geometry(new THREE.SphereGeometry(60,16,8,0,Math.PI*2,0,Math.PI*0.75));
    const skyPosition=skyGeometry.getAttribute('position');/** @type {number[]} */ const skyColors=[];
    const horizon=color('#E7EAD0'),zenith=color('#99CBDA');
    for(let i=0;i<skyPosition.count;i++){const tint=horizon.clone().lerp(zenith,Math.max(0,skyPosition.getY(i)/60));skyColors.push(tint.r,tint.g,tint.b);}
    skyGeometry.setAttribute('color',new THREE.Float32BufferAttribute(skyColors,3));
    const sky=new THREE.Mesh(skyGeometry,material(new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,depthWrite:false,fog:false})));
    sky.position.copy(camera.position);sky.renderOrder=-1;scene.add(sky);

    /** @type {Map<import('three').Mesh,import('three').Material>} */ const originalMaterials=new Map();
    /** @type {Map<import('three').Material,import('three').MeshBasicMaterial>} */ const unlitMaterials=new Map();
    scene.traverse(object=>{
      if(object instanceof THREE.Mesh && (object.material instanceof THREE.MeshLambertMaterial||object.material instanceof THREE.MeshToonMaterial)){
        originalMaterials.set(object,object.material);
        if(!unlitMaterials.has(object.material))unlitMaterials.set(object.material,material(new THREE.MeshBasicMaterial({color:object.material.color.clone(),vertexColors:object.material.vertexColors})));
      }
    });
    let lit=new URLSearchParams(location.search).get('lighting')!=='off';
    /** 동일 색과 geometry를 유지한 채 조명과 그림자 효과만 비교한다. */
    function applyLighting(){
      hemisphere.visible=sun.visible=lit;view.shadowMap.enabled=lit;view.shadowMap.needsUpdate=true;
      originalMaterials.forEach((surface,mesh)=>{mesh.material=lit?surface:unlitMaterials.get(surface)??surface;});
      toggle?.setAttribute('aria-pressed',String(lit));if(toggle)toggle.textContent=lit?'햇살 켜짐':'조명 없음';
    }
    /** 정적 장면은 변경 시에만 렌더링한다. 첫 프레임은 shader 컴파일을 포함한다. */
    function render(){
      if(disposed)return;view.info.reset();const start=performance.now();view.render(scene,camera);if(sun.shadow.map instanceof THREE.WebGLRenderTarget)targets.add(sun.shadow.map);
      host?.setAttribute('data-render-cpu-ms',(performance.now()-start).toFixed(2));
      host?.setAttribute('data-calls',String(view.info.render.calls));host?.setAttribute('data-triangles',String(view.info.render.triangles));
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
    toggle.addEventListener('click',()=>{lit=!lit;applyLighting();render();},{signal:listeners.signal});
    window.addEventListener('resize',resize,{signal:listeners.signal});
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();cancelAnimationFrame(frame);fail(Error('3D 연결이 끊겼습니다. 다시 열어 주세요'));},{signal:listeners.signal});
    canvas.addEventListener('webglcontextrestored',()=>{if(disposed)return;failure.hidden=true;resize();host.dataset.ready='true';},{signal:listeners.signal});
    applyLighting();resize();
    // GPU 완료 시간이 아니라 최초 제출 후 다음 RAF까지의 경과 시간이다.
    host.dataset.firstSubmitMs=performance.now().toFixed(2);
    host.dataset.treeCount=String(trunks.count);host.dataset.terrainVertices=String(groundGeometry.getAttribute('position').count);
    host.dataset.anchor=JSON.stringify({logical:rules.required[2],world:{...anchor,y:foot}});
    frame=requestAnimationFrame(()=>{if(disposed)return;host.dataset.firstFrameMs=performance.now().toFixed(2);host.dataset.ready='true';});
  }catch(error){dispose();fail(error);retry.addEventListener('click',()=>location.reload(),{once:true});}
})();
