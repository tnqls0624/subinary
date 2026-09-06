// @ts-check
/** @typedef {'p'|'w'|'c'} GardenKind */
/** @typedef {Readonly<{row:number,col:number}>} Cell */
/** @typedef {Readonly<{kind:'p',cell:Cell,readyAtSec:number}> | Readonly<{kind:'w'|'c',cell:Cell}>} Placement */
/** @typedef {Readonly<{lastSavedAtSec:number,seed:number,fruit:number,purchasedPots:number,unlocked:readonly GardenKind[],placements:readonly Placement[]}>} Garden */
/** @typedef {{type:'harvest',cell:Cell}|{type:'buyAndPlace',kind:GardenKind,cell:Cell}|{type:'move',from:Cell,to:Cell}} Action */
/** @typedef {{type:'harvested'|'placed'|'moved'|'swapped',cell:Cell}|{type:'unlocked',kind:GardenKind}|{type:'completed'}} GardenEvent */
/** @typedef {{status:'ok',garden:Garden,events:readonly GardenEvent[]}|{status:'noop',garden:Garden}|{status:'error',code:string,message:string}} ActionResult */
/** 엔진과 저장소에 의존하지 않는 규칙 팩토리다. */
var BackyardRules = (() => {
  /** @returns {ReturnType<typeof buildRules>} 규칙 API를 생성한다. */
  function createRules() { return buildRules(); }
  function buildRules() {
    const balance = BackyardBalance.createBalance();
    /** @param {unknown} value @returns {value is number} 음이 아닌 안전 정수인지 확인한다. */
    function isSafeInteger(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
    /** @param {Cell} cell @returns {boolean} 격자 범위를 검사한다. */
    function isCell(cell) {
      return !!cell && Number.isInteger(cell.row) && Number.isInteger(cell.col) &&
        cell.row >= 0 && cell.row < balance.rows && cell.col >= 0 && cell.col < balance.cols;
    }
    /** @param {Cell} a @param {Cell} b @returns {boolean} 같은 논리 칸인지 확인한다. */
    function sameCell(a, b) { return a.row === b.row && a.col === b.col; }
    /** @param {Cell} a @param {Cell} b @returns {boolean} 상하좌우 인접만 허용한다. */
    function isAdjacent(a, b) { return isCell(a) && isCell(b) && Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1; }
    /** @param {Garden} garden @returns {Garden} 외부에서 상태를 변경하지 못하도록 복사하여 동결한다. */
    function freezeGarden(garden) {
      return Object.freeze({ ...garden,
        unlocked: Object.freeze([...garden.unlocked]),
        placements: Object.freeze(garden.placements.map(p => Object.freeze({ ...p, cell: Object.freeze({ ...p.cell }) }))),
      });
    }
    /** @param {number} nowSec @param {number} seed @returns {Garden} 익은 증정 화분 세 개로 시작한다. */
    function createInitialGarden(nowSec, seed) {
      if (!isSafeInteger(nowSec) || !isSafeInteger(seed) || seed > 4294967295) throw new RangeError('시각 또는 시드가 허용 범위를 벗어났어요');
      return freezeGarden({lastSavedAtSec: nowSec, seed, fruit: 0, purchasedPots: 0, unlocked: ['p','w'],
        placements: Array.from({length: balance.initialPots}, (_, col) => ({kind:'p',cell:{row:0,col},readyAtSec:nowSec})),
      });
    }
    /** @param {number} purchasedCount @returns {number} 증정 화분을 제외한 구매 횟수로 가격을 조회한다. */
    function potPrice(purchasedCount) { return balance.potPrices[purchasedCount] ?? balance.potPrices[balance.potPrices.length - 1]; }
    /** @param {Garden} garden @param {Cell} cell @returns {number} 우물은 여러 개여도 한 번만 가속한다. */
    function growthDuration(garden, cell) { return garden.placements.some(p => p.kind === 'w' && isAdjacent(p.cell, cell)) ? balance.boostedGrowthSec : balance.growthSec; }
    /** @param {readonly GardenKind[]} history @param {readonly Placement[]} placements @returns {GardenKind[]} 해금 이력을 보존하고 배치로 증명되는 해금을 보충한다. */
    function normalizeUnlocked(history, placements) {
      const kinds = new Set(history);
      kinds.add('p');
      if (placements.filter(p => p.kind === 'p').length >= balance.initialPots) kinds.add('w');
      if (placements.some(p => p.kind === 'w')) { kinds.add('w'); kinds.add('c'); }
      /** @type {GardenKind[]} */ const order = ['p','w','c'];
      return order.filter(kind => kinds.has(kind));
    }
    /** @param {Garden} garden @returns {boolean} 별도 저장 필드 없이 완료를 판정한다. */
    function isComplete(garden) { return garden.placements.length === balance.capacity && ['p','w','c'].every(kind => garden.unlocked.some(k => k === kind)); }
    /** @param {string} code @param {string} message @returns {ActionResult} 실패에는 새 상태를 만들지 않는다. */
    function fail(code, message) { return {status:'error',code,message}; }
    /** @param {Garden} garden @param {Action} action @param {number} nowSec @returns {ActionResult} 확정 행동 하나를 원자적으로 적용한다. */
    function applyAction(garden, action, nowSec) {
      if (!isSafeInteger(nowSec)) return fail('invalid_time','시각이 올바르지 않아요');
      const now = Math.max(nowSec, garden.lastSavedAtSec);
      const placements = [...garden.placements];
      let fruit = garden.fruit;
      let purchasedPots = garden.purchasedPots;
      /** @type {GardenEvent[]} */ const events = [];
      if (action.type === 'move') {
        if (!isCell(action.from) || !isCell(action.to)) return fail('invalid_cell','마당 밖으로 옮길 수 없어요');
        const source = placements.findIndex(p => sameCell(p.cell, action.from));
        if (source < 0) return fail('empty_source','옮길 물건이 없어요');
        if (sameCell(action.from, action.to)) return {status:'noop',garden};
        const target = placements.findIndex(p => sameCell(p.cell, action.to));
        const item = placements[source];
        if (target >= 0) placements[target] = {...placements[target],cell:{...action.from}};
        placements[source] = {...item,cell:{...action.to}};
        events.push({type:target >= 0 ? 'swapped' : 'moved',cell:action.to});
      } else if (action.type === 'harvest' || action.type === 'buyAndPlace') {
        if (!isCell(action.cell)) return fail('invalid_cell','마당 안의 칸을 골라 주세요');
        const index = placements.findIndex(p => sameCell(p.cell, action.cell));
        if (action.type === 'harvest') {
          const item = placements[index];
          if (!item || item.kind !== 'p') return fail('not_pot','거둘 화분이 없어요');
          if (now < item.readyAtSec) return fail('not_ready','아직 익지 않았어요');
          const readyAtSec = now + growthDuration(garden, action.cell);
          if (!isSafeInteger(fruit + balance.harvestFruit) || !isSafeInteger(readyAtSec)) return fail('overflow','열매 또는 성장 시각의 저장 범위를 넘었어요');
          fruit += balance.harvestFruit;
          placements[index] = {...item,readyAtSec};
          events.push({type:'harvested',cell:action.cell});
        } else {
          if (!['p','w','c'].includes(action.kind)) return fail('invalid_kind','알 수 없는 물건이에요');
          if (index >= 0) return fail('occupied','이미 물건이 있는 칸이에요');
          if (!garden.unlocked.includes(action.kind)) return fail('locked','아직 해금되지 않았어요');
          const price = action.kind === 'p' ? potPrice(purchasedPots) : action.kind === 'w' ? balance.wellPrice : balance.chairPrice;
          if (fruit < price) return fail('insufficient_fruit','열매가 부족해요');
          if (action.kind === 'p') {
            const readyAtSec = now + growthDuration(garden, action.cell);
            if (!isSafeInteger(readyAtSec) || purchasedPots >= 16) return fail('overflow','구매 횟수 또는 성장 시각의 저장 범위를 넘었어요');
            placements.push({kind:'p',cell:{...action.cell},readyAtSec});
            purchasedPots += 1;
          } else placements.push({kind:action.kind,cell:{...action.cell}});
          fruit -= price;
          events.push({type:'placed',cell:action.cell});
        }
      } else return fail('invalid_action','알 수 없는 행동이에요');
      const unlocked = normalizeUnlocked(garden.unlocked, placements);
      for (const kind of unlocked) if (!garden.unlocked.includes(kind)) events.push({type:'unlocked',kind});
      const next = freezeGarden({...garden,fruit,purchasedPots,placements,unlocked});
      if (!isComplete(garden) && isComplete(next)) events.push({type:'completed'});
      return {status:'ok',garden:next,events};
    }
    return Object.freeze({createInitialGarden,potPrice,applyAction,isCell,isAdjacent,sameCell,growthDuration,isComplete,normalizeUnlocked,freezeGarden,isSafeInteger});
  }
  return Object.freeze({ createRules });
})();
