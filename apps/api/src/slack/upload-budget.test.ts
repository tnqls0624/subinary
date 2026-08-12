import { describe, expect, it } from 'vitest';

import { UploadMemoryBudget } from './upload-budget';

describe('UploadMemoryBudget — 동시 업로드 메모리 예산', () => {
  it('예산 안에서는 허용하고 넘으면 거절한다', () => {
    const budget = new UploadMemoryBudget(150, 50);
    expect(budget.capacity).toBe(3);
    const a = budget.tryAcquire();
    const b = budget.tryAcquire();
    const c = budget.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    // 넷째는 힙을 늘리지 않고 거절된다 — 이게 없어서 동시 업로드가 API를 죽였다.
    expect(budget.tryAcquire()).toBeNull();
    expect(budget.reserved).toBe(150);
  });

  it('해제하면 자리가 돌아온다', () => {
    const budget = new UploadMemoryBudget(100, 50);
    const a = budget.tryAcquire();
    budget.tryAcquire();
    expect(budget.tryAcquire()).toBeNull();
    a?.();
    expect(budget.reserved).toBe(50);
    expect(budget.tryAcquire()).not.toBeNull();
  });

  it('두 번 해제해도 예산이 늘어나지 않는다 (멱등)', () => {
    // 한 번이라도 이중 해제되면 상한이 무의미해진다.
    const budget = new UploadMemoryBudget(100, 50);
    const release = budget.tryAcquire();
    release?.();
    release?.();
    expect(budget.reserved).toBe(0);
    expect(budget.tryAcquire()).not.toBeNull();
    expect(budget.tryAcquire()).not.toBeNull();
    expect(budget.tryAcquire()).toBeNull();
  });

  it('예약은 실제 크기가 아니라 최악값(파일 1건 상한)으로 잡는다', () => {
    // 스트림을 다 읽기 전에는 크기를 모른다 — 모르는 값을 낙관적으로 가정하지 않는다.
    const budget = new UploadMemoryBudget(50, 50);
    expect(budget.tryAcquire()).not.toBeNull();
    expect(budget.reserved).toBe(50);
    expect(budget.tryAcquire()).toBeNull();
  });
});
