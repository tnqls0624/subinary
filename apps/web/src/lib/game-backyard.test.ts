import { describe, expect, it } from 'vitest';
import { cell, loadBackyard, nextGarden } from './game-backyard-test-utils';

const { rules, balance } = loadBackyard();
const initial = () => rules.createInitialGarden(1000, 42);
const funded = (): Garden => ({ ...initial(), fruit: 10000 });
const harvest = (garden: Garden, index: number, now = 1000) => rules.applyAction(garden, { type: 'harvest', cell: cell(index) }, now);
const buy = (garden: Garden, kind: GardenKind, index: number, now = 1000) => rules.applyAction(garden, { type: 'buyAndPlace', kind, cell: cell(index) }, now);
const move = (garden: Garden, from: number, to: number) => rules.applyAction(garden, { type: 'move', from: cell(from), to: cell(to) }, 1000);

describe('배포되는 뒷마당 순수 규칙', () => {
  it('부팅 의존성 없이 시작 3수확 → 첫 가격 3 → 열매 0 루프를 돈다', () => {
    let garden = initial();
    expect(garden).toMatchObject({ seed: 42, fruit: 0, purchasedPots: 0, unlocked: ['p', 'w'] });
    expect(garden.placements).toEqual([0, 1, 2].map(index => ({ kind: 'p', cell: cell(index), readyAtSec: 1000 })));
    for (let index = 0; index < 3; index += 1) garden = nextGarden(harvest(garden, index));
    expect(garden.fruit).toBe(3);
    garden = nextGarden(buy(garden, 'p', 3));
    expect(garden.fruit).toBe(0);
    expect(garden.purchasedPots).toBe(1);
    expect(garden.placements).toHaveLength(4);
  });

  it('확정 가격표를 유지하고 정상 경로는 최대 13개 구매에 그친다', () => {
    expect(balance.potPrices).toEqual([3, 4, 6, 8, 11, 14, 18, 22, 27, 32, 38, 44, 51, 58, 66, 74]);
    balance.potPrices.forEach((price, index) => expect(rules.potPrice(index)).toBe(price));
    expect(rules.potPrice(16)).toBe(74);
    let garden = funded();
    for (let index = 3; index < 16; index += 1) garden = nextGarden(buy(garden, 'p', index));
    expect(garden.purchasedPots).toBe(13);
    expect(buy(garden, 'p', 0)).toMatchObject({ status: 'error', code: 'occupied' });
    expect(buy(garden, 'p', 16)).toMatchObject({ status: 'error', code: 'invalid_cell' });
    expect(rules.isComplete(garden)).toBe(false);
  });

  it.each([
    ['자원 부족', 'insufficient_fruit', { type: 'buyAndPlace', kind: 'p', cell: cell(3) }],
    ['점유 칸', 'occupied', { type: 'buyAndPlace', kind: 'p', cell: cell(0) }],
    ['미해금', 'locked', { type: 'buyAndPlace', kind: 'c', cell: cell(3) }],
    ['빈 출발', 'empty_source', { type: 'move', from: cell(3), to: cell(4) }],
    ['잘못된 칸', 'invalid_cell', { type: 'harvest', cell: { row: 0.5, col: 0 } }],
    ['없는 화분', 'not_pot', { type: 'harvest', cell: cell(15) }],
  ] as const)('%s 행동은 상태를 바꾸지 않는다', (_, code, action) => {
    const garden = initial();
    const before = JSON.stringify(garden);
    expect(rules.applyAction(garden, action, 1000)).toMatchObject({ status: 'error', code });
    expect(JSON.stringify(garden)).toBe(before);
  });

  it('3↔4 행 경계와 대각선은 인접이 아니다', () => {
    expect(rules.isAdjacent(cell(3), cell(4))).toBe(false);
    expect(rules.isAdjacent(cell(0), cell(5))).toBe(false);
    expect(rules.isAdjacent(cell(0), cell(4))).toBe(true);
    expect(rules.isAdjacent(cell(0), cell(1))).toBe(true);
    expect(rules.isAdjacent(cell(0), cell(0))).toBe(false);
  });

  it('우물은 중첩하지 않고 배치·수확 시 10800초 또는 8100초를 확정한다', () => {
    let garden = funded();
    garden = nextGarden(buy(garden, 'w', 4));
    garden = nextGarden(buy(garden, 'w', 6));
    garden = nextGarden(buy(garden, 'p', 5));
    expect(garden.placements.find(p => rules.sameCell(p.cell, cell(5)))).toMatchObject({ readyAtSec: 9100 });
    expect(nextGarden(harvest(garden, 0)).placements[0]).toMatchObject({ readyAtSec: 9100 });
    expect(nextGarden(harvest(garden, 1)).placements[1]).toMatchObject({ readyAtSec: 11800 });
    expect(harvest(nextGarden(harvest(garden, 0)), 0, 9099)).toMatchObject({ code: 'not_ready' });
    expect(harvest(nextGarden(harvest(garden, 0)), 0, 9100).status).toBe('ok');
  });

  it('장기 방치해도 화분당 1개만 얻으며 즉시 재수확은 실패한다', () => {
    const garden = nextGarden(harvest(initial(), 0, 10000000));
    expect(garden.fruit).toBe(1);
    expect(garden.placements[0]).toMatchObject({ readyAtSec: 10010800 });
    expect(harvest(garden, 0, 10000000)).toMatchObject({ code: 'not_ready' });
  });

  it('역행 시 저장 시각을 사용하고 성장 중인 기존 시각은 유지한다', () => {
    let garden = initial();
    garden = nextGarden(harvest(garden, 0, 500));
    expect(garden.placements[0]).toMatchObject({ readyAtSec: 11800 });
    expect(harvest(garden, 0, 999)).toMatchObject({ code: 'not_ready' });
    const bought = nextGarden(buy({ ...garden, fruit: 3 }, 'p', 3, 500));
    expect(bought.placements[3]).toMatchObject({ readyAtSec: 11800 });
  });

  it('우물 이동·화분 이동·swap은 현재 주기를 바꾸지 않고 다음 수확부터 적용한다', () => {
    let garden = nextGarden(harvest(funded(), 0));
    garden = nextGarden(buy(garden, 'w', 15));
    garden = nextGarden(move(garden, 15, 4));
    expect(garden.placements[0]).toMatchObject({ readyAtSec: 11800 });
    garden = nextGarden(move(garden, 0, 5));
    expect(garden.placements[0]).toMatchObject({ cell: cell(5), readyAtSec: 11800 });
    garden = nextGarden(harvest(garden, 5, 11800));
    expect(garden.placements[0]).toMatchObject({ readyAtSec: 19900 });
    garden = nextGarden(move(garden, 5, 4));
    expect(garden.placements[0]).toMatchObject({ cell: cell(4), readyAtSec: 19900 });
  });

  it('우물 배치가 의자를 해금하고 꽉 찬 마당도 두 물건을 보존하며 swap한다', () => {
    let garden = nextGarden(buy(funded(), 'w', 3));
    expect(garden.unlocked).toEqual(['p', 'w', 'c']);
    for (let index = 4; index < 16; index += 1) garden = nextGarden(buy(garden, 'c', index));
    expect(rules.isComplete(garden)).toBe(true);
    const old = JSON.stringify(garden);
    const swapped = nextGarden(move(garden, 0, 3));
    expect(swapped.placements[0]).toEqual({ kind: 'p', cell: cell(3), readyAtSec: 1000 });
    expect(swapped.placements[3]).toEqual({ kind: 'w', cell: cell(0) });
    expect(swapped.placements).toHaveLength(16);
    expect(swapped.fruit).toBe(garden.fruit);
    expect(JSON.stringify(garden)).toBe(old);
    expect(rules.isComplete(swapped)).toBe(true);
    expect(move(swapped, 0, 0)).toEqual({ status: 'noop', garden: swapped });
    expect(Object.isFrozen(swapped.placements[0].cell)).toBe(true);
  });

  it('시각·자원 오버플로와 잘못된 초기 입력을 명시적으로 거절한다', () => {
    expect(harvest({ ...initial(), fruit: Number.MAX_SAFE_INTEGER }, 0)).toMatchObject({ code: 'overflow' });
    expect(harvest(initial(), 0, Number.MAX_SAFE_INTEGER)).toMatchObject({ code: 'overflow' });
    expect(harvest(initial(), 0, NaN)).toMatchObject({ code: 'invalid_time' });
    expect(() => rules.createInitialGarden(-1, 0)).toThrow();
    expect(() => rules.createInitialGarden(0, 4294967296)).toThrow();
  });
});
