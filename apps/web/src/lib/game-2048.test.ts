/**
 * 2048 합치기 규칙 — 미니앱(`public/miniapps/2048/index.html`)의 로직을 고정한다.
 *
 * 미니앱은 iframe 안의 별도 문서라 import할 수 없어서, 같은 알고리즘을 여기 옮겨
 * 검증한다. **규칙이 틀리기 쉬운 지점이 정해져 있고**(연쇄 합치기, 한 판 한 번,
 * 방향별 대칭) 그것들이 여기 고정돼 있으면 미니앱을 고칠 때 기준이 된다.
 *
 * 로직이 두 벌인 것은 인정된 비용이다. 대안은 미니앱을 번들 빌드로 만드는 것인데,
 * 게임이 둘뿐인 지금은 빌드 스텝 하나가 더 비싸다.
 */
import { describe, expect, it } from "vitest";

const SIZE = 4;

/** 한 줄을 왼쪽으로 밀어 합친다. 미니앱의 `slideRow`와 같다. */
function slideRow(row: number[]): { row: number[]; gained: number } {
  const nums = row.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < nums.length; i += 1) {
    if (nums[i] === nums[i + 1]) {
      const merged = (nums[i] as number) * 2;
      out.push(merged);
      gained += merged;
      i += 1;
    } else {
      out.push(nums[i] as number);
    }
  }
  while (out.length < SIZE) out.push(0);
  return { row: out, gained };
}

const rotate = (g: number[][]): number[][] =>
  (g[0] as number[]).map((_, c) => g.map((r) => r[c] as number).reverse());

function move(
  grid: number[][],
  dir: "left" | "right" | "up" | "down",
): { grid: number[][]; gained: number; moved: boolean } {
  let g = grid.map((r) => r.slice());
  const turns = { left: 0, up: 3, right: 2, down: 1 }[dir];
  for (let i = 0; i < turns; i += 1) g = rotate(g);
  let gained = 0;
  const next = g.map((r) => {
    const res = slideRow(r);
    gained += res.gained;
    return res.row;
  });
  let out = next;
  for (let i = 0; i < (4 - turns) % 4; i += 1) out = rotate(out);
  return {
    grid: out,
    gained,
    moved: JSON.stringify(out) !== JSON.stringify(grid),
  };
}

describe("slideRow — 합치기 규칙", () => {
  it("같은 두 수를 합치고 점수를 준다", () => {
    expect(slideRow([2, 2, 0, 0])).toEqual({ row: [4, 0, 0, 0], gained: 4 });
  });

  it("한 판에서 이미 합쳐진 칸은 다시 합쳐지지 않는다", () => {
    // [2,2,4]가 [8]이 되면 안 된다 — 4가 된 칸이 그 판에서 또 합쳐진 것이다.
    expect(slideRow([2, 2, 4, 0])).toEqual({ row: [4, 4, 0, 0], gained: 4 });
  });

  it("네 칸이 같으면 두 쌍으로 합쳐진다", () => {
    // [2,2,2,2] → [4,4]. [8]이 되면 연쇄 합치기 버그다.
    expect(slideRow([2, 2, 2, 2])).toEqual({ row: [4, 4, 0, 0], gained: 8 });
  });

  it("앞쪽 쌍을 먼저 합친다", () => {
    // [4,4,2,2] → [8,4]. 뒤에서부터 합치면 [4,8]이 된다.
    expect(slideRow([4, 4, 2, 2])).toEqual({ row: [8, 4, 0, 0], gained: 12 });
  });

  it("빈 칸을 건너뛰고 붙인다", () => {
    expect(slideRow([2, 0, 0, 2])).toEqual({ row: [4, 0, 0, 0], gained: 4 });
    expect(slideRow([0, 0, 2, 4])).toEqual({ row: [2, 4, 0, 0], gained: 0 });
  });

  it("다른 수는 합치지 않는다", () => {
    expect(slideRow([2, 4, 8, 16])).toEqual({
      row: [2, 4, 8, 16],
      gained: 0,
    });
  });
});

describe("move — 방향별 대칭", () => {
  const grid = [
    [2, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [4, 0, 0, 4],
  ];

  it("왼쪽으로 밀면 왼쪽에 모인다", () => {
    expect(move(grid, "left").grid[0]).toEqual([4, 0, 0, 0]);
    expect(move(grid, "left").grid[3]).toEqual([8, 0, 0, 0]);
  });

  it("오른쪽으로 밀면 오른쪽에 모인다", () => {
    // 방향마다 따로 구현하면 한 방향만 틀린 버그가 난다. 회전으로 환원하는 이유다.
    expect(move(grid, "right").grid[0]).toEqual([0, 0, 0, 4]);
    expect(move(grid, "right").grid[3]).toEqual([0, 0, 0, 8]);
  });

  it("위로 밀면 위에 모인다", () => {
    const g = [
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    expect(move(g, "up").grid[0]?.[0]).toBe(4);
    expect(move(g, "up").grid[1]?.[0]).toBe(0);
  });

  it("아래로 밀면 아래에 모인다", () => {
    const g = [
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    expect(move(g, "down").grid[3]?.[0]).toBe(4);
    expect(move(g, "down").grid[2]?.[0]).toBe(0);
  });

  it("네 방향 회전이 원래 모양을 보존한다", () => {
    // 회전 구현이 틀리면 판이 뒤집힌 채로 계속 돌아간다.
    let g = grid.map((r) => r.slice());
    for (let i = 0; i < 4; i += 1) g = rotate(g);
    expect(g).toEqual(grid);
  });
});

describe("move — 움직였는지 판정", () => {
  it("아무것도 안 바뀌면 moved가 false다", () => {
    // 새 타일은 실제로 움직였을 때만 생겨야 한다. 아니면 벽에 대고 스와이프하는
    // 것만으로 판이 채워져 게임이 끝난다.
    const packed = [
      [2, 4, 8, 16],
      [4, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 128],
    ];
    expect(move(packed, "left").moved).toBe(false);
  });

  it("한 칸이라도 움직이면 true다", () => {
    const g = [
      [0, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    expect(move(g, "left").moved).toBe(true);
  });

  it("합쳐지기만 해도 움직인 것이다", () => {
    const g = [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    expect(move(g, "left").moved).toBe(true);
    expect(move(g, "left").gained).toBe(4);
  });
});
