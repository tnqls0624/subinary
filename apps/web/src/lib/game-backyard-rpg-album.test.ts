import { describe, expect, it } from 'vitest';
import { loadRpg } from './game-backyard-rpg-test-utils';
const { codec, life, rules } = loadRpg();

describe('도감·오늘 변주·완료의 저장 규칙', () => {
  it('신규 획득 장소를 최초 한 번 저장하고 다른 장소에서 모아도 유지한다', () => {
    const first = life.gather(codec.initial().rpg_collection, 'node-0', 1000);
    if (!first) throw Error('첫 채집 실패');
    const second = life.gather(first, 'node-1', 2000);
    expect(second?.species).toEqual(['s0:2:1000:node-0']);
    expect(life.recordPlace(second?.species[0], 0)).toBe('나무 그늘 · 채집 자리');
    const pot = life.gather(codec.initial().rpg_collection, 'pot-0', 1000, codec.owned(codec.initial().rpg_world));
    expect(life.recordPlace(pot?.species[0], 0)).toBe('집 앞 마당 · 화분');
    const fish = life.catchFish(codec.initial().rpg_collection, 0, 1000, 4821);
    expect(life.recordPlace(fish?.state.species[0], 13)).toBe('연못 북쪽 낚시점');
  });
  it('옛 3토큰은 추정 장소를 덧붙이지 않고 그대로 보존한다', () => {
    const old = { ...codec.initial().rpg_collection, species: ['s0:1:1000'] };
    expect(life.gather(old, 'node-0', 2000)?.species).toEqual(['s0:2:1000']);
    expect(life.recordPlace(old.species[0], 0)).toContain('장소 미기록');
  });
  it('종류 4·4·8 모두 힌트와 관찰문을 가진다', () => {
    expect(life.species.length).toBe(16);
    expect(life.hints).toHaveLength(16); expect(life.notes).toHaveLength(16);
    for (const text of [...life.hints, ...life.notes]) expect(text.trim().length).toBeGreaterThan(5);
  });
  it('30일 뒤에도 기존 발견·수량·최초 날짜·관계 감소 없이 16종만으로 완료한다', () => {
    let collection = codec.initial().rpg_collection;
    for (let i = 0; i < 16; i++) {
      expect(life.complete(collection)).toBe(false);
      const next = life.collect(collection, i, 1000);
      if (!next) throw Error('표본 생성 실패');
      collection = next;
    }
    expect(life.complete(collection)).toBe(true);
    const saved = JSON.stringify(collection), residents = { v: 2 as const, items: ['r0:3:1:0:b'] };
    life.today(1000 + 30 * 86400, 1000, 4821);
    expect(JSON.stringify(collection)).toBe(saved);
    expect(residents.items).toEqual(['r0:3:1:0:b']);
    expect(codec.decode('rpg_collection', { ...collection, completed: true }).status).toBe('ok');
    expect(life.complete({ ...collection, species: collection.species.slice(1) })).toBe(false);
  });
  it('날짜 역행을 저장 최대 시각으로 막고 세 변주는 모두 통행 가능한 장소다', () => {
    expect(life.today(1, 200000, 4821)).toEqual(life.today(200000, 200000, 4821));
    expect(new Set([0, 1, 2].map(day => life.today(day * 86400, 0, 4821).spot)).size).toBe(3);
    for (let variant = 0; variant < 3; variant++) {
      const nodes = life.dailyNodes(variant);
      expect(nodes.slice(0, 8)).toEqual(life.nodes.slice(0, 8));
      for (const node of nodes.slice(8)) expect(rules.canStand(node.x, node.y)).toBe(true);
      for (const walker of life.walkers(variant)) expect(rules.canStand(walker.x, walker.y)).toBe(true);
    }
    expect(life.dailyNodes(1).slice(8)).not.toEqual(life.dailyNodes(2).slice(8));
  });
  it.each(['s0:1:1000:node-12', 's0:1:1000:fish-3', 's0:1:1000:pot-48', 's0:1:1000:node-0:extra'])(
    '손상된 획득 장소 %s를 자동 삭제하지 않고 거절한다', tuple => {
      expect(codec.decode('rpg_collection', { ...codec.initial().rpg_collection, species: [tuple] }).status).toBe('invalid_state');
    },
  );
  it('미완료의 완료 표기와 열매 재생성 정수 넘침을 거절한다', () => {
    expect(codec.decode('rpg_collection', { ...codec.initial().rpg_collection, completed: true }).status).toBe('invalid_state');
    expect(life.gather(codec.initial().rpg_collection, 'node-0', Number.MAX_SAFE_INTEGER - 100)).toBeNull();
  });
});
