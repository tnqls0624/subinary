/// <reference path="../../public/miniapps/backyard/rpg-rules.js" />
/// <reference path="../../public/miniapps/backyard/rpg-codec.js" />
/// <reference path="../../public/miniapps/backyard/rpg3d-world.js" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** 실제 배포 JS를 읽으며 규칙·대사·종을 테스트 안에 복제하지 않는다. */
function loadWorld() {
  const context = createContext({});
  for (const name of ['balance', 'rules', 'codec', 'rpg-rules', 'rpg-codec', 'rpg3d-world']) {
    const filename = resolve(import.meta.dirname, '../../public/miniapps/backyard', name + '.js');
    runInContext(readFileSync(filename, 'utf8'), context, { filename });
  }
  return {
    world: runInContext('BackyardRpg3dWorld', context) as typeof BackyardRpg3dWorld,
    life: runInContext('BackyardRpgLife', context) as typeof BackyardRpgLife,
    rules: runInContext('BackyardRpgRules', context) as typeof BackyardRpgRules,
    codec: runInContext('BackyardRpgCodec', context) as typeof BackyardRpgCodec,
  };
}

/** 저장 대신 커밋을 모으는 하니스. 키별 마지막 값이 그 키의 상태다. */
function harness(options: { now?: number; random?: number; locked?: boolean; suspended?: boolean } = {}) {
  const loaded = loadWorld();
  const commits: { key: string; value: unknown }[] = [];
  let data = loaded.codec.initial();
  // 규칙의 시계는 벽시계와 방문 날짜의 최댓값이다(역행 차단). 그보다 앞선 값을 써야
  // 주입한 시계가 이긴다 — 2030년 기준으로 두고 재생성 시각만 검사한다.
  let now = options.now ?? 1_900_000_000;
  let dirty = false;
  const state = { locked: options.locked ?? false, suspended: options.suspended ?? false };
  const core = loaded.world.create({
    now: () => now,
    random: () => options.random ?? 0,
    commit: (key, value) => {
      commits.push({ key, value });
      data = { ...data, [key]: value } as typeof data;
      dirty = true;
      return true;
    },
    locked: () => state.locked,
    suspended: () => state.suspended,
  });
  core.sync(data, true);
  /** 저장이 돌아오면 세션이 세계를 다시 맞춘다. 앱에서는 React 효과가 하는 일이다. */
  const flush = () => { if (!dirty) return; dirty = false; core.sync(data, false); };
  const world = {
    ...core,
    act: (point: RpgVector, direction: number) => { core.act(point, direction); flush(); },
    frame: (delta: number, point: RpgVector, direction: number) => { const snapshot = core.frame(delta, point, direction); flush(); return snapshot; },
    converse: (mode: 'talk' | 'sample' | 'sit', point: RpgVector) => { const result = core.converse(mode, point); flush(); return result; },
    store: (point: RpgVector, direction: number) => { core.store(point, direction); flush(); },
    move: (point: RpgVector, direction: number) => { core.move(point, direction); flush(); },
  };
  return {
    ...loaded, world, commits, state,
    data: () => data,
    /** 세션이 값을 되돌려준 것처럼 다시 맞춘다. */
    resync: () => core.sync(data, false),
    advance: (seconds: number) => { now += seconds; },
    setData: (next: Partial<ReturnType<typeof loaded.codec.initial>>) => { data = { ...data, ...next }; core.sync(data, false); },
  };
}
/** 100ms를 넘는 delta는 규칙이 버리므로 실제 프레임처럼 50ms씩 돌린다. */
function run(world: { frame: (delta: number, point: RpgVector, direction: number) => unknown }, ms: number, point: RpgVector, direction: number) {
  for (let left = ms; left > 0; left -= 50) world.frame(Math.min(50, left), point, direction);
}
/** 채집점 바로 아래에서 위(북)를 보고 서면 규칙이 그 대상을 고른다. */
const below = (target: { x: number; y: number }) => ({ point: { x: target.x, y: target.y + 24 }, direction: 6 });

