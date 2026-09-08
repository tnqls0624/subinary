// @ts-check
/// <reference path="../../../types/three-r128.d.ts" />
/**
 * 주민·표본·가구·도구의 기하만 만든다. 저장·DOM·게임 규칙을 소유하지 않는다.
 *
 * 설계서 §6의 실루엣 표가 계약이다 — **색을 지워도 세 주민이 구분**되어야 하므로
 * 곰은 폭, 새는 날개, 토끼는 귀 길이로 나뉜다. 16종도 색이 아니라 폭·날개·줄무늬·
 * 점·수염으로 나뉜다(2D `drawSpecies`의 같은 구분을 옮긴 것이며 종 목록은 규칙이 정한다).
 *
 * 파츠는 정점 색을 구운 **하나의 geometry로 합친다**. 관절이 필요 없는 것(표본·가구)은
 * 드로우콜 1개가 되고, 48개 가구는 InstancedMesh 한 개로 제출된다.
 */
var BackyardRpg3dModels = (() => {
  /** @typedef {{shape:import('three').BufferGeometry,hex:string,position:number[],scale:number[],rotation?:number[]}} RpgModelPart */
  /** @typedef {{group:import('three').Group,head:import('three').Object3D,body:import('three').Object3D,arms:import('three').Object3D[],legs:import('three').Object3D[],hand:import('three').Object3D}} RpgModelRig */

  /** 파츠 하나를 기술한다. geometry는 재사용되고 여기서 복제하지 않는다.
   * @param {import('three').BufferGeometry} shape @param {string} hex
   * @param {number[]} position @param {number[]} scale @param {number[]} [rotation] @returns {RpgModelPart} */
  function part(shape,hex,position,scale,rotation){return {shape,hex,position,scale,rotation};}

  /** 장면이 소유한 해제 등록기를 받는다.
   * @param {{geometry:<T extends import('three').BufferGeometry>(value:T)=>T,material:<T extends import('three').Material>(value:T)=>T,color:(hex:string)=>import('three').Color}} deps */
  function create(deps){
    const {geometry,material,color}=deps;
    const sphere=geometry(new THREE.SphereGeometry(1,16,12));
    const ball=geometry(new THREE.SphereGeometry(1,10,8));
    const dome=geometry(new THREE.SphereGeometry(1,16,8,0,Math.PI*2,0,Math.PI/2));
    const tube=geometry(new THREE.CylinderGeometry(1,1,1,12));
    const stick=geometry(new THREE.CylinderGeometry(1,1,1,6));
    const cone=geometry(new THREE.ConeGeometry(1,1,12));
    const box=geometry(new THREE.BoxGeometry(1,1,1));
    const diamond=geometry(new THREE.OctahedronGeometry(1,0));
    const disc=geometry(new THREE.CircleGeometry(1,20));
    const ring=geometry(new THREE.RingGeometry(0.86,1,24));

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

    /** 큰 파츠만 법선 방향으로 팽창시킨 뒤집힌 hull을 만든다. 작은 파츠에는 만들지 않는다.
     * @param {import('three').BufferGeometry} shape @param {number} [thickness] */
    function hull(shape,thickness=0.014){
      const shell=geometry(shape.clone());
      const position=shell.getAttribute('position'),normal=shell.getAttribute('normal');
      for(let i=0;i<position.count;i++)position.setXYZ(i,position.getX(i)+normal.getX(i)*thickness,position.getY(i)+normal.getY(i)*thickness,position.getZ(i)+normal.getZ(i)*thickness);
      shell.deleteAttribute('color');
      return shell;
    }

    const gradient=new THREE.DataTexture(new Uint8Array([140,255]),2,1,THREE.LuminanceFormat);
    gradient.minFilter=gradient.magFilter=THREE.NearestFilter;gradient.generateMipmaps=false;gradient.needsUpdate=true;
    const toon=material(new THREE.MeshToonMaterial({gradientMap:gradient,vertexColors:true}));
    const lambert=material(new THREE.MeshLambertMaterial({vertexColors:true}));
    const outline=material(new THREE.MeshBasicMaterial({color:color('#4D5C48'),side:THREE.BackSide}));
    const flat=material(new THREE.MeshBasicMaterial({vertexColors:true}));

    /** 관절 부모를 만들고 합친 파츠를 자식으로 붙인다.
     * @param {import('three').Object3D} parent @param {number[]} pivot @param {readonly RpgModelPart[]} parts
     * @param {{shadow?:boolean,shell?:boolean,material?:import('three').Material}} [options] */
    function joint(parent,pivot,parts,options={}){
      const node=new THREE.Object3D();node.position.set(pivot[0],pivot[1],pivot[2]);parent.add(node);
      if(parts.length){
        const shape=merge(parts);
        const mesh=new THREE.Mesh(shape,options.material??toon);
        mesh.castShadow=options.shadow!==false;node.add(mesh);
        if(options.shell)node.add(new THREE.Mesh(hull(shape),outline));
      }
      return node;
    }

    /**
     * 플레이어. 슬라이스 1에서 시각 승인된 비율·좌표를 그대로 관절로 나눈 것이며
     * 정지 자세의 렌더 결과는 같다. outfit 0/1은 **옷색 변형만** 유지한다.
     * @param {number} outfit @returns {RpgModelRig}
     */
    function player(outfit){
      const skin='#EBC7A1',shirt=outfit===1?'#72979B':'#DD9A67',pants=outfit===1?'#4F6470':'#6B7B67',hair='#695643',eye='#394535';
      const group=new THREE.Group();
      // 원기둥과 위아래 반구를 이어 캡슐 몸을 만든다(r128에 CapsuleGeometry가 없다).
      const torso=[part(tube,shirt,[0,0.47,0],[0.22,0.2,0.17]),part(dome,shirt,[0,0.57,0],[0.22,0.14,0.17]),
        part(dome,shirt,[0,0.37,0],[0.22,-0.14,0.17])];
      const body=joint(group,[0,0,0],torso,{shell:true});
      const head=joint(body,[0,1.02,0],[part(sphere,skin,[0,0,0],[0.33,0.33,0.33]),
        part(sphere,skin,[0.326,-0.015,0],[0.065,0.085,0.07]),part(sphere,skin,[-0.326,-0.015,0],[0.065,0.085,0.07]),
        part(sphere,hair,[0,0,0],[0.35,0.348,0.35],[0,0,0]),part(sphere,hair,[-0.15,0.19,0.22],[0.13,0.1,0.09]),
        part(sphere,skin,[0,-0.057,0.324],[0.043,0.033,0.034])],{shell:true});
      // 눈은 툰 명암을 받지 않는 작은 파츠다. 외곽선도 만들지 않는다.
      joint(head,[0,0,0],[part(ball,eye,[0.108,0.02,0.304],[0.024,0.035,0.018]),part(ball,eye,[-0.108,0.02,0.304],[0.024,0.035,0.018])],{shadow:false,material:flat});
      const arms=[1,-1].map(side=>joint(body,[side*0.265,0.55,0],[part(sphere,shirt,[0,-0.07,0],[0.085,0.15,0.09],[0,0,side*0.16]),
        part(sphere,skin,[side*0.025,-0.195,0.02],[0.072,0.075,0.075])]));
      const legs=[1,-1].map(side=>joint(body,[side*0.12,0.23,0],[part(sphere,pants,[0,-0.115,0.015],[0.095,0.115,0.12])]));
      return {group,head,body,arms,legs,hand:arms[0]};
    }

    /**
     * 주민 3명. 설계서 §6 실루엣 표대로 폭·날개·귀로 나뉜다.
     * @param {string} shape @returns {RpgModelRig}
     */
    function resident(shape){
      const group=new THREE.Group();
      const eye='#374B40';
      if(shape==='bear'){
        // 키 1.4 · 폭 넓은 몸 0.65 · 둥근 귀 2개 · 둥근 주둥이 · 짧고 묵직한 발.
        const fur='#B18A62',muzzle='#EBD8AC';
        const body=joint(group,[0,0,0],[part(sphere,fur,[0,0.52,0],[0.325,0.34,0.28])],{shell:true});
        const head=joint(body,[0,1.13,0],[part(sphere,fur,[0,0,0],[0.25,0.24,0.24]),
          part(sphere,fur,[0.19,0.17,0],[0.09,0.09,0.075]),part(sphere,fur,[-0.19,0.17,0],[0.09,0.09,0.075]),
          part(sphere,muzzle,[0,-0.07,0.21],[0.11,0.085,0.09])],{shell:true});
        joint(head,[0,0,0],[part(ball,eye,[0.1,0.04,0.22],[0.028,0.036,0.02]),part(ball,eye,[-0.1,0.04,0.22],[0.028,0.036,0.02])],{shadow:false,material:flat});
        const arms=[1,-1].map(side=>joint(body,[side*0.35,0.62,0],[part(sphere,fur,[0,-0.07,0],[0.1,0.16,0.11])]));
        const legs=[1,-1].map(side=>joint(body,[side*0.16,0.2,0],[part(sphere,fur,[0,-0.1,0.02],[0.13,0.1,0.16])]));
        return {group,head,body,arms,legs,hand:arms[0]};
      }
      if(shape==='bird'){
        // 키 1.2 · 물방울형 몸 · 양옆 넓은 날개 · 짧은 원뿔 부리 · 가는 발.
        const feather='#88A7A0',wing='#688A58',beak='#D7B461';
        const body=joint(group,[0,0,0],[part(sphere,feather,[0,0.44,0],[0.19,0.26,0.19]),
          part(cone,feather,[0,0.74,0],[0.19,0.3,0.19])],{shell:true});
        const head=joint(body,[0,0.95,0],[part(sphere,feather,[0,0,0],[0.15,0.15,0.15]),
          part(sphere,feather,[0,0.17,-0.03],[0.06,0.07,0.06]),
          part(cone,beak,[0,-0.02,0.19],[0.055,0.14,0.055],[Math.PI/2,0,0])],{shell:true});
        joint(head,[0,0,0],[part(ball,eye,[0.075,0.03,0.12],[0.022,0.028,0.016]),part(ball,eye,[-0.075,0.03,0.12],[0.022,0.028,0.016])],{shadow:false,material:flat});
        // 날개는 몸 양옆으로 넓게 벌어져 곰·토끼와 실루엣이 겹치지 않는다.
        const arms=[1,-1].map(side=>joint(body,[side*0.14,0.52,0],[part(sphere,wing,[side*0.17,-0.02,0],[0.22,0.14,0.06],[0,0,side*-0.35])],{shell:true}));
        const legs=[1,-1].map(side=>joint(body,[side*0.07,0.18,0],[part(stick,beak,[0,-0.09,0],[0.025,0.18,0.025]),
          part(stick,beak,[0,-0.175,0.04],[0.02,0.08,0.02],[Math.PI/2.4,0,0])]));
        return {group,head,body,arms,legs,hand:arms[0]};
      }
      // 소담 토끼 — 몸 키 1.25 + 긴 귀 0.45 · 폭 좁은 몸 · 길쭉한 발.
      const fur='#EEE2C6',inner='#C88B68';
      const body=joint(group,[0,0,0],[part(sphere,fur,[0,0.55,0],[0.2,0.3,0.19])],{shell:true});
      const head=joint(body,[0,1.06,0],[part(sphere,fur,[0,0,0],[0.19,0.19,0.18]),
        part(sphere,fur,[0.09,0.3,0],[0.055,0.225,0.04]),part(sphere,fur,[-0.09,0.3,0],[0.055,0.225,0.04]),
        part(sphere,inner,[0.09,0.31,0.03],[0.03,0.18,0.02]),part(sphere,inner,[-0.09,0.31,0.03],[0.03,0.18,0.02]),
        part(sphere,fur,[0,-0.06,0.17],[0.07,0.055,0.06])],{shell:true});
      joint(head,[0,0,0],[part(ball,eye,[0.085,0.03,0.15],[0.024,0.03,0.018]),part(ball,eye,[-0.085,0.03,0.15],[0.024,0.03,0.018])],{shadow:false,material:flat});
      const arms=[1,-1].map(side=>joint(body,[side*0.245,0.65,0],[part(sphere,fur,[0,-0.07,0],[0.07,0.13,0.08])]));
      const legs=[1,-1].map(side=>joint(body,[side*0.11,0.2,0],[part(sphere,fur,[0,-0.14,0.05],[0.075,0.055,0.19])]));
      return {group,head,body,arms,legs,hand:arms[0]};
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
        parts=[part(sphere,index===0?'#D7B461':'#C16D58',[0,radius,0],[radius,radius,radius]),
          part(sphere,'#688A58',[0.05,radius*2,0],[0.09,0.03,0.05],[0,0,0.35])];
      }else if(index===2){
        // 둥근 버섯 — 가느다란 대와 넓은 갓.
        parts=[part(tube,'#EBD8AC',[0,0.07,0],[0.035,0.14,0.035]),
          part(dome,'#C88B68',[0,0.13,0],[0.145,0.11,0.145]),part(ball,'#EEE2C6',[-0.06,0.17,0.03],[0.022,0.012,0.022])];
      }else if(index===3){
        // 솔방울 — 겹겹이 포개진 조각 8개.
        for(let row=0;row<4;row++)for(const side of [1,-1])parts.push(part(ball,row%2?'#827451':'#B18A62',[side*0.042,0.05+row*0.062,row%2?0.02:-0.02],[0.058,0.042,0.05]));
      }else if(index===4||index===5){
        // 나비 — 흰나비의 날개가 넓고 노랑나비는 좁다.
        const wide=index===4,hex=wide?'#F5F1E7':'#D7B461';
        for(const side of [1,-1]){
          parts.push(part(sphere,hex,[side*(wide?0.115:0.085),0.155,0.055],[wide?0.105:0.075,0.02,0.115]));
          parts.push(part(sphere,hex,[side*(wide?0.095:0.07),0.15,-0.075],[wide?0.075:0.055,0.018,0.08]));
        }
        parts.push(part(tube,ink,[0,0.155,0],[0.019,0.22,0.019],[Math.PI/2,0,0]));
        parts.push(part(ball,ink,[0,0.16,0.11],[0.026,0.026,0.026]));
      }else if(index===6){
        // 무당벌레 — 등의 점 4개와 가운데 선.
        parts=[part(dome,'#C16D58',[0,0.02,0],[0.13,0.11,0.15]),part(ball,ink,[0,0.045,-0.135],[0.055,0.05,0.05]),
          part(box,ink,[0,0.125,0],[0.012,0.012,0.28])];
        for(const side of [1,-1])for(const z of [0.05,-0.05])parts.push(part(ball,ink,[side*0.058,0.1,z],[0.02,0.014,0.02]));
      }else if(index===7){
        // 잠자리 — 길쭉한 몸과 네 날개.
        parts=[part(tube,'#659DA7',[0,0.12,0.02],[0.019,0.36,0.019],[Math.PI/2,0,0]),
          part(ball,ink,[0,0.125,-0.17],[0.045,0.045,0.045])];
        for(const side of [1,-1])for(const z of [0.06,-0.06])parts.push(part(sphere,'#E1E8D6',[side*0.14,0.14,z],[0.14,0.011,0.042]));
      }else{
        const fish=index-8;
        const hexes=['#D7B461','#B18A62','#E1E8D6','#88A7A0','#827451','#72979B','#C8D9D3','#C88B68'];
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
      const wood='#947657',cloth='#D8C7A0';
      /** @type {RpgModelPart[]} */ let parts=[];
      if(kind==='pot')parts=[part(tube,'#C88B68',[0,0.12,0],[0.17,0.24,0.17]),part(tube,'#B4795A',[0,0.25,0],[0.185,0.03,0.185]),
        part(sphere,'#688A58',[-0.06,0.32,0.02],[0.13,0.09,0.1]),part(sphere,'#688A58',[0.07,0.37,-0.02],[0.11,0.12,0.1])];
      else if(kind==='well')parts=[part(tube,cloth,[0,0.16,0],[0.3,0.32,0.3]),part(disc,'#80B8B8',[0,0.325,0],[0.24,0.24,0.24],[-Math.PI/2,0,0]),
        part(box,wood,[0.24,0.5,0],[0.05,0.66,0.05]),part(box,wood,[-0.24,0.5,0],[0.05,0.66,0.05]),
        part(cone,'#C88B68',[0,0.94,0],[0.42,0.26,0.42],[0,Math.PI/4,0])];
      else if(kind==='chair')parts=[part(box,cloth,[0,0.32,0],[0.4,0.06,0.36]),part(box,cloth,[0,0.55,-0.16],[0.4,0.42,0.06]),
        ...[[0.16,0.14],[-0.16,0.14],[0.16,-0.14],[-0.16,-0.14]].map(([x,z])=>part(box,wood,[x,0.16,z],[0.05,0.32,0.05]))];
      else parts=[part(box,cloth,[0,0.42,0],[0.56,0.07,0.4]),part(box,'#C88B68',[0,0.49,0.04],[0.2,0.07,0.16]),
        ...[[0.22,0.14],[-0.22,0.14],[0.22,-0.14],[-0.22,-0.14]].map(([x,z])=>part(box,wood,[x,0.2,z],[0.06,0.4,0.06]))];
      const shape=merge(parts);furnitureCache.set(kind,shape);return shape;
    }

    /** 화분의 열매만 따로 만든다. 익지 않았으면 숨기고 화분 자체의 시각은 유지한다. */
    function berryGeometry(){
      const cached=furnitureCache.get('berry');if(cached)return cached;
      const shape=merge([part(ball,'#D7B461',[0.02,0.42,0.06],[0.055,0.055,0.055]),part(ball,'#D7B461',[-0.08,0.35,-0.02],[0.045,0.045,0.045])]);
      furnitureCache.set('berry',shape);return shape;
    }

    /**
     * 낚싯대·뜰채. 오른팔 관절에 붙는 짧은 포즈용 도구다.
     * @param {string} kind @returns {import('three').Mesh}
     */
    function tool(kind){
      /** @type {RpgModelPart[]} */ const parts=[part(stick,'#827451',[0,0.24,0],[0.014,0.48,0.014])];
      if(kind==='rod'){parts.push(part(stick,'#F5F1E7',[0,0.5,0.28],[0.004,0.6,0.004],[Math.PI/2.6,0,0]));parts.push(part(ball,'#C16D58',[0,0.24,0.56],[0.03,0.045,0.03]));}
      else {parts.push(part(geometry(new THREE.TorusGeometry(1,0.06,6,14)),'#F5F1E7',[0,0.56,0.02],[0.15,0.15,0.15],[Math.PI/2.4,0,0]));}
      const mesh=new THREE.Mesh(merge(parts),lambert);mesh.castShadow=true;return mesh;
    }

    /** 물결·배치 표식에 쓰는 얇은 고리 한 장이다. @param {string} hex */
    function marker(hex){
      const mesh=new THREE.Mesh(ring,material(new THREE.MeshBasicMaterial({color:color(hex),transparent:true,opacity:0.7,side:THREE.DoubleSide,depthWrite:false})));
      mesh.rotation.x=-Math.PI/2;return mesh;
    }

    /**
     * 실제 이동거리로 걷기 위상을 진행한다. 충돌로 제자리면 발이 달리지 않는다(설계서 §6).
     * @param {RpgModelRig} rig @param {number} distance 논리 px 누적 이동거리
     * @param {boolean} moving @param {number} settle 0~1, 정지 복귀 진행도
     * @param {{sitting?:boolean,reaching?:boolean}} [pose]
     */
    function animate(rig,distance,moving,settle,pose={}){
      // 이동거리 0.8단위(논리 25.6px)마다 한 주기.
      const phase=distance/25.6*Math.PI*2;
      const swing=moving?Math.sin(phase)*0.349:0,blend=moving?1:Math.max(0,1-settle);
      const sitting=pose.sitting===true;
      rig.legs[0].rotation.x=swing*blend*(sitting?0.2:1);
      rig.legs[1].rotation.x=-swing*blend*(sitting?0.2:1);
      rig.arms[0].rotation.x=(pose.reaching?-1.15:-swing*blend);
      rig.arms[1].rotation.x=swing*blend;
      rig.body.position.y=(moving?Math.abs(Math.sin(phase))*0.025*blend:0)-(sitting?0.16:0);
      rig.head.rotation.z=Math.sin(phase)*0.035*blend;
      rig.body.rotation.x=sitting?0.12:0;
    }

    return Object.freeze({merge,part,hull,player,resident,speciesGeometry,furnitureGeometry,berryGeometry,tool,marker,animate,
      materials:{toon,lambert,outline,flat},shapes:{sphere,ball,dome,tube,stick,cone,box,disc,ring,diamond},gradient});
  }
  return Object.freeze({create});
})();
