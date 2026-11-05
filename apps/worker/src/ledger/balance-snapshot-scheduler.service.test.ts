import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';

import {
  BalanceSnapshotSchedulerService,
  balanceSnapshotJobId,
  batchIdFromHourKey,
  kstHourKey,
} from './balance-snapshot-scheduler.service';

describe('balance snapshot hourKey helpers', () => {
  it('KST hourKey와 jobId·batchId가 결정적이다', () => {
    // 2026-11-05T00:30:00Z = KST 09:30 → hourKey 2026110509
    const now = new Date('2026-11-05T00:30:00.000Z');
    const hourKey = kstHourKey(now);
    expect(hourKey).toBe('2026110509');
    expect(balanceSnapshotJobId(hourKey)).toBe('balance-snapshot_2026110509');
    expect(batchIdFromHourKey(hourKey)).toEqual(batchIdFromHourKey(hourKey));
    expect(batchIdFromHourKey(hourKey)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('BalanceSnapshotSchedulerService', () => {
  it('같은 hourKey로 두 번 enqueue해도 jobId가 같고 두 번째는 enqueued:false', async () => {
    const add = vi
      .fn()
      .mockResolvedValueOnce({ id: 'job-1' })
      .mockRejectedValueOnce(new Error('Job balance-snapshot_2026110500 already exists'));
    const queue = { add } as unknown as Queue;
    const scheduler = new BalanceSnapshotSchedulerService(queue);

    const first = await scheduler.enqueueHour('2026110500');
    const second = await scheduler.enqueueHour('2026110500');

    expect(first).toEqual({
      jobId: 'balance-snapshot_2026110500',
      enqueued: true,
    });
    expect(second).toEqual({
      jobId: 'balance-snapshot_2026110500',
      enqueued: false,
    });
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0]?.[2]).toMatchObject({
      jobId: 'balance-snapshot_2026110500',
    });
    expect(add.mock.calls[0]?.[1]).toMatchObject({
      batchId: batchIdFromHourKey('2026110500'),
      hourKey: '2026110500',
    });
  });

  it('정각 창 밖 tick은 enqueue하지 않는다', async () => {
    const add = vi.fn();
    const scheduler = new BalanceSnapshotSchedulerService({
      add,
    } as unknown as Queue);
    // KST 09:30 → minute 30 > 5
    const result = await scheduler.tickAt(new Date('2026-11-05T00:30:00.000Z'));
    expect(result).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });

  it('정각 창 안 tick은 hourKey job을 넣는다', async () => {
    const add = vi.fn(async () => ({ id: 'ok' }));
    const scheduler = new BalanceSnapshotSchedulerService({
      add,
    } as unknown as Queue);
    // KST 09:03
    const result = await scheduler.tickAt(new Date('2026-11-05T00:03:00.000Z'));
    expect(result).toEqual({
      jobId: 'balance-snapshot_2026110509',
      enqueued: true,
    });
  });
});
