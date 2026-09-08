// @ts-check
/// <reference path="../../../types/three-r128.d.ts" />
/**
 * 주민·표본·가구·도구의 기하와 **캐릭터 모션**만 만든다. 저장·DOM·게임 규칙을 소유하지 않는다.
 *
 * 설계서 §6의 실루엣 표가 계약이다 — **색을 지워도 세 주민이 구분**되어야 하므로
 * 곰은 폭, 새는 날개, 토끼는 귀 길이로 나뉜다. 16종도 색이 아니라 폭·날개·줄무늬·
 * 점·수염으로 나뉜다(2D `drawSpecies`의 같은 구분을 옮긴 것이며 종 목록은 규칙이 정한다).
 *
 * ## 왜 외곽선을 지웠나
 *
 * 첫 3D는 모든 캐릭터에 `#4D5C48` 뒤집힌 hull 외곽선을 둘렀다. 벤치마크(ACNH)에는
 * 외곽선이 없다 — 그 부드러움은 **둥근 형태 위의 감싸는 조명(wrap lighting)**에서
 * 온다. 그래서 2단 툰 그라디언트(140·255) 대신 어두운 쪽 바닥을 올린 부드러운 램프를
 * 쓴다. 그늘진 면도 완전히 어두워지지 않아 인형·펠트 같은 질감이 된다.
 *
 * ## 왜 모션 상태를 rig가 갖나
 *
 * 걷기 위상은 실제 이동거리에서 오지만(제자리면 발이 멈춘다 — 설계서 §6) 정지·호흡·
 * 눈 깜빡임·고개 돌림은 **시간**에서 온다. 그래서 `animate`는 delta(ms)를 받고 rig 안의
 * `motion`에 블렌드·타이머를 둔다. 예전처럼 정지 순간 자세를 0으로 스냅하지 않는다.
 *
 * 파츠는 정점 색을 구운 **하나의 geometry로 합친다**. 관절이 필요 없는 것(표본·가구)은
 * 드로우콜 1개가 되고, 48개 가구는 InstancedMesh 한 개로 제출된다.
 */
