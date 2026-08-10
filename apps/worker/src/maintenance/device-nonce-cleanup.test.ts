/**
 * 만료 nonce 배치 정리 루프 회귀 테스트.
 *
 * 왜 이 함수를 테스트하는가: 종료 조건이 틀리면 두 방향으로 조용히 망가진다.
 * (1) 너무 일찍 끝나면 만료 행이 계속 쌓여 정리 잡이 "있는데 안 되는" 상태가 된다.
 * (2) 안 끝나면 한 tick이 DELETE를 무한 반복해 nonce 테이블을 계속 잠그고, 그 사이
 *     HMAC 인증 요청이 대기하다 실패한다 — 정리가 인증을 깎는다.
 * 둘 다 배포 후 한참 뒤에야 드러나므로 DB 없이 여기서 고정한다.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_BATCHES_PER_TICK,
  PURGE_BATCH_SIZE,
  purgeInBatches,
} from './device-nonce-cleanup.service';

/** 지울 행이 `total`개 있는 DB를 흉내낸다. 호출 횟수도 센다. */
function fakeDb(total: number, batchSize: number) {
  let remaining = total;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    deleteBatch: async (): Promise<number> => {
      calls += 1;
      const deleted = Math.min(remaining, batchSize);
      remaining -= deleted;
      return deleted;
    },
  };
}

describe('purgeInBatches', () => {
  it('지울 행이 없으면 쿼리 한 번으로 끝난다', async () => {
    const db = fakeDb(0, 10);
    const summary = await purgeInBatches(db.deleteBatch, 5, 10);

    expect(summary).toEqual({ deleted: 0, batches: 1, truncated: false });
    expect(db.calls).toBe(1);
  });

  it('부분 배치가 나오면 즉시 멈춘다(빈 쿼리를 한 번 더 내지 않는다)', async () => {
    const db = fakeDb(25, 10);
    const summary = await purgeInBatches(db.deleteBatch, 5, 10);

    // 10 + 10 + 5 → 세 번째가 배치 미만이라 종료. 0을 기다리면 네 번 나간다.
    expect(summary).toEqual({ deleted: 25, batches: 3, truncated: false });
    expect(db.calls).toBe(3);
  });

  it('배치 경계에 딱 맞으면 다음 tick으로 넘긴다', async () => {
    // 20행/배치 10 → 두 배치 모두 꽉 차므로 "더 있을 수 있다"고 봐야 한다.
    const db = fakeDb(20, 10);
    const summary = await purgeInBatches(db.deleteBatch, 5, 10);

    expect(summary.deleted).toBe(20);
    // 세 번째 호출이 0을 돌려주며 종료 — 경계에서 조기 종료하지 않는다.
    expect(summary.batches).toBe(3);
    expect(summary.truncated).toBe(false);
  });

  it('백로그가 크면 tick당 상한에서 잘리고 truncated로 알린다', async () => {
    const db = fakeDb(1_000, 10);
    const summary = await purgeInBatches(db.deleteBatch, 3, 10);

    expect(summary).toEqual({ deleted: 30, batches: 3, truncated: true });
    // 상한을 넘겨 계속 돌지 않는다 — 한 tick이 테이블을 오래 잠그면 인증이 막힌다.
    expect(db.calls).toBe(3);
  });

  it('기본 상한은 tick당 20,000행을 넘지 않는다', async () => {
    const db = fakeDb(10_000_000, PURGE_BATCH_SIZE);
    const summary = await purgeInBatches(db.deleteBatch);

    expect(summary.batches).toBe(MAX_BATCHES_PER_TICK);
    expect(summary.deleted).toBe(MAX_BATCHES_PER_TICK * PURGE_BATCH_SIZE);
    expect(summary.truncated).toBe(true);
  });
});
