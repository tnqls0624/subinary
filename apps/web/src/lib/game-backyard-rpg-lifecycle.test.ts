import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

/** 실제 React 호스트와 opaque iframe을 사용하고 의존성 누락·assert 실패를 skip하지 않는다. */
/*
 * 이 시험은 **2D iframe 호스트**의 20회 진입·이탈을 재도록 쓰였다. 백야드가 전체 화면
 * (game) 라우트로 옮겨지면서 iframe이 사라져 하네스의 대상
 * (`iframe >> #world[data-ready=true]`)이 존재하지 않는다.
 *
 * 3D 전체 화면 경로의 동등한 시험은 설계서(redesign-backyard-3d.md) §9의 **슬라이스 8**
 * — "20회 진입/이탈·context loss" — 이며 실기기 성능 측정과 함께 진행한다.
 *
 * 그때까지 이 시험은 건너뛴다. 하네스와 기대값을 지우지 않는 이유는 롤백 후보인 2D
 * 경로를 되살릴 때 그대로 필요하고, 무엇을 재던 시험인지가 기록으로 남아야 하기
 * 때문이다. **통과로 바꿔 쓰지 않는다.**
 */
it.skip('실제 호스트 RPG 20회 진입·이탈과 재시도·회전·가구/앱 경계에서 자원이 누적되지 않는다', async () => {
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ['scripts/verify-backyard/rpg-host-lifecycle.mjs'], {
    cwd: resolve(import.meta.dirname, '../../../..'), maxBuffer: 2 * 1024 * 1024,
  });
  const result: { cycles: unknown[]; realExit: { entries: number; detachedDocuments: number; remainingGameFrames: number }; normalErrors: string[] } = JSON.parse(stdout);
  expect(result.cycles).toHaveLength(20);
  expect(result.realExit).toMatchObject({ entries: 20, detachedDocuments: 20, remainingGameFrames: 0 });
  expect(result.normalErrors).toEqual([]);
}, 120_000);

/** 동일 문서 재생성은 실제 진입 경로와 구분하며 upstream 잔존 2개/Game을 숨기지 않는다. */
it('동일 문서 강제 재생성 20회의 Game·Scene 종료와 알려진 Phaser 리스너 +40을 기록한다', async () => {
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ['scripts/verify-backyard/rpg-lifecycle.mjs', '--characterize'], {
    cwd: resolve(import.meta.dirname, '../../../..'), maxBuffer: 2 * 1024 * 1024,
  });
  const result: { totals: { createdGames: number; destroyedGames: number; createdScenes: number; destroyedScenes: number }; final: { games: number; scenes: number; listeners: number; timers: number; raf: number; pointerListeners: number }; errors: string[] } = JSON.parse(stdout);
  expect(result.totals).toEqual({ createdGames: 20, destroyedGames: 20, createdScenes: 60, destroyedScenes: 60 });
  expect(result.final).toMatchObject({ games: 0, scenes: 0, listeners: 40, timers: 0, raf: 0, pointerListeners: 0 });
  expect(result.errors).toEqual([]);
}, 120_000);
