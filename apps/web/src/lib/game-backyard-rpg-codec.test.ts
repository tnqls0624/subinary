import { describe, expect, it } from 'vitest';
import { loadRpg } from './game-backyard-rpg-test-utils';
const { codec } = loadRpg();
const max = Number.MAX_SAFE_INTEGER;

describe('RPG 5키 codec', () => {
  it('빈 콘텐츠 경계와 초기 5키를 왕복한다', () => {
    const data = codec.initial();
    for (const key of codec.keys) {
      expect(codec.decode(key, data[key])).toEqual({ status: 'ok', value: data[key] });
      expect(codec.decode(key, null)).toEqual({ status: 'missing' });
      expect(codec.decode(key, undefined).status).toBe('invalid_state');
      expect(codec.decode(key, { v: 9 }).status).toBe('unsupported_version');
    }
  });
  it('최대 허용 키별 raw 바이트를 출력한다', () => {
    const data: RpgData = {
      rpg_meta: { v: 2, mapVersion: 1, seed: 4294967295, initialized: true, migrated: false },
      rpg_world: { v: 2, legacyFruit: max, items: Array.from({ length: 48 }, (_, i) => `${i}:p:${16 + i % 16}:${21 + Math.floor(i / 16)}`) },
      rpg_collection: {
        v: 2, species: Array.from({ length: 16 }, (_, i) => `s${i}:99:${max}:node-11`),
        nodes: [...Array.from({ length: 12 }, (_, i) => `node-${i}:${max}`), ...Array.from({ length: 48 }, (_, i) => `pot-${i}:${max}`)], fishing: [7, 7, 7], completed: true,
      },
      rpg_residents: { v: 2, items: Array.from({ length: 3 }, (_, i) => `r${i}:4095:23:4294967295:s15`) },
      rpg_player: { v: 2, mapVersion: 1, x: 511, y: 383, direction: 7, outfit: 1, t: max },
    };
    const bytes = Object.fromEntries(codec.keys.map(key => [key, Buffer.byteLength(JSON.stringify(data[key]), 'utf8')]));
    process.stdout.write('RPG 최대 canonical raw bytes: ' + JSON.stringify(bytes) + '\n');
    for (const key of codec.keys) {
      expect(codec.decode(key, data[key]).status, key).toBe('ok');
      expect(bytes[key]).toBeLessThanOrEqual(codec.budgets[key]);
    }
  });
  it.each([
    ['rpg_world', { v: 2, legacyFruit: 0, items: ['0:p:1junk:20'] }],
    ['rpg_world', { v: 2, legacyFruit: 0, items: ['0:p:b', '0:w:b'] }],
    ['rpg_world', { v: 2, legacyFruit: 0, items: ['0:p:1:20', '1:w:1:20'] }],
    ['rpg_world', { v: 2, legacyFruit: 0, items: ['48:p:b'] }],
    ['rpg_world', { v: 2, legacyFruit: 0, items: ['0:p:1:20:1000'] }],
    ['rpg_collection', { v: 2, species: ['s16:1:0'], nodes: [], fishing: [0, 0, 0] }],
    ['rpg_collection', { v: 2, species: ['s0:100:0'], nodes: [], fishing: [0, 0, 0] }],
    ['rpg_collection', { v: 2, species: [], nodes: ['pot-48:0'], fishing: [0, 0, 0] }],
    ['rpg_collection', { v: 2, species: [], nodes: ['pot-0:0', 'pot-0:1'], fishing: [0, 0, 0] }],
    ['rpg_residents', { v: 2, items: ['r0:4096:0:0:b'] }],
    ['rpg_residents', { v: 2, items: ['r0:0:24:0:b'] }],
    ['rpg_residents', { v: 2, items: ['r0:0:0:0:b', 'r0:1:0:0:b'] }],
    ['rpg_player', { v: 2, mapVersion: 1, x: 512, y: 0, direction: 0, outfit: 0, t: 0 }],
    ['rpg_meta', { v: 2, mapVersion: 1, seed: 4821, initialized: false, migrated: false }],
  ] satisfies [RpgKey, unknown][])('%s 손상을 부분 삭제 없이 차단한다', (key, raw) => {
    expect(codec.decode(key, raw).status).toBe('invalid_state');
  });
  it('v1 배치·화분 시각·기념 열매를 보존하고 원본을 변경하지 않는다', () => {
    const raw = { v: 1, t: 1000, s: 1, f: 123, n: 0, k: ['p', 'w', 'c'], p: ['p:0:9999', 'w:15', 'c:4'] };
    const before = JSON.stringify(raw);
    const result = codec.migrate(raw);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.rpg_world).toEqual({ v: 2, legacyFruit: 123, items: ['0:p:3:15', '1:w:6:18', '2:c:3:16'] });
    expect(result.data.rpg_collection.nodes).toEqual(['pot-0:9999']);
    expect(result.data.rpg_meta).toMatchObject({ migrated: true, seed: 4821 });
    expect(JSON.stringify(raw)).toBe(before);
    expect(codec.migrate({ ...raw, p: ['p:0:9999', 'broken'] }).status).toBe('invalid_state');
    expect(codec.migrate({ ...raw, v: 7 }).status).toBe('unsupported_version');
  });
});