describe('3D 걷기 세계의 콘텐츠 진행', () => {
  it('채집은 규칙이 계산한 종을 collection 한 키로만 저장한다', () => {
    const setup = harness();
    const node = setup.life.nodes[0];
    const { point, direction } = below(node);
    expect(setup.world.target(point, direction)?.id).toBe(node.id);
    setup.world.act(point, direction);
    // 채집은 즉시 확정되지 않는다. 손을 뻗는 시간이 지나야 저장된다.
    expect(setup.commits).toHaveLength(0);
    run(setup.world, 400, point, direction);
    expect(setup.commits.map(entry => entry.key)).toEqual(['rpg_collection']);
    const collection = setup.data().rpg_collection;
    expect(collection.species.find(tuple => tuple.startsWith('s' + node.species + ':'))).toContain(':1:');
    // 최초 획득 장소를 기록한다.
    expect(setup.life.recordPlace(collection.species.find(tuple => tuple.startsWith('s' + node.species + ':')), node.species)).toContain('채집');
    expect(collection.nodes.some(tuple => tuple.startsWith(node.id + ':'))).toBe(true);
  });

  it('재생성 시각 전에는 저장하지 않고 지난 뒤에 다시 획득한다', () => {
    const setup = harness();
    const node = setup.life.nodes.find(item => item.species >= 4);
    if (!node) throw Error('벌레 채집점이 없습니다');
    const { point, direction } = below(node);
    setup.world.act(point, direction);run(setup.world, 400, point, direction);
    expect(setup.commits).toHaveLength(1);
    // 딴 자리는 대상 목록에서 사라지고 표본도 감춰진다(2D와 같은 규칙).
    expect(setup.world.target(point, direction)).toBeNull();
    expect(setup.world.snapshot(point, direction).nodes.find(item => item.id === node.id)?.visible).toBe(false);
    setup.world.act(point, direction);
    expect(setup.world.snapshot(point, direction).hud.feedback).toBe('조금 더 다가가 바라봐 주세요');
    expect(setup.commits).toHaveLength(1);
    setup.advance(setup.life.regrowSeconds(node.id));setup.resync();
    setup.world.act(point, direction);run(setup.world, 400, point, direction);
    expect(setup.commits).toHaveLength(2);
  });

  it('열매는 3시간, 나머지는 60초 뒤에만 다시 열린다 — 시각 변경으로 재밸런싱하지 않는다', () => {
    const setup = harness();
    const fruit = setup.life.nodes.find(item => item.species < 2);
    if (!fruit) throw Error('열매 채집점이 없습니다');
    expect(setup.life.regrowSeconds(fruit.id)).toBe(10800);
    const { point, direction } = below(fruit);
    setup.world.act(point, direction);run(setup.world, 400, point, direction);
    expect(setup.commits).toHaveLength(1);
    setup.advance(60);setup.resync();
    // 60초로는 열매가 돌아오지 않는다. (반경 안의 다른 채집점은 그대로 잡힐 수 있다.)
    expect(setup.world.snapshot(point, direction).nodes.find(item => item.id === fruit.id)?.visible).toBe(false);
    setup.advance(10800 - 60);setup.resync();
    expect(setup.world.snapshot(point, direction).nodes.find(item => item.id === fruit.id)?.visible).toBe(true);
    expect(setup.world.target(point, direction)?.id).toBe(fruit.id);
    setup.world.act(point, direction);run(setup.world, 400, point, direction);
    expect(setup.commits).toHaveLength(2);
  });

  it('99개에서는 수량을 늘리지 않고 원본을 유지한다', () => {
    const setup = harness();
    const node = setup.life.nodes[0];
    setup.setData({ rpg_collection: { ...setup.data().rpg_collection, species: ['s' + node.species + ':99:100:' + node.id] } });
    const { point, direction } = below(node);
    setup.world.act(point, direction);
    expect(setup.commits).toHaveLength(0);
    expect(setup.world.snapshot(point, direction).hud.feedback).toContain('수량은 그대로예요');
  });

  it('입질은 버튼을 누를 때까지 유지되고 취소는 아무것도 잃지 않는다', () => {
    const setup = harness();
    const spot = setup.rules.sites.find(site => site.kind === 'fishing');
    if (!spot) throw Error('낚시점이 없습니다');
    const point = { x: spot.x - 24, y: spot.y }, direction = 0;
    setup.world.act(point, direction);
    expect(setup.world.snapshot(point, direction).fishing.phase).toBe('waiting');
    setup.world.frame(100, point, direction);
    for (let i = 0; i < 40; i++) setup.world.frame(100, point, direction);
    // 2~4초 뒤 입질이 오고 **시간 제한 없이** 유지된다.
    expect(setup.world.snapshot(point, direction).fishing.phase).toBe('bite');
    for (let i = 0; i < 600; i++) setup.world.frame(100, point, direction);
    expect(setup.world.snapshot(point, direction).fishing.phase).toBe('bite');
    const before = JSON.stringify(setup.data().rpg_collection);
    setup.world.cancelFishing();
    expect(setup.world.snapshot(point, direction).fishing.phase).toBe('idle');
    expect(JSON.stringify(setup.data().rpg_collection)).toBe(before);
    expect(setup.commits).toHaveLength(0);
  });

  it('끌어올리면 낚시 물고기 하나를 collection 한 키로 저장한다', () => {
    const setup = harness();
    const spot = setup.rules.sites.filter(site => site.kind === 'fishing')[0];
    const point = { x: spot.x - 24, y: spot.y }, direction = 0;
    setup.world.act(point, direction);
    for (let i = 0; i < 50; i++) setup.world.frame(100, point, direction);
    setup.world.act(point, direction);
    expect(setup.world.snapshot(point, direction).fishing.phase).toBe('pulling');
    for (let i = 0; i < 8; i++) setup.world.frame(100, point, direction);
    expect(setup.commits.map(entry => entry.key)).toEqual(['rpg_collection']);
    const caught = setup.data().rpg_collection.species[0];
    expect(setup.life.fishGroups[0].map(index => 's' + index)).toContain(caught.split(':')[0]);
    expect(caught.split(':')[3]).toBe('fish-0');
    expect(setup.world.snapshot(point, direction).card?.name).toBe(setup.life.species[Number(caught.split(':')[0].slice(1))].name);
  });

  it('대화는 규칙의 문장을 그대로 쓰고 관계 한 키만 저장하며 그 동안 이동을 멈춘다', () => {
    const setup = harness();
    const actor = setup.world.snapshot({ x: 0, y: 0 }, 0).actors[0];
    const point = { x: actor.x, y: actor.y + 24 }, direction = 6;
    setup.world.act(point, direction);
    const dialogue = setup.world.snapshot(point, direction).dialogue;
    const resident = setup.life.residents.find(item => item.id === actor.id);
    if (!resident || !dialogue) throw Error('주민 대화가 없습니다');
    expect([...resident.lines, ...setup.life.shared].some(line => line.split('{')[0] && dialogue.text.startsWith(line.split('{')[0]))).toBe(true);
    expect(dialogue.text).not.toMatch(/[{}]|undefined|null/);
    expect(dialogue.title).toContain(resident.name);
    expect(setup.commits.map(entry => entry.key)).toEqual(['rpg_residents']);
    expect(setup.world.busy()).toBe(true);
    // 대화 중에는 주민이 움직이지 않는다.
    const frozen = setup.world.frame(100, point, direction).actors.find(item => item.id === actor.id);
    expect(frozen?.x).toBe(actor.x);
    setup.world.closeDialogue();
    expect(setup.world.busy()).toBe(false);
    expect(setup.world.snapshot(point, direction).dialogue).toBeNull();
  });

  it('표본 없이 보여주기와 의자 없이 함께 앉기는 저장 없이 안내만 한다', () => {
    const setup = harness();
    const actor = setup.world.snapshot({ x: 0, y: 0 }, 0).actors[0];
    const point = { x: actor.x, y: actor.y + 24 }, direction = 6;
    setup.world.act(point, direction);
    const before = setup.commits.length;
    setup.world.converse('sample', point);
    expect(setup.world.snapshot(point, direction).dialogue?.text).toContain('표본을 하나 만난 뒤');
    setup.world.converse('sit', point);
    expect(setup.world.snapshot(point, direction).dialogue?.text).toContain('의자를 놓으면');
    expect(setup.commits).toHaveLength(before);
  });

  it('꾸미기는 거절 이유 문구를 함께 보여 주고 길을 막는 자리를 저장하지 않는다', () => {
    const setup = harness();
    const bench = setup.rules.sites.find(site => site.kind === 'workbench');
    if (!bench) throw Error('작업대가 없습니다');
    const point = { x: bench.x, y: bench.y + 24 }, direction = 6;
    setup.world.act(point, direction);
    expect(setup.world.snapshot(point, direction).editing).toBe(true);
    // 앞 칸이 길이면 색이 아니라 이유가 나온다.
    const onPath = { x: 240, y: 592 };
    const snapshot = setup.world.snapshot(onPath, 6);
    expect(snapshot.ghost).not.toBeNull();
    expect(snapshot.hud.placement).toContain('/48 (보관 포함)');
    setup.world.act(onPath, 6);
    expect(setup.commits).toHaveLength(0);
    expect(setup.world.snapshot(onPath, 6).hud.feedback).toMatch(/길·집 입구|비워 두세요/);
  });

  it('빈 칸에 놓으면 world 한 키만 저장하고 48개를 넘기지 않는다', () => {
    const setup = harness();
    const bench = setup.rules.sites.find(site => site.kind === 'workbench');
    if (!bench) throw Error('작업대가 없습니다');
    setup.world.openEditor();
    // 아래를 보고 서면 앞 칸은 한 줄 아래다.
    const point = { x: 112, y: 656 }, direction = 2;
    const cell = setup.rules.preview(point, direction);
    expect(setup.rules.placementReason([], cell, [point])).toBeNull();
    setup.world.act(point, direction);
    expect(setup.commits.map(entry => entry.key)).toEqual(['rpg_world']);
    // 신규 저장은 이미 화분·우물·의자 3개를 갖고 시작한다(codec.initial).
    expect(setup.codec.owned(setup.data().rpg_world)).toHaveLength(4);
    expect(setup.codec.owned(setup.data().rpg_world).some(item => item.col === cell.col && item.row === cell.row)).toBe(true);
    setup.resync();
    // 48개가 차면 새 물건을 만들지 않는다.
    setup.setData({ rpg_world: setup.codec.world(Array.from({ length: 48 }, (_, index) => ({ id: String(index), kind: 'pot', col: 0, row: 0, stored: true })), 0) });
    setup.world.openEditor();setup.world.choose('chair');
    const size = setup.commits.length;
    setup.world.act(point, direction);
    expect(setup.commits).toHaveLength(size);
    expect(setup.world.snapshot(point, direction).hud.feedback).toContain('보관 포함 48개예요');
  });

  it('화분은 익었을 때만 열매를 보여 주고 보관 중이면 목록에서 사라진다', () => {
    const setup = harness();
    setup.setData({ rpg_world: setup.codec.world([{ id: '0', kind: 'pot', col: 3, row: 20, stored: false }], 0) });
    const point = { x: 3 * 32 + 16, y: 21 * 32 + 16 }, direction = 6;
    expect(setup.world.snapshot(point, direction).decorations[0].ready).toBe(true);
    setup.world.act(point, direction);run(setup.world, 400, point, direction);
    expect(setup.commits.map(entry => entry.key)).toEqual(['rpg_collection']);
    expect(setup.world.snapshot(point, direction).decorations[0].ready).toBe(false);
    setup.setData({ rpg_world: setup.codec.world([{ id: '0', kind: 'pot', col: 3, row: 20, stored: true }], 0) });
    expect(setup.world.snapshot(point, direction).decorations).toHaveLength(0);
  });

  it('저장이 잠겨 있으면 획득·배치를 시작하지 않고 안내만 한다', () => {
    const setup = harness({ locked: true });
    const node = setup.life.nodes[0];
    const { point, direction } = below(node);
    setup.world.act(point, direction);
    expect(setup.commits).toHaveLength(0);
    expect(setup.world.snapshot(point, direction).hud.feedback).toContain('저장 후 계속할 수 있어요');
  });

  it('패널이 열려 있으면 행동도 진행도 없다', () => {
    const setup = harness({ suspended: true });
    const node = setup.life.nodes[0];
    const { point, direction } = below(node);
    setup.world.act(point, direction);
    expect(setup.commits).toHaveLength(0);
    const before = setup.world.snapshot(point, direction).actors[0];
    setup.world.frame(1000, point, direction);
    expect(setup.world.snapshot(point, direction).actors[0]).toEqual(before);
  });

  it('멀리서 바라보면 대상이 없고 등을 돌리면 잡히지 않는다', () => {
    const setup = harness();
    const node = setup.life.nodes[0];
    expect(setup.world.target({ x: node.x, y: node.y + 200 }, 6)).toBeNull();
    expect(setup.world.target({ x: node.x, y: node.y + 24 }, 2)).toBeNull();
  });

  it('16종 전부가 도감 순서와 같은 종 목록으로 노출된다', () => {
    const { life } = loadWorld();
    expect(life.species).toHaveLength(16);
    expect(new Set(life.species.map(item => item.index)).size).toBe(16);
    // 채집 8종과 낚시 8종이 각각 실제 획득 경로를 갖는다.
    expect(new Set(life.nodes.map(node => node.species)).size).toBe(8);
    expect(life.fishGroups.flat().sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('16종을 모두 채운 뒤 완료 표시를 한 번만 확정한다', () => {
    const setup = harness();
    const now = 1_600_000_000;
    setup.setData({ rpg_collection: { ...setup.data().rpg_collection, species: setup.life.species.map(item => item.id + ':1:' + now) } });
    // sync가 완료 표시를 저장하고, 저장이 돌아온 뒤 한 번 알린다.
    expect(setup.commits.map(entry => entry.key)).toEqual(['rpg_collection']);
    expect(setup.data().rpg_collection.completed).toBe(true);
    expect(setup.world.sync(setup.data(), false).completion).toBe(true);
    expect(setup.world.sync(setup.data(), false).completion).toBe(false);
    expect(setup.commits).toHaveLength(1);
  });

  it('비정상 delta는 진행을 건너뛰고 시계를 소비하지 않는다', () => {
    const setup = harness();
    const spot = setup.rules.sites.filter(site => site.kind === 'fishing')[0];
    const point = { x: spot.x - 24, y: spot.y }, direction = 0;
    setup.world.act(point, direction);
    const waiting = setup.world.snapshot(point, direction).fishing;
    for (const delta of [Number.NaN, -100, 5000]) setup.world.frame(delta, point, direction);
    expect(setup.world.snapshot(point, direction).fishing).toEqual(waiting);
  });

  it('주민 순회는 규칙의 walk 결과와 같고 위상은 실제 이동거리로만 늘어난다', () => {
    const setup = harness();
    const point = { x: 16, y: 16 }, direction = 0;
    const expected = setup.life.walkers(setup.world.visit().waypoint);
    const start = setup.world.snapshot(point, direction).actors;
    expect(start.map(actor => ({ x: actor.x, y: actor.y }))).toEqual(expected.map(actor => ({ x: actor.x, y: actor.y })));
    let reference = expected;
    for (let i = 0; i < 80; i++) {
      reference = reference.map(actor => setup.life.walk(actor, 100, [], false));
      setup.world.frame(100, point, direction);
    }
    const actors = setup.world.snapshot(point, direction).actors;
    expect(actors.map(actor => ({ x: actor.x, y: actor.y }))).toEqual(reference.map(actor => ({ x: actor.x, y: actor.y })));
    const moved = actors.find(actor => actor.distance > 0);
    expect(moved).toBeDefined();
    expect(moved?.shape).toMatch(/bear|bird|rabbit/);
  });

  it('보관과 이동은 앞의 물건이 없으면 저장 없이 안내만 한다', () => {
    const setup = harness();
    const spy = vi.fn();
    setup.setData({ rpg_world: setup.codec.world([{ id: '0', kind: 'chair', col: 3, row: 20, stored: false }], 0) });
    const away = { x: 900, y: 700 };
    setup.world.store(away, 0);
    expect(setup.world.snapshot(away, 0).hud.feedback).toContain('보관할 물건 가까이');
    setup.world.move(away, 0);
    expect(setup.world.snapshot(away, 0).hud.feedback).toContain('옮길 물건 가까이');
    expect(setup.commits).toHaveLength(0);
    // 앞에 두고 보면 world 한 키만 저장한다.
    const point = { x: 3 * 32 + 16, y: 21 * 32 + 16 };
    setup.world.store(point, 6);
    expect(setup.commits.map(entry => entry.key)).toEqual(['rpg_world']);
    expect(setup.codec.owned(setup.data().rpg_world)[0].stored).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