var BackyardRpg3dModels = (() => {
  /** @typedef {{shape:import('three').BufferGeometry,hex:string,position:number[],scale:number[],rotation?:number[]}} RpgModelPart */
  /** @typedef {{blend:number,time:number,blink:number,nextBlink:number,reach:number,sit:number,talk:number,yaw:number|null}} RpgMotion */
  /** @typedef {{group:import('three').Group,head:import('three').Object3D,body:import('three').Object3D,arms:import('three').Object3D[],legs:import('three').Object3D[],hand:import('three').Object3D,eyes:import('three').Object3D,feet:number[][],stride:number,motion:RpgMotion}} RpgModelRig */

  /** 파츠 하나를 기술한다. geometry는 재사용되고 여기서 복제하지 않는다.
   * @param {import('three').BufferGeometry} shape @param {string} hex
   * @param {number[]} position @param {number[]} scale @param {number[]} [rotation] @returns {RpgModelPart} */
  function part(shape,hex,position,scale,rotation){return {shape,hex,position,scale,rotation};}

  /** 시간 기반 모션 상태의 초기값. @param {number} stride 한 걷기 주기의 논리 px @returns {RpgMotion} */
  function freshMotion(stride){return {blend:0,time:stride*37%1000,blink:0,nextBlink:1800+stride*53%2400,reach:0,sit:0,talk:0,yaw:null};}

  /** 장면이 소유한 해제 등록기를 받는다.
   * @param {{geometry:<T extends import('three').BufferGeometry>(value:T)=>T,material:<T extends import('three').Material>(value:T)=>T,color:(hex:string)=>import('three').Color}} deps */
  function create(deps){
    const {geometry,material,color}=deps;
    const sphere=geometry(new THREE.SphereGeometry(1,18,14));
    const ball=geometry(new THREE.SphereGeometry(1,10,8));
    const dome=geometry(new THREE.SphereGeometry(1,16,8,0,Math.PI*2,0,Math.PI/2));
    const tube=geometry(new THREE.CylinderGeometry(1,1,1,12));
    const stick=geometry(new THREE.CylinderGeometry(1,1,1,6));
    const cone=geometry(new THREE.ConeGeometry(1,1,12));
    const box=geometry(new THREE.BoxGeometry(1,1,1));
    const diamond=geometry(new THREE.OctahedronGeometry(1,0));
    const disc=geometry(new THREE.CircleGeometry(1,20));
    const ring=geometry(new THREE.RingGeometry(0.86,1,24));
    const plane=geometry(new THREE.PlaneGeometry(1,1));
    /** @type {import('three').Texture[]} */ const textures=[];

    /**
     * 파츠를 정점 색을 구운 하나의 non-indexed geometry로 합친다.
     * 각 파츠의 비균일 스케일을 먼저 굽기 때문에 법선도 함께 변환된다.
     * @param {readonly RpgModelPart[]} parts @returns {import('three').BufferGeometry}
     */
    function merge(parts){
      /** @type {number[]} */ const positions=[],normals=[],colors=[];
      for(const item of parts){
        const shape=item.shape.clone();
        const rotation=item.rotation??[0,0,0];
        shape.scale(item.scale[0],item.scale[1],item.scale[2]);
        if(rotation[0])shape.rotateX(rotation[0]);
        if(rotation[1])shape.rotateY(rotation[1]);
        if(rotation[2])shape.rotateZ(rotation[2]);
        shape.translate(item.position[0],item.position[1],item.position[2]);
        const flat=shape.index?shape.toNonIndexed():shape;
        const position=flat.getAttribute('position'),normal=flat.getAttribute('normal'),tint=color(item.hex);
        for(let i=0;i<position.count;i++){
          positions.push(position.getX(i),position.getY(i),position.getZ(i));
          normals.push(normal.getX(i),normal.getY(i),normal.getZ(i));
          colors.push(tint.r,tint.g,tint.b);
        }
        if(flat!==shape)flat.dispose();
        shape.dispose();
      }
      const merged=geometry(new THREE.BufferGeometry());
      merged.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
      merged.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      merged.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
      return merged;
    }

    /** 법선 방향으로 팽창시킨 뒤집힌 hull. 외곽선은 더 쓰지 않지만 검증 도구가 호출하므로 남긴다.
     * @param {import('three').BufferGeometry} shape @param {number} [thickness] */
    function hull(shape,thickness=0.014){
      const shell=geometry(shape.clone());
      const position=shell.getAttribute('position'),normal=shell.getAttribute('normal');
      for(let i=0;i<position.count;i++)position.setXYZ(i,position.getX(i)+normal.getX(i)*thickness,position.getY(i)+normal.getY(i)*thickness,position.getZ(i)+normal.getZ(i)*thickness);
      shell.deleteAttribute('color');
      return shell;
    }

    /** 2D 캔버스로 그린 작은 텍스처. 이미지 파일을 동봉하지 않는다(설계서 §6).
     * @param {number} size @param {(context:CanvasRenderingContext2D,size:number)=>void} paint */
    function painted(size,paint){
      const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
      const context=canvas.getContext('2d');if(!context)throw Error('2D 캔버스를 만들 수 없습니다');
      paint(context,size);
      const texture=new THREE.CanvasTexture(canvas);texture.needsUpdate=true;textures.push(texture);return texture;
    }

    // 어두운 쪽 바닥을 올린 부드러운 램프. 2단(140·255) 툰 경계 대신 감싸는 조명이 된다.
    const gradient=new THREE.DataTexture(new Uint8Array([172,186,204,222,238,250,255,255]),8,1,THREE.LuminanceFormat);
    gradient.minFilter=gradient.magFilter=THREE.LinearFilter;gradient.generateMipmaps=false;gradient.needsUpdate=true;textures.push(gradient);
    const toon=material(new THREE.MeshToonMaterial({gradientMap:gradient,vertexColors:true}));
    const lambert=material(new THREE.MeshLambertMaterial({vertexColors:true}));
    // 외곽선 재질은 더 그리지 않지만 이름은 유지한다(장면·검증 도구가 참조한다).
    const outline=material(new THREE.MeshBasicMaterial({color:color('#6B5A4A'),side:THREE.BackSide}));
    const flat=material(new THREE.MeshBasicMaterial({vertexColors:true}));

    /** 관절 부모를 만들고 합친 파츠를 자식으로 붙인다.
     * @param {import('three').Object3D} parent @param {number[]} pivot @param {readonly RpgModelPart[]} parts
     * @param {{shadow?:boolean,material?:import('three').Material}} [options] */
    function joint(parent,pivot,parts,options={}){
      const node=new THREE.Object3D();node.position.set(pivot[0],pivot[1],pivot[2]);parent.add(node);
      if(parts.length){
        const mesh=new THREE.Mesh(merge(parts),options.material??toon);
        mesh.castShadow=options.shadow!==false;node.add(mesh);
      }
      return node;
    }
    /** 눈은 눈높이를 피벗으로 두어 깜빡임(scale.y)이 제자리에서 일어난다.
     * @param {import('three').Object3D} head @param {number} y @param {readonly RpgModelPart[]} parts */
    function eyesAt(head,y,parts){return joint(head,[0,y,0],parts,{shadow:false,material:flat});}
    /** 볼 홍조. 명암을 받지 않는 작은 파츠다. @param {import('three').Object3D} head @param {number} x @param {number} y @param {number} z @param {number} [size] */
    function cheeks(head,x,y,z,size=0.045){joint(head,[0,0,0],[part(ball,'#F2B3A0',[x,y,z],[size,size*0.66,0.02]),part(ball,'#F2B3A0',[-x,y,z],[size,size*0.66,0.02])],{shadow:false,material:flat});}
    /** 관절 목록의 기준 피벗을 기록한다. animate가 위치 오프셋을 여기서 더한다. @param {import('three').Object3D[]} legs */
    const rest=legs=>legs.map(leg=>[leg.position.x,leg.position.y,leg.position.z]);

    /**
     * 플레이어. 슬라이스 1의 비율을 유지하되 발을 조금 길게 두어 걸음이 보이게 했다.
     * outfit 0/1은 **옷색 변형만** 유지한다.
     * @param {number} outfit @returns {RpgModelRig}
     */
    function player(outfit){
      const skin='#F0CFAA',shirt=outfit===1?'#6FA1A6':'#E8A468',pants=outfit===1?'#4F6470':'#6B7B67',hair='#6E5643',eye='#33402F';
      const group=new THREE.Group();
      // 원기둥과 위아래 반구를 이어 캡슐 몸을 만든다(r128에 CapsuleGeometry가 없다).
      const torso=[part(tube,shirt,[0,0.47,0],[0.22,0.2,0.17]),part(dome,shirt,[0,0.57,0],[0.22,0.14,0.17]),
        part(dome,shirt,[0,0.37,0],[0.22,-0.14,0.17])];
      const body=joint(group,[0,0,0],torso);
      const head=joint(body,[0,1.02,0],[part(sphere,skin,[0,0,0],[0.33,0.33,0.33]),
        part(sphere,skin,[0.326,-0.015,0],[0.065,0.085,0.07]),part(sphere,skin,[-0.326,-0.015,0],[0.065,0.085,0.07]),
        part(sphere,hair,[0,0.02,-0.01],[0.35,0.345,0.35]),part(sphere,hair,[-0.15,0.2,0.22],[0.13,0.1,0.09]),part(sphere,hair,[0.13,0.24,0.2],[0.1,0.08,0.08]),
        part(sphere,skin,[0,-0.057,0.324],[0.043,0.033,0.034])]);
      // 눈·볼·입은 툰 명암을 받지 않는 작은 파츠다.
      const eyes=eyesAt(head,0.02,[part(ball,eye,[0.108,0,0.304],[0.026,0.04,0.018]),part(ball,eye,[-0.108,0,0.304],[0.026,0.04,0.018]),
        part(ball,'#FFFFFF',[0.115,0.012,0.318],[0.008,0.01,0.006]),part(ball,'#FFFFFF',[-0.101,0.012,0.318],[0.008,0.01,0.006])]);
      cheeks(head,0.17,-0.07,0.27);
      joint(head,[0,0,0],[part(ball,'#B9705C',[0,-0.12,0.31],[0.028,0.012,0.012])],{shadow:false,material:flat});
      const arms=[1,-1].map(side=>joint(body,[side*0.265,0.55,0],[part(sphere,shirt,[0,-0.07,0],[0.085,0.15,0.09],[0,0,side*0.16]),
        part(sphere,skin,[side*0.025,-0.195,0.02],[0.072,0.075,0.075])]));
      const legs=[1,-1].map(side=>joint(body,[side*0.12,0.25,0],[part(sphere,pants,[0,-0.12,0.02],[0.095,0.12,0.13])]));
      return {group,head,body,arms,legs,hand:arms[0],eyes,feet:rest(legs),stride:44,motion:freshMotion(44)};
    }

    /**
     * 주민 3명. 설계서 §6 실루엣 표대로 폭·날개·귀로 나뉜다. 치수는 검증이 재는 값이다.
     * @param {string} shape @returns {RpgModelRig}
     */
    function resident(shape){
      const group=new THREE.Group();
      const eye='#33402F';
      if(shape==='bear'){
        // 키 1.4 · 폭 넓은 몸 0.65 · 둥근 귀 2개 · 둥근 주둥이 · 짧고 묵직한 발.
        const fur='#B78E62',muzzle='#F0DDB2',inner='#D9AE84';
        const body=joint(group,[0,0,0],[part(sphere,fur,[0,0.52,0],[0.325,0.34,0.28]),part(sphere,muzzle,[0,0.45,0.2],[0.17,0.2,0.1])]);
        const head=joint(body,[0,1.13,0],[part(sphere,fur,[0,0,0],[0.25,0.24,0.24]),
          part(sphere,fur,[0.19,0.17,0],[0.09,0.09,0.075]),part(sphere,fur,[-0.19,0.17,0],[0.09,0.09,0.075]),
          part(sphere,inner,[0.19,0.17,0.03],[0.05,0.05,0.04]),part(sphere,inner,[-0.19,0.17,0.03],[0.05,0.05,0.04]),
          part(sphere,muzzle,[0,-0.07,0.21],[0.11,0.085,0.09])]);
        const eyes=eyesAt(head,0.04,[part(ball,eye,[0.1,0,0.22],[0.03,0.038,0.02]),part(ball,eye,[-0.1,0,0.22],[0.03,0.038,0.02]),
          part(ball,'#FFFFFF',[0.108,0.012,0.235],[0.009,0.01,0.006]),part(ball,'#FFFFFF',[-0.092,0.012,0.235],[0.009,0.01,0.006])]);
        joint(head,[0,0,0],[part(ball,'#4A3A2E',[0,-0.045,0.3],[0.03,0.022,0.018])],{shadow:false,material:flat});
        cheeks(head,0.16,-0.05,0.2,0.04);
        const arms=[1,-1].map(side=>joint(body,[side*0.35,0.62,0],[part(sphere,fur,[0,-0.07,0],[0.1,0.16,0.11])]));
        const legs=[1,-1].map(side=>joint(body,[side*0.16,0.2,0],[part(sphere,fur,[0,-0.1,0.02],[0.13,0.1,0.16])]));
        return {group,head,body,arms,legs,hand:arms[0],eyes,feet:rest(legs),stride:30,motion:freshMotion(30)};
      }
      if(shape==='bird'){
        // 키 1.2 · 물방울형 몸 · 양옆 넓은 날개 · 짧은 원뿔 부리 · 가는 발.
        const feather='#8FB3AB',wing='#6E9660',beak='#E0BC62',belly='#DCE8DF';
        const body=joint(group,[0,0,0],[part(sphere,feather,[0,0.44,0],[0.19,0.26,0.19]),part(sphere,belly,[0,0.4,0.09],[0.13,0.18,0.11]),
          part(cone,feather,[0,0.74,0],[0.19,0.3,0.19])]);
        const head=joint(body,[0,0.95,0],[part(sphere,feather,[0,0,0],[0.15,0.15,0.15]),
          part(sphere,feather,[0,0.17,-0.03],[0.06,0.07,0.06]),part(sphere,feather,[0.04,0.2,-0.06],[0.04,0.06,0.04]),
          part(cone,beak,[0,-0.02,0.19],[0.055,0.14,0.055],[Math.PI/2,0,0])]);
        const eyes=eyesAt(head,0.03,[part(ball,eye,[0.075,0,0.12],[0.024,0.03,0.016]),part(ball,eye,[-0.075,0,0.12],[0.024,0.03,0.016]),
          part(ball,'#FFFFFF',[0.081,0.01,0.132],[0.007,0.008,0.005]),part(ball,'#FFFFFF',[-0.069,0.01,0.132],[0.007,0.008,0.005])]);
        cheeks(head,0.11,-0.03,0.1,0.03);
        // 날개는 몸 양옆으로 넓게 벌어져 곰·토끼와 실루엣이 겹치지 않는다.
        const arms=[1,-1].map(side=>joint(body,[side*0.14,0.52,0],[part(sphere,wing,[side*0.17,-0.02,0],[0.22,0.14,0.06],[0,0,side*-0.35])]));
        const legs=[1,-1].map(side=>joint(body,[side*0.07,0.18,0],[part(stick,beak,[0,-0.09,0],[0.025,0.18,0.025]),
          part(stick,beak,[0,-0.175,0.04],[0.02,0.08,0.02],[Math.PI/2.4,0,0])]));
        return {group,head,body,arms,legs,hand:arms[0],eyes,feet:rest(legs),stride:30,motion:freshMotion(30)};
      }
      // 소담 토끼 — 몸 키 1.25 + 긴 귀 0.45 · 폭 좁은 몸 · 길쭉한 발.
      const fur='#F1E6CC',inner='#D9A08A',belly='#FFF8EA';
      const body=joint(group,[0,0,0],[part(sphere,fur,[0,0.55,0],[0.2,0.3,0.19]),part(sphere,belly,[0,0.5,0.1],[0.13,0.2,0.1])]);
      const head=joint(body,[0,1.06,0],[part(sphere,fur,[0,0,0],[0.19,0.19,0.18]),
        part(sphere,fur,[0.09,0.3,0],[0.055,0.225,0.04]),part(sphere,fur,[-0.09,0.3,0],[0.055,0.225,0.04]),
        part(sphere,inner,[0.09,0.31,0.03],[0.03,0.18,0.02]),part(sphere,inner,[-0.09,0.31,0.03],[0.03,0.18,0.02]),
        part(sphere,fur,[0,-0.06,0.17],[0.07,0.055,0.06])]);
      const eyes=eyesAt(head,0.03,[part(ball,eye,[0.085,0,0.15],[0.026,0.034,0.018]),part(ball,eye,[-0.085,0,0.15],[0.026,0.034,0.018]),
        part(ball,'#FFFFFF',[0.092,0.011,0.163],[0.008,0.009,0.005]),part(ball,'#FFFFFF',[-0.078,0.011,0.163],[0.008,0.009,0.005])]);
      joint(head,[0,0,0],[part(ball,'#C98A78',[0,-0.05,0.225],[0.02,0.014,0.012])],{shadow:false,material:flat});
      cheeks(head,0.13,-0.045,0.14,0.035);
      const arms=[1,-1].map(side=>joint(body,[side*0.245,0.65,0],[part(sphere,fur,[0,-0.07,0],[0.07,0.13,0.08])]));
      const legs=[1,-1].map(side=>joint(body,[side*0.11,0.2,0],[part(sphere,fur,[0,-0.14,0.05],[0.075,0.055,0.19])]));
      return {group,head,body,arms,legs,hand:arms[0],eyes,feet:rest(legs),stride:30,motion:freshMotion(30)};
    }

    /** @type {Map<number,import('three').BufferGeometry>} */ const speciesCache=new Map();
    /**
     * 16종 표본. 물고기는 −X를 바라보고 꼬리가 +X에 온다(2D 그림과 같은 방향).
     * 색 외의 구분은 폭·날개·줄무늬·점·수염이며 이 목록의 순서는 규칙의 species 순서다.
     * @param {number} index @returns {import('three').BufferGeometry}
     */
    function speciesGeometry(index){
      const cached=speciesCache.get(index);if(cached)return cached;
      const ink='#53604A';
      /** @type {RpgModelPart[]} */ let parts=[];
      if(index<2){
        // 열매 — 노란 열매가 크고 둥글며 빨간 열매는 좁다.
        const radius=index===0?0.11:0.085;
        parts=[part(sphere,index===0?'#E9C25B':'#D8705A',[0,radius,0],[radius,radius,radius]),
          part(sphere,'#6FA25A',[0.05,radius*2,0],[0.09,0.03,0.05],[0,0,0.35])];
      }else if(index===2){
        // 둥근 버섯 — 가느다란 대와 넓은 갓.
        parts=[part(tube,'#F0DDB2',[0,0.07,0],[0.035,0.14,0.035]),
          part(dome,'#D3906C',[0,0.13,0],[0.145,0.11,0.145]),part(ball,'#FFF6E6',[-0.06,0.17,0.03],[0.022,0.012,0.022]),part(ball,'#FFF6E6',[0.05,0.19,-0.04],[0.016,0.01,0.016])];
      }else if(index===3){
        // 솔방울 — 겹겹이 포개진 조각 8개.
        for(let row=0;row<4;row++)for(const side of [1,-1])parts.push(part(ball,row%2?'#867552':'#B78E62',[side*0.042,0.05+row*0.062,row%2?0.02:-0.02],[0.058,0.042,0.05]));
      }else if(index===4||index===5){
        // 나비 — 흰나비의 날개가 넓고 노랑나비는 좁다.
        const wide=index===4,hex=wide?'#FBF7EC':'#EFCB5E';
        for(const side of [1,-1]){
          parts.push(part(sphere,hex,[side*(wide?0.115:0.085),0.155,0.055],[wide?0.105:0.075,0.02,0.115]));
          parts.push(part(sphere,hex,[side*(wide?0.095:0.07),0.15,-0.075],[wide?0.075:0.055,0.018,0.08]));
        }
        parts.push(part(tube,ink,[0,0.155,0],[0.019,0.22,0.019],[Math.PI/2,0,0]));
        parts.push(part(ball,ink,[0,0.16,0.11],[0.026,0.026,0.026]));
      }else if(index===6){
        // 무당벌레 — 등의 점 4개와 가운데 선.
        parts=[part(dome,'#D8705A',[0,0.02,0],[0.13,0.11,0.15]),part(ball,ink,[0,0.045,-0.135],[0.055,0.05,0.05]),
          part(box,ink,[0,0.125,0],[0.012,0.012,0.28])];
        for(const side of [1,-1])for(const z of [0.05,-0.05])parts.push(part(ball,ink,[side*0.058,0.1,z],[0.02,0.014,0.02]));
      }else if(index===7){
        // 잠자리 — 길쭉한 몸과 네 날개.
        parts=[part(tube,'#67A6B0',[0,0.12,0.02],[0.019,0.36,0.019],[Math.PI/2,0,0]),
          part(ball,ink,[0,0.125,-0.17],[0.045,0.045,0.045])];
        for(const side of [1,-1])for(const z of [0.06,-0.06])parts.push(part(sphere,'#E7EEDD',[side*0.14,0.14,z],[0.14,0.011,0.042]));
      }else{
        const fish=index-8;
        const hexes=['#E9C25B','#B78E62','#E7EEDD','#8FB3AB','#867552','#6FA1A6','#CFDEDA','#D3906C'];
        const hex=hexes[fish];
        const rx=fish===0?0.1:fish===2?0.09:fish===4?0.15:0.12;
        const ry=fish===0?0.1:fish===2?0.03:fish===4?0.03:fish===5?0.08:0.06;
        const rz=Math.max(0.028,ry*0.8);
        // 은빛 물고기만 마름모 몸이다. 나머지는 폭·높이로 나뉜다.
        parts=[fish===6?part(diamond,hex,[0,0.14,0],[0.14,0.1,0.05]):part(sphere,hex,[0,0.14,0],[rx,ry,rz]),
          part(cone,hex,[rx+0.045,0.14,0],[Math.max(0.05,ry*1.4),0.1,rz*0.8],[0,0,-Math.PI/2]),
          part(ball,ink,[-rx*0.68,0.155,rz*0.62],[0.017,0.017,0.017]),part(ball,ink,[-rx*0.68,0.155,-rz*0.62],[0.017,0.017,0.017])];
        // 잉어·메기는 수염, 피라미는 줄무늬, 점박이는 점으로 구분한다.
        if(fish===1||fish===5)for(const side of [1,-1])parts.push(part(stick,ink,[-rx-0.03,0.115,side*0.03],[0.008,0.1,0.008],[0,0,Math.PI/2.6]));
        if(fish===3)for(const x of [-0.04,0.01,0.06])parts.push(part(box,ink,[x,0.14,0],[0.01,ry*1.7,rz*1.9]));
        if(fish===7)for(const x of [-0.05,0.01,0.06])parts.push(part(ball,ink,[x,0.14+(x>0?0.02:-0.02),rz*0.7],[0.018,0.018,0.012]));
      }
      const shape=merge(parts);speciesCache.set(index,shape);return shape;
    }

    /** @type {Map<string,import('three').BufferGeometry>} */ const furnitureCache=new Map();
    /**
     * 꾸미기 물건과 작업대. 기존 종류만 만들고 새 가구를 추가하지 않는다.
     * @param {string} kind @returns {import('three').BufferGeometry}
     */
    function furnitureGeometry(kind){
      const cached=furnitureCache.get(kind);if(cached)return cached;
      const wood='#9B7A58',cloth='#E4D3AA';
      /** @type {RpgModelPart[]} */ let parts=[];
      if(kind==='pot')parts=[part(tube,'#D3906C',[0,0.12,0],[0.17,0.24,0.17]),part(tube,'#BE7E5F',[0,0.25,0],[0.185,0.03,0.185]),
        part(sphere,'#6FA25A',[-0.06,0.32,0.02],[0.13,0.09,0.1]),part(sphere,'#7FB268',[0.07,0.37,-0.02],[0.11,0.12,0.1])];
      else if(kind==='well')parts=[part(tube,cloth,[0,0.16,0],[0.3,0.32,0.3]),part(disc,'#86C2C2',[0,0.325,0],[0.24,0.24,0.24],[-Math.PI/2,0,0]),
        part(box,wood,[0.24,0.5,0],[0.05,0.66,0.05]),part(box,wood,[-0.24,0.5,0],[0.05,0.66,0.05]),
        part(cone,'#D3906C',[0,0.94,0],[0.42,0.26,0.42],[0,Math.PI/4,0])];
      else if(kind==='chair')parts=[part(box,cloth,[0,0.32,0],[0.4,0.06,0.36]),part(box,cloth,[0,0.55,-0.16],[0.4,0.42,0.06]),
        ...[[0.16,0.14],[-0.16,0.14],[0.16,-0.14],[-0.16,-0.14]].map(([x,z])=>part(box,wood,[x,0.16,z],[0.05,0.32,0.05]))];
      else parts=[part(box,cloth,[0,0.42,0],[0.56,0.07,0.4]),part(box,'#D3906C',[0,0.49,0.04],[0.2,0.07,0.16]),
        ...[[0.22,0.14],[-0.22,0.14],[0.22,-0.14],[-0.22,-0.14]].map(([x,z])=>part(box,wood,[x,0.2,z],[0.06,0.4,0.06]))];
      const shape=merge(parts);furnitureCache.set(kind,shape);return shape;
    }

    /** 화분의 열매만 따로 만든다. 익지 않았으면 숨기고 화분 자체의 시각은 유지한다. */
    function berryGeometry(){
      const cached=furnitureCache.get('berry');if(cached)return cached;
      const shape=merge([part(ball,'#E9C25B',[0.02,0.42,0.06],[0.055,0.055,0.055]),part(ball,'#E9C25B',[-0.08,0.35,-0.02],[0.045,0.045,0.045])]);
      furnitureCache.set('berry',shape);return shape;
    }

    /**
     * 낚싯대·뜰채. 오른팔 관절에 붙는 짧은 포즈용 도구다.
     * @param {string} kind @returns {import('three').Mesh}
     */
    function tool(kind){
      /** @type {RpgModelPart[]} */ const parts=[part(stick,'#867552',[0,0.24,0],[0.014,0.48,0.014])];
      if(kind==='rod'){parts.push(part(stick,'#FBF7EC',[0,0.5,0.28],[0.004,0.6,0.004],[Math.PI/2.6,0,0]));}
      else {parts.push(part(geometry(new THREE.TorusGeometry(1,0.06,6,14)),'#FBF7EC',[0,0.56,0.02],[0.15,0.15,0.15],[Math.PI/2.4,0,0]));}
      const mesh=new THREE.Mesh(merge(parts),lambert);mesh.castShadow=true;return mesh;
    }

    /** 물 위의 찌. 입질은 이 찌가 잠기는 것으로 보인다(벤치마크의 핵심 낚시 피드백). */
    function bobber(){
      const mesh=new THREE.Mesh(merge([part(dome,'#D8705A',[0,0.05,0],[0.06,0.07,0.06]),part(dome,'#FBF7EC',[0,0.05,0],[0.06,-0.07,0.06]),
        part(stick,'#FBF7EC',[0,0.15,0],[0.008,0.1,0.008])]),lambert);
      mesh.castShadow=false;return mesh;
    }

    /** 물결·배치 표식에 쓰는 얇은 고리 한 장이다. @param {string} hex */
    function marker(hex){
      const mesh=new THREE.Mesh(ring,material(new THREE.MeshBasicMaterial({color:color(hex),transparent:true,opacity:0.7,side:THREE.DoubleSide,depthWrite:false})));
      mesh.rotation.x=-Math.PI/2;return mesh;
    }

    /** 발밑의 부드러운 접지 그림자. 그림자맵과 별개로 물체가 땅에 붙어 보이게 한다. */
    const blobTexture=painted(64,(context,size)=>{
      const shade=context.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);
      shade.addColorStop(0,'rgba(0,0,0,0.42)');shade.addColorStop(0.55,'rgba(0,0,0,0.22)');shade.addColorStop(1,'rgba(0,0,0,0)');
      context.fillStyle=shade;context.fillRect(0,0,size,size);
    });
    /** @param {number} radius */
    function blob(radius){
      const mesh=new THREE.Mesh(plane,material(new THREE.MeshBasicMaterial({map:blobTexture,color:color('#2F3F2A'),transparent:true,depthWrite:false})));
      mesh.rotation.x=-Math.PI/2;mesh.scale.setScalar(radius*2);mesh.renderOrder=1;return mesh;
    }

    /** 반짝이 입자 텍스처(둥근 빛). 획득·입질의 피드백이다. */
    const sparkleTexture=painted(32,(context,size)=>{
      const glow=context.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);
      glow.addColorStop(0,'rgba(255,255,255,1)');glow.addColorStop(0.35,'rgba(255,255,255,0.8)');glow.addColorStop(1,'rgba(255,255,255,0)');
      context.fillStyle=glow;context.fillRect(0,0,size,size);
    });
    /** @param {number} count @param {string} hex */
    function sparkles(count,hex){
      const shape=geometry(new THREE.BufferGeometry());
      shape.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(count*3),3));
      const points=new THREE.Points(shape,material(new THREE.PointsMaterial({map:sparkleTexture,color:color(hex),size:0.22,transparent:true,depthWrite:false,opacity:0})));
      points.frustumCulled=false;points.visible=false;return points;
    }

    /** 구름 한 장. 납작한 구체 몇 개를 합친 정점색 기하다. @param {number} seed */
    function cloudGeometry(seed){
      /** @type {RpgModelPart[]} */ const parts=[];
      const lobes=3+seed%3;
      for(let i=0;i<lobes;i++){
        const t=i/(lobes-1||1)-0.5,r=0.55+((seed*7+i*13)%10)/40;
        parts.push(part(sphere,i%2?'#FFFFFF':'#F7F9F4',[t*1.8,Math.abs(t)*-0.25+((seed+i)%3)*0.06,((seed*3+i*5)%5-2)*0.12],[r,r*0.62,r*0.8]));
      }
      return merge(parts);
    }

    /** 최단 호로 yaw를 보간한다. 8방향 스냅 대신 시각 회전만 부드럽게 돈다.
     * @param {RpgModelRig} rig @param {number} target @param {number} delta @param {boolean} [snap] */
    function face(rig,target,delta,snap=false){
      const motion=rig.motion;
      if(motion.yaw===null||snap){motion.yaw=target;rig.group.rotation.y=target;return;}
      let difference=(target-motion.yaw)%(Math.PI*2);
      if(difference>Math.PI)difference-=Math.PI*2;if(difference<-Math.PI)difference+=Math.PI*2;
      motion.yaw+=difference*(1-Math.exp(-Math.min(100,Math.max(0,delta))/70));
      rig.group.rotation.y=motion.yaw;
    }

    /**
     * 캐릭터 모션 한 프레임. 걷기 위상은 **실제 이동거리**에서, 정지 모션은 **시간**에서 온다.
     * 충돌로 제자리면 발이 달리지 않는다(설계서 §6).
     * @param {RpgModelRig} rig @param {number} distance 논리 px 누적 이동거리
     * @param {boolean} moving @param {number} delta 밀리초
     * @param {{sitting?:boolean,reaching?:boolean,talking?:boolean}} [pose]
     */
    function animate(rig,distance,moving,delta,pose={}){
      const motion=rig.motion,step=Math.min(100,Math.max(0,Number.isFinite(delta)?delta:0));
      motion.time+=step;
      /** 지수 이징. @param {number} current @param {number} target @param {number} tau */
      const ease=(current,target,tau)=>current+(target-current)*(1-Math.exp(-step/tau));
      motion.blend=ease(motion.blend,moving?1:0,110);
      motion.sit=ease(motion.sit,pose.sitting?1:0,180);
      motion.reach=ease(motion.reach,pose.reaching?1:0,120);
      motion.talk=ease(motion.talk,pose.talking?1:0,150);
      const walk=motion.blend,idle=1-walk,sit=motion.sit,t=motion.time/1000;
      const phase=distance/rig.stride*Math.PI*2,swing=Math.sin(phase);
      // 걷기: 발은 앞뒤로 나가며 앞으로 나가는 쪽이 들린다. 팔은 반대 위상, 몸은 두 배 주기로 튄다.
      for(const [index,leg] of rig.legs.entries()){
        const sign=index===0?1:-1,base=rig.feet[index];
        leg.rotation.x=sign*swing*0.55*walk*(1-sit)+sit*1.15;
        leg.position.set(base[0],base[1]+Math.max(0,sign*swing)*0.045*walk*(1-sit),base[2]+sign*swing*0.075*walk*(1-sit)+sit*0.12);
      }
      const reach=motion.reach;
      rig.arms[0].rotation.x=(-swing*0.45*walk)*(1-reach)+(-1.3)*reach;
      rig.arms[1].rotation.x=swing*0.45*walk;
      rig.arms[0].rotation.z=-0.08*walk;rig.arms[1].rotation.z=0.08*walk;
      // 정지: 호흡(0.45Hz) · 고개가 가끔 옆을 본다(세제곱으로 가운데에 머문다) · 말할 때 끄덕임.
      const breath=Math.sin(t*Math.PI*2*0.45),look=Math.sin(t*0.35);
      const talk=motion.talk;
      rig.body.position.y=Math.abs(swing)*0.035*walk+breath*0.012*idle+Math.abs(Math.sin(t*12))*0.012*talk-0.16*sit;
      rig.body.rotation.x=0.08*walk+0.1*sit+breath*0.01*idle;
      rig.body.rotation.z=swing*0.04*walk;
      rig.head.rotation.z=-swing*0.03*walk;
      rig.head.rotation.y=look*look*look*0.35*idle*(1-talk);
      rig.head.rotation.x=breath*0.03*idle+Math.sin(t*14)*0.06*talk;
      // 눈 깜빡임: 2~4초마다 110ms. 두 눈이 같은 관절이라 scale.y 하나로 닫힌다.
      if(motion.time>=motion.nextBlink){motion.blink=110;motion.nextBlink=motion.time+2200+((motion.time*7919)%2600);}
      if(motion.blink>0){motion.blink=Math.max(0,motion.blink-step);rig.eyes.scale.y=motion.blink>0?0.12:1;}
      else rig.eyes.scale.y=1;
    }

    return Object.freeze({merge,part,hull,player,resident,speciesGeometry,furnitureGeometry,berryGeometry,tool,bobber,marker,blob,sparkles,cloudGeometry,painted,face,animate,
      materials:{toon,lambert,outline,flat},shapes:{sphere,ball,dome,tube,stick,cone,box,disc,ring,diamond,plane},gradient,textures});
  }
  return Object.freeze({create});
})();
