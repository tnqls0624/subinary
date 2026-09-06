import { describe, expect, it } from 'vitest';
import { cell, loadBackyard } from './game-backyard-test-utils';

const { codec, rules } = loadBackyard();
const raw = () => ({ v: 1, t: 1000, s: 42, f: 137, n: 9, k: ['p', 'w', 'c'], p: ['p:0:2000', 'w:9', 'c:11'] });
function encode(garden: Garden, now = 1000): GardenSaveV1 {
  const result = codec.serializeGarden(garden, now);
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result.value;
}
function decode(value: unknown) {
  const result = codec.deserializeGarden(value);
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result;
}

describe('실제 배포 codec 저장 계약', () => {
  it('정확한 객체 키·튜플 정렬·왕복·불변성과 역행 저장 시각을 유지한다', () => {
    const input = { ...raw(), k: ['c', 'p', 'w'], p: ['c:11', 'p:0:2000', 'w:9'] };
    const before = JSON.stringify(input);
    const garden = decode(input).garden;
    const saved = encode(garden, 500);
    expect(Object.keys(saved)).toEqual(['v', 't', 's', 'f', 'n', 'k', 'p']);
    expect(saved).toEqual(raw());
    expect(encode(decode(saved).garden, 500)).toEqual(saved);
    expect(JSON.stringify(input)).toBe(before);
    expect(garden.lastSavedAtSec).toBe(1000);
    expect(encode(garden, 2000).t).toBe(2000);
  });

  it.each([null, undefined, [], '문자열', 1, {}, { t: 0 }])('신규 판단 없이 상위 손상 %j를 거절한다', value => {
    expect(codec.deserializeGarden(value).status).toBe('invalid_state');
  });
  it.each([0, 2, '1', null, undefined])('존재하지만 모르는 버전 %j는 구분한다', version => {
    expect(codec.deserializeGarden({ ...raw(), v: version })).toEqual({ status: 'unsupported_version', version });
  });

  it.each(['t', 's', 'f', 'n'])('%s는 음수·소수·비유한·안전 정수 초과·누락을 거절한다', field => {
    for (const value of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, '1']) {
      expect(codec.deserializeGarden({ ...raw(), [field]: value })).toMatchObject({ status: 'invalid_state' });
    }
  });
  it.each([
    { s: 4294967296 }, { n: 17 }, { k: ['p', 'p'] }, { k: ['x'] }, { k: null },
    { k: 'p' }, { p: null }, { p: 'p:0:0' }, { p: Array(17).fill('w:0') },
  ])('컨테이너·범위 손상 %j를 거절한다', patch => {
    expect(codec.deserializeGarden({ ...raw(), ...patch }).status).toBe('invalid_state');
  });

  it('혼합 손상은 각 원소만 버리고 첫 유효 중복 칸과 자원·이력을 보존한다', () => {
    const input = { ...raw(), p: ['p:0:2000', 7, 'p:1:5junk', 'x:2', 'w:16', 'w:0', 'p:3:-1', 'w:9', 'c:11', 'p:2:3000'] };
    const before = JSON.stringify(input);
    const result = decode(input);
    expect(result.warnings.map(w => w.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.warnings.every(w => w.reason.length > 0)).toBe(true);
    expect(encode(result.garden)).toEqual({ ...raw(), p: ['p:0:2000', 'p:2:3000', 'w:9', 'c:11'] });
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(['p:1', 'w:1:2', 'c:1:', 'p:1:2:3', 'p:1:NaN', 'p:1:Infinity', 'p:1:9007199254740992', 'p:1:1.2', 'w:1junk', 'w:1e0', 'w:+1', 'w: 1', 'w:01', 'w:-1'])('튜플 전체 문법 %s를 검사한다', tuple => {
    const result = decode({ ...raw(), p: [tuple, 'c:1'] });
    expect(result.warnings).toHaveLength(1);
    expect(result.garden.placements).toEqual([{ kind: 'c', cell: cell(1) }]);
  });

  it('모든 튜플이 깨져도 증정 없이 기존 자원·구매·해금만 유지한다', () => {
    const result = decode({ ...raw(), p: ['bad', 'w:-1'] });
    expect(result.garden).toMatchObject({ fruit: 137, purchasedPots: 9, lastSavedAtSec: 1000, unlocked: ['p', 'w', 'c'], placements: [] });
    expect(result.warnings).toHaveLength(2);
  });

  it('유효 배치로 증명되는 해금을 보충하고 기존 해금은 지우지 않는다', () => {
    expect(decode({ ...raw(), k: ['p'], p: ['p:0:0', 'p:1:0', 'p:2:0'] }).garden.unlocked).toEqual(['p', 'w']);
    expect(decode({ ...raw(), k: ['p'], p: ['w:0'] }).garden.unlocked).toEqual(['p', 'w', 'c']);
    expect(decode({ ...raw(), p: [] }).garden.unlocked).toEqual(['p', 'w', 'c']);
  });

  it('직렬화는 중복 칸·불량 시각·상위 범위를 손실 없이 오류로 돌린다', () => {
    const garden = rules.createInitialGarden(1000, 42);
    expect(codec.serializeGarden({ ...garden, placements: [garden.placements[0], garden.placements[0]] }, 1000).status).toBe('invalid_state');
    expect(codec.serializeGarden({ ...garden, fruit: -1 }, 1000).status).toBe('invalid_state');
    expect(codec.serializeGarden(garden, NaN).status).toBe('invalid_state');
    expect(codec.serializeGarden({ ...garden, placements: [{ kind: 'p', cell: cell(16), readyAtSec: 0 }] }, 1000).status).toBe('invalid_state');
  });

  it('실제 codec 출력의 fixture별 바이트와 허용 최대 DTO를 출력한다', () => {
    const initial = rules.createInitialGarden(1757046000, 4821);
    const placements = (count: number, readyAtSec: number): Placement[] => Array.from({ length: 16 }, (_, index) =>
      index < count ? { kind: 'p', cell: cell(index), readyAtSec } : { kind: index === 9 ? 'w' : 'c', cell: cell(index) });
    const fixtures: Record<string, Garden> = {
      초기: initial,
      '9생산+7비생산': { ...initial, fruit: 137, purchasedPots: 9, unlocked: ['p', 'w', 'c'], placements: placements(9, 1757056800) },
      '16생산': { ...initial, purchasedPots: 13, placements: placements(16, 1757056800) },
      '안전정수최대+3종해금': { ...initial, lastSavedAtSec: Number.MAX_SAFE_INTEGER, seed: 4294967295, fruit: Number.MAX_SAFE_INTEGER, purchasedPots: 16, unlocked: ['p', 'w', 'c'], placements: placements(16, Number.MAX_SAFE_INTEGER) },
    };
    const sizes = Object.fromEntries(Object.entries(fixtures).map(([name, garden]) => {
      const dto = encode(garden, garden.lastSavedAtSec);
      expect(encode(decode(dto).garden, dto.t)).toEqual(dto);
      const bytes = Buffer.byteLength(JSON.stringify(dto), 'utf8');
      expect(bytes).toBeLessThanOrEqual(8192);
      return [name, bytes];
    }));
    process.stdout.write(`뒷마당 실제 DTO 바이트: ${JSON.stringify(sizes)} 최대: ${Math.max(...Object.values(sizes))}B\n`);
    // 모든 수치의 최대 자릿수, 모든 칸의 가장 긴 화분 튜플, 전체 해금으로 상한을 구성한다.
    expect(sizes['안전정수최대+3종해금']).toBe(469);
  });
});
