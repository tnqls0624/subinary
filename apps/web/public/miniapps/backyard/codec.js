// @ts-check
/** @typedef {{path:string,reason:string}} GardenIssue */
/** @typedef {{index:number,reason:string}} TupleIssue */
/** @typedef {Readonly<{v:1,t:number,s:number,f:number,n:number,k:readonly GardenKind[],p:readonly string[]}>} GardenSaveV1 */
/** @typedef {{status:'ok',value:GardenSaveV1}|{status:'invalid_state',issues:GardenIssue[]}} SerializeResult */
/** @typedef {{status:'ok',garden:Garden,warnings:TupleIssue[]}|{status:'unsupported_version',version:unknown}|{status:'invalid_state',issues:GardenIssue[]}} DeserializeResult */
/** 저장 객체와 게임 상태 사이의 순수 변환을 제공한다. */
var BackyardCodec = (() => {
  /** @returns {ReturnType<typeof buildCodec>} 검증기를 생성하며 저장소에 접근하지 않는다. */
  function createCodec() { return buildCodec(); }
  function buildCodec() {
    const rules = BackyardRules.createRules();
    const balance = BackyardBalance.createBalance();
    /** @param {unknown} value @returns {value is Record<string,unknown>} 객체 컨테이너를 검사한다. */
    function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]'; }
    /** @param {unknown} value @returns {value is GardenKind} 알려진 종류인지 확인한다. */
    function isKind(value) { return value === 'p' || value === 'w' || value === 'c'; }
    /** @param {string} token @returns {number|null} 정수 토큰 전체를 검사한다. */
    function integerToken(token) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return null;
      const value = Number(token);
      return rules.isSafeInteger(value) ? value : null;
    }
    /** @param {unknown} raw @returns {DeserializeResult} null과 상위 손상은 초기 상태로 바꾸지 않는다. */
    function deserializeGarden(raw) {
      /** @type {GardenIssue[]} */ const issues = [];
      if (!isRecord(raw)) return {status:'invalid_state',issues:[{path:'$',reason:'저장은 객체여야 해요'}]};
      if (!Object.prototype.hasOwnProperty.call(raw,'v')) return {status:'invalid_state',issues:[{path:'v',reason:'버전이 없어요'}]};
      if (raw.v !== 1) return {status:'unsupported_version',version:raw.v};
      const {t,s,f,n,k,p} = raw;
      for (const [path,value] of Object.entries({t,s,f,n})) {
        if (!rules.isSafeInteger(value)) issues.push({path,reason:'음이 아닌 안전 정수여야 해요'});
      }
      if (typeof s === 'number' && s > 4294967295) issues.push({path:'s',reason:'시드는 32비트 범위여야 해요'});
      if (typeof n === 'number' && n > 16) issues.push({path:'n',reason:'구매 횟수는 16 이하여야 해요'});
      if (!Array.isArray(k) || !k.every(isKind) || new Set(k).size !== k.length) issues.push({path:'k',reason:'해금 이력은 중복 없는 알려진 종류 배열이어야 해요'});
      if (!Array.isArray(p) || p.length > balance.capacity) issues.push({path:'p',reason:'배치 배열은 최대 16개여야 해요'});
      if (issues.length || !rules.isSafeInteger(t) || !rules.isSafeInteger(s) || !rules.isSafeInteger(f) || !rules.isSafeInteger(n) || !Array.isArray(k) || !k.every(isKind) || !Array.isArray(p)) return {status:'invalid_state',issues};
      /** @type {Placement[]} */ const placements = [];
      /** @type {TupleIssue[]} */ const warnings = [];
      const occupied = new Set();
      // 원본 순서대로 처리해야 중복 칸의 첫 유효 물건을 보존한다.
      for (let index = 0; index < p.length; index += 1) {
        const tuple = p[index];
        if (typeof tuple !== 'string') { warnings.push({index,reason:'튜플이 문자열이 아니에요'}); continue; }
        const tokens = tuple.split(':');
        const kind = tokens[0];
        if (!isKind(kind)) { warnings.push({index,reason:'알 수 없는 물건 종류예요'}); continue; }
        if (tokens.length !== (kind === 'p' ? 3 : 2)) { warnings.push({index,reason:'튜플의 토큰 수가 잘못됐어요'}); continue; }
        const cellIndex = integerToken(tokens[1]);
        if (cellIndex === null || cellIndex >= balance.capacity) { warnings.push({index,reason:'칸 번호가 올바르지 않아요'}); continue; }
        const readyAtSec = kind === 'p' ? integerToken(tokens[2]) : 0;
        if (readyAtSec === null) { warnings.push({index,reason:'익는 시각이 올바르지 않아요'}); continue; }
        if (occupied.has(cellIndex)) { warnings.push({index,reason:'중복 칸이에요'}); continue; }
        const cell = {row:Math.floor(cellIndex / balance.cols),col:cellIndex % balance.cols};
        placements.push(kind === 'p' ? {kind,cell,readyAtSec} : {kind,cell});
        occupied.add(cellIndex);
      }
      return {status:'ok',garden:rules.freezeGarden({lastSavedAtSec:t,seed:s,fruit:f,purchasedPots:n,unlocked:rules.normalizeUnlocked(k,placements),placements}),warnings};
    }
    /** @param {Garden} garden @param {number} savedAtSec @returns {SerializeResult} 새 객체로 정규화하며 입력을 변경하지 않는다. */
    function serializeGarden(garden, savedAtSec) {
      /** @type {GardenIssue[]} */ const issues = [];
      if (!garden || !rules.isSafeInteger(savedAtSec) || !rules.isSafeInteger(garden.lastSavedAtSec)) return {status:'invalid_state',issues:[{path:'t',reason:'저장 시각이 올바르지 않아요'}]};
      if (!Array.isArray(garden.placements) || garden.placements.length > balance.capacity) return {status:'invalid_state',issues:[{path:'placements',reason:'배치 배열이 올바르지 않아요'}]};
      /** @type {string[]} */ const tuples = [];
      const occupied = new Set();
      for (let index = 0; index < garden.placements.length; index += 1) {
        const item = garden.placements[index];
        if (!item || !isKind(item.kind) || !rules.isCell(item.cell) || (item.kind === 'p' && !rules.isSafeInteger(item.readyAtSec))) { issues.push({path:`placements.${index}`,reason:'물건의 종류·칸·시각이 올바르지 않아요'}); continue; }
        const cellIndex = item.cell.row * balance.cols + item.cell.col;
        if (occupied.has(cellIndex)) issues.push({path:`placements.${index}`,reason:'중복 칸이에요'});
        occupied.add(cellIndex);
        tuples.push(item.kind === 'p' ? `p:${cellIndex}:${item.readyAtSec}` : `${item.kind}:${cellIndex}`);
      }
      if (issues.length) return {status:'invalid_state',issues};
      tuples.sort((a,b) => Number(a.split(':')[1]) - Number(b.split(':')[1]));
      const candidate = {v:1,t:Math.max(garden.lastSavedAtSec,savedAtSec),s:garden.seed,f:garden.fruit,n:garden.purchasedPots,k:garden.unlocked,p:tuples};
      const checked = deserializeGarden(candidate);
      if (checked.status !== 'ok') return {status:'invalid_state',issues:checked.status === 'invalid_state' ? checked.issues : [{path:'v',reason:'저장 버전이 올바르지 않아요'}]};
      return {status:'ok',value:Object.freeze({v:1,t:candidate.t,s:candidate.s,f:candidate.f,n:candidate.n,k:Object.freeze([...checked.garden.unlocked]),p:Object.freeze(tuples)})};
    }
    return Object.freeze({serializeGarden,deserializeGarden});
  }
  return Object.freeze({createCodec});
})();
