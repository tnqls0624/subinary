/**
 * 스네이크·기억력 카드의 판정 규칙 — 미니앱 로직을 고정한다.
 *
 * 미니앱은 iframe 안의 별도 문서라 import할 수 없어서 같은 규칙을 여기 옮겨 검증한다.
 * **틀리기 쉬운 지점이 정해져 있고**(꼬리 충돌, 반대 방향 뒤집기, 기록 방향) 그것들이
 * 고정돼 있으면 미니앱을 고칠 때 기준이 된다.
 */
import { describe, expect, it } from "vitest";

type P = { x: number; y: number };
const N = 16;
const eq = (a: P, b: P) => a.x === b.x && a.y === b.y;

/** 다음 머리가 죽는가. 미니앱 `step()`의 판정과 같다. */
function isDeadly(snake: P[], head: P): boolean {
  const hitWall = head.x < 0 || head.y < 0 || head.x >= N || head.y >= N;
  // 꼬리 끝은 이번 틱에 비워지므로 충돌로 보지 않는다.
  const body = snake.slice(0, -1);
  return hitWall || body.some((s) => eq(s, head));
}

/** 이 방향으로 돌 수 있는가. 미니앱 `turn()`의 판정과 같다. */
function canTurn(dir: P, next: P): boolean {
  return !(next.x === -dir.x && next.y === -dir.y);
}

describe("스네이크 — 충돌 판정", () => {
  const snake: P[] = [
    { x: 5, y: 5 },
    { x: 4, y: 5 },
    { x: 3, y: 5 },
  ];

  it("벽에 닿으면 죽는다", () => {
    expect(isDeadly(snake, { x: -1, y: 5 })).toBe(true);
    expect(isDeadly(snake, { x: N, y: 5 })).toBe(true);
    expect(isDeadly(snake, { x: 5, y: -1 })).toBe(true);
    expect(isDeadly(snake, { x: 5, y: N })).toBe(true);
  });

  it("몸통에 닿으면 죽는다", () => {
    expect(isDeadly(snake, { x: 4, y: 5 })).toBe(true);
  });

  it("꼬리 끝은 충돌이 아니다 — 이번 틱에 비워진다", () => {
    // 이걸 충돌로 보면 꽉 붙어 따라가는 정상 플레이가 죽음이 된다.
    expect(isDeadly(snake, { x: 3, y: 5 })).toBe(false);
  });

  it("빈 칸으로 가면 살아 있다", () => {
    expect(isDeadly(snake, { x: 6, y: 5 })).toBe(false);
  });
});

describe("스네이크 — 방향 전환", () => {
  const right = { x: 1, y: 0 };

  it("반대 방향으로는 돌 수 없다 — 즉사 방지", () => {
    expect(canTurn(right, { x: -1, y: 0 })).toBe(false);
  });

  it("직각으로는 돌 수 있다", () => {
    expect(canTurn(right, { x: 0, y: 1 })).toBe(true);
    expect(canTurn(right, { x: 0, y: -1 })).toBe(true);
  });

  it("같은 방향은 허용한다(무해)", () => {
    expect(canTurn(right, right)).toBe(true);
  });

  it("판정 기준은 진행 방향이지 예약 방향이 아니다", () => {
    // 오른쪽으로 가는 중 위→왼쪽을 한 틱 안에 누르면, 예약 방향(위)과 비교할 경우
    // 왼쪽이 허용돼 자기 몸으로 들어간다. 그래서 항상 `dir`과 비교해야 한다.
    const dir = right;
    const queued = { x: 0, y: -1 }; // 위로 예약됨
    expect(canTurn(dir, { x: -1, y: 0 })).toBe(false); // 진행 방향 기준 → 막힘
    expect(canTurn(queued, { x: -1, y: 0 })).toBe(true); // 예약 기준이면 뚫린다
  });
});

describe("기억력 카드 — 기록 방향", () => {
  /** 이 게임은 **적을수록** 좋다. 미니앱 `isBetter`와 같다. */
  const isBetter = (next: number, prev: number | null) =>
    prev === null || next < prev;

  it("기록이 없으면 무엇이든 기록이다", () => {
    expect(isBetter(20, null)).toBe(true);
  });

  it("적은 시도가 더 좋은 기록이다", () => {
    // 2048·스네이크와 방향이 반대다. 한곳에 모아 두지 않으면 여기서 틀린다.
    expect(isBetter(12, 18)).toBe(true);
    expect(isBetter(18, 12)).toBe(false);
  });

  it("같은 값은 갱신하지 않는다", () => {
    expect(isBetter(12, 12)).toBe(false);
  });
});

describe("기억력 카드 — 덱 구성", () => {
  const FACES = ["🍎", "🍊", "🍇", "🍑", "🥝", "🍋", "🍓", "🫐"];

  it("모든 그림이 정확히 두 장씩이다", () => {
    // 홀수면 영원히 못 맞추는 카드가 남는다.
    const deck = [...FACES, ...FACES];
    expect(deck).toHaveLength(16);
    for (const face of FACES) {
      expect(deck.filter((f) => f === face)).toHaveLength(2);
    }
  });

  it("4열 격자에 정확히 들어간다", () => {
    expect(([...FACES, ...FACES].length % 4)).toBe(0);
  });
});
