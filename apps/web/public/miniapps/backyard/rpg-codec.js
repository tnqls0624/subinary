// @ts-check
/** @typedef {'rpg_meta'|'rpg_world'|'rpg_collection'|'rpg_residents'|'rpg_player'} RpgKey */
/** @typedef {{v:2,mapVersion:1,seed:number,initialized:true,migrated:boolean}} RpgMeta */
/** @typedef {{v:2,items:string[],legacyFruit:number}} RpgWorld */
/** @typedef {{v:2,species:string[],nodes:string[],fishing:number[],completed?:true}} RpgCollection */
/** @typedef {{v:2,items:string[]}} RpgResidents */
/** @typedef {{v:2,mapVersion:1,x:number,y:number,direction:number,outfit:number,t:number}} RpgPlayer */
/** @typedef {{rpg_meta:RpgMeta,rpg_world:RpgWorld,rpg_collection:RpgCollection,rpg_residents:RpgResidents,rpg_player:RpgPlayer}} RpgData */
/** @typedef {RpgData[RpgKey]} RpgSave */
/** @typedef {{status:'ok',value:RpgSave}|{status:'missing'}|{status:'unsupported_version',version:unknown}|{status:'invalid_state',message:string}} RpgDecoded */
/** @typedef {{id:string,kind:string,col:number,row:number,stored:boolean}} RpgOwned */
/** RPG 키의 정수·튜플·중복·상한을 검증하며 손상 상태를 자동 청소하지 않는다. */
var BackyardRpgCodec = (() => {
  /** @type {readonly RpgKey[]} */ const keys = ['rpg_meta','rpg_world','rpg_collection','rpg_residents','rpg_player'];
  const budgets = Object.freeze({rpg_meta:256,rpg_world:3072,rpg_collection:4096,rpg_residents:512,rpg_player:256});
  /** 객체 컨테이너를 검사한다. @param {unknown} v @returns {v is Record<string,unknown>} */
  function record(v) {return typeof v==='object'&&v!==null&&!Array.isArray(v);}
  /** 음이 아닌 정수를 검사한다. @param {unknown} v @param {number} [max] @returns {v is number} */
  function integer(v,max=Number.MAX_SAFE_INTEGER) {return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;}
  /** 토큰 전체가 정수인지 검사한다. @param {string} v @param {number} [max] */
  function token(v,max=Number.MAX_SAFE_INTEGER) {return /^(0|[1-9][0-9]*)$/.test(v)&&integer(Number(v),max);}
  /** 문자열 배열과 고유 식별자를 검사한다. @param {unknown} value @param {number} max @param {(tokens:string[])=>boolean} check @returns {value is string[]} */
  function tuples(value,max,check) {
    if(!Array.isArray(value)||value.length>max)return false;
    const ids=new Set();
    return value.every(item=>{
      if(typeof item!=='string')return false;
      const parts=item.split(':');
      if(ids.has(parts[0])||!check(parts))return false;
      ids.add(parts[0]);return true;
    });
  }
  /** 외부 저장은 null·버전·손상을 별도 분기로 반환한다. @param {RpgKey} key @param {unknown} raw @returns {RpgDecoded} */
  function decode(key,raw) {
    if(raw===null)return {status:'missing'};
    if(!record(raw)||!Object.hasOwn(raw,'v'))return {status:'invalid_state',message:'저장 객체나 버전이 없어요'};
    if(raw.v!==2)return {status:'unsupported_version',version:raw.v};
    const fields={rpg_meta:['v','mapVersion','seed','initialized','migrated'],rpg_world:['v','items','legacyFruit'],rpg_collection:['v','species','nodes','fishing','completed'],rpg_residents:['v','items'],rpg_player:['v','mapVersion','x','y','direction','outfit','t']};
    if(Object.keys(raw).some(field=>!fields[key].includes(field)))return {status:'invalid_state',message:'알 수 없는 저장 필드가 있어요'};
    let valid=false;
    const occupied=new Set();
    switch(key) {
      case 'rpg_meta':
        valid=raw.mapVersion===1&&integer(raw.seed,4294967295)&&raw.initialized===true&&typeof raw.migrated==='boolean';break;
      case 'rpg_world':
        valid=integer(raw.legacyFruit)&&tuples(raw.items,48,p=>{
          if(!token(p[0],47)||!['p','w','c'].includes(p[1]))return false;
          if(p.length===3&&p[2]==='b')return true;
          if(p.length!==4||!token(p[2],31)||!token(p[3],23))return false;
          const cell=p[2]+','+p[3];if(occupied.has(cell))return false;occupied.add(cell);return true;
        });break;
      case 'rpg_collection':
        valid=tuples(raw.species,16,p=>(p.length===3||p.length===4&&/^(node-([0-9]|1[01])|pot-([0-9]|[1-3][0-9]|4[0-7])|fish-[0-2])$/.test(p[3]))&&/^s([0-9]|1[0-5])$/.test(p[0])&&token(p[1],99)&&token(p[2]))&&
          tuples(raw.nodes,60,p=>p.length===2&&(/^(node-([0-9]|1[01])|pot-([0-9]|[1-3][0-9]|4[0-7]))$/.test(p[0]))&&token(p[1]))&&
          Array.isArray(raw.fishing)&&raw.fishing.length===3&&raw.fishing.every(n=>integer(n,7))&&(raw.completed===undefined||raw.completed===true&&raw.species.length===16);break;
      case 'rpg_residents':
        valid=tuples(raw.items,3,p=>p.length===5&&/^r[0-2]$/.test(p[0])&&token(p[1],4095)&&token(p[2],23)&&token(p[3],4294967295)&&(p[4]==='b'||/^s([0-9]|1[0-5])$/.test(p[4])));break;
      case 'rpg_player':
        valid=raw.mapVersion===1&&integer(raw.x,511)&&integer(raw.y,383)&&integer(raw.direction,7)&&integer(raw.outfit,1)&&integer(raw.t);break;
    }
    if(!valid)return {status:'invalid_state',message:key+' 저장 형식이 손상되었어요'};
    // 고정 ASCII DTO의 실제 raw 길이를 저장 전에 검사한다.
    const json=JSON.stringify(raw);
    if(json.length>budgets[key]||/[^\x00-\x7f]/.test(json))return {status:'invalid_state',message:key+' 저장 크기나 문자 범위가 잘못됐어요'};
    return {status:'ok',value:/** @type {RpgSave} */(JSON.parse(json))};
  }
  /** 결정적인 신규 상태를 만든다. @returns {RpgData} */
  function initial() {
    return {rpg_meta:{v:2,mapVersion:1,seed:4821,initialized:true,migrated:false},
      rpg_world:{v:2,items:['0:p:3:20','1:w:4:20','2:c:5:20'],legacyFruit:0},
      rpg_collection:{v:2,species:[],nodes:[],fishing:[0,0,0]},rpg_residents:{v:2,items:[]},
      rpg_player:{v:2,mapVersion:1,x:120,y:296,direction:6,outfit:0,t:0}};
  }
  /** v1 원본을 읽기만 하며 손상 튜플도 이전을 중단한다. @param {unknown} raw @returns {{status:'ok',data:RpgData}|{status:'invalid_state'|'unsupported_version',message:string}} */
  function migrate(raw) {
    const result=BackyardCodec.createCodec().deserializeGarden(raw);
    if(result.status!=='ok')return {status:result.status,message:'예전 마당을 이전하지 못했어요'};
    if(result.warnings.length)return {status:'invalid_state',message:'예전 마당의 손상을 확인해 주세요'};
    const data=initial();data.rpg_meta.migrated=true;data.rpg_world.legacyFruit=result.garden.fruit;
    data.rpg_world.items=result.garden.placements.map((p,id)=>id+':'+p.kind+':'+(p.cell.col+3)+':'+(p.cell.row+15));
    data.rpg_collection.nodes=result.garden.placements.flatMap((p,id)=>p.kind==='p'?['pot-'+id+':'+p.readyAtSec]:[]);
    return {status:'ok',data};
  }
  /** 보관 물건까지 고정 슬롯으로 복원한다. @param {RpgWorld} world @returns {RpgOwned[]} */
  function owned(world) {return world.items.map(tuple=>{const [id,kind,col,row]=tuple.split(':');return {id,kind:kind==='p'?'pot':kind==='w'?'well':'chair',col:col==='b'?0:Number(col),row:col==='b'?0:Number(row),stored:col==='b'};});}
  /** 논리 물건을 world 튜플로 변환한다. @param {RpgOwned[]} items @param {number} legacyFruit @returns {RpgWorld} */
  function world(items,legacyFruit) {return {v:2,legacyFruit,items:items.map(i=>i.id+':'+(i.kind==='pot'?'p':i.kind==='well'?'w':'c')+':'+(i.stored?'b':i.col+':'+i.row))};}
  /** 화분 시각은 collection만 권위로 삼는다. @param {RpgCollection} collection @param {string} id */
  function potReadyAt(collection,id) {const value=collection.nodes.find(n=>n.split(':')[0]==='pot-'+id);return value?Number(value.split(':')[1]):0;}
  return Object.freeze({keys,budgets,decode,initial,migrate,owned,world,potReadyAt});
})();
