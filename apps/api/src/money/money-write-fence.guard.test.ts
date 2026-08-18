/**
 * 쓰기 펜스 가드 테스트.
 *
 * 이 파일이 지키는 것은 두 가지다.
 *  1. **기본값(펜스 꺼짐)에서 동작이 0 변화** — 통과시키고 아무 헤더도 건드리지 않는다.
 *  2. 켜졌을 때 **503 + Retry-After + 한국어 문구**.
 */
import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MONEY_FENCE_MESSAGE_KO } from '@family/shared';

import type { MoneyRuntimeService } from './money-runtime.service';
import { MoneyWriteFenceGuard } from './money-write-fence.guard';

/** 최소 ExecutionContext 더블 — 가드가 실제로 쓰는 것만 채운다. */
function contextDouble() {
  const header = vi.fn();
  const context = {
    switchToHttp: () => ({ getResponse: () => ({ header }) }),
    getClass: () => ({ name: 'TransactionController' }),
    getHandler: () => ({ name: 'update' }),
  } as unknown as ExecutionContext;
  return { context, header };
}

function runtimeDouble(fenceOn: boolean, ttl: number | null = null) {
  return {
    isWriteFenceOn: vi.fn().mockResolvedValue(fenceOn),
    fenceTtlSeconds: vi.fn().mockResolvedValue(ttl),
  } as unknown as MoneyRuntimeService;
}

describe('펜스 꺼짐 — 현재 동작(기본값)', () => {
  it('요청을 그대로 통과시킨다', async () => {
    const guard = new MoneyWriteFenceGuard(runtimeDouble(false));
    const { context, header } = contextDouble();
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('응답 헤더를 건드리지 않는다', async () => {
    const guard = new MoneyWriteFenceGuard(runtimeDouble(false));
    const { context, header } = contextDouble();
    await guard.canActivate(context);
    expect(header).not.toHaveBeenCalled();
  });

  it('TTL을 조회하지도 않는다 (불필요한 Redis 왕복 없음)', async () => {
    const runtime = runtimeDouble(false);
    const guard = new MoneyWriteFenceGuard(runtime);
    const { context } = contextDouble();
    await guard.canActivate(context);
    expect(runtime.fenceTtlSeconds).not.toHaveBeenCalled();
  });
});

describe('펜스 켜짐', () => {
  it('503을 던진다', async () => {
    const guard = new MoneyWriteFenceGuard(runtimeDouble(true));
    const { context } = contextDouble();
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('사용자 문구는 한국어다 — 영문 예외를 그대로 노출하지 않는다', async () => {
    const guard = new MoneyWriteFenceGuard(runtimeDouble(true));
    const { context } = contextDouble();
    try {
      await guard.canActivate(context);
      expect.unreachable('예외가 나야 한다');
    } catch (error) {
      const body = (error as ServiceUnavailableException).getResponse() as {
        message: string;
        errorCode: string;
        retryAfterSeconds: number;
      };
      expect(body.message).toBe(MONEY_FENCE_MESSAGE_KO);
      // 클라이언트가 문구가 아니라 코드로 분기할 수 있어야 한다.
      expect(body.errorCode).toBe('money_write_fenced');
    }
  });

  it('Retry-After 헤더에 남은 펜스 시간을 싣는다', async () => {
    const guard = new MoneyWriteFenceGuard(runtimeDouble(true, 42));
    const { context, header } = contextDouble();
    await expect(guard.canActivate(context)).rejects.toBeTruthy();
    expect(header).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('남은 시간을 모르면 기본값으로 안내한다 (헤더가 비지 않는다)', async () => {
    const guard = new MoneyWriteFenceGuard(runtimeDouble(true, null));
    const { context, header } = contextDouble();
    await expect(guard.canActivate(context)).rejects.toBeTruthy();
    const [[name, value]] = header.mock.calls;
    expect(name).toBe('Retry-After');
    expect(Number(value)).toBeGreaterThan(0);
  });

  it('header()가 없는 응답 객체에서도 죽지 않는다', async () => {
    // 어댑터가 바뀌거나 테스트 더블이 얇을 때 가드가 500을 만들면 안 된다 —
    // 펜스는 안전장치이므로 그 자신이 새 장애 원인이 되면 목적을 배반한다.
    const guard = new MoneyWriteFenceGuard(runtimeDouble(true, 10));
    const context = {
      switchToHttp: () => ({ getResponse: () => ({}) }),
      getClass: () => ({ name: 'C' }),
      getHandler: () => ({ name: 'h' }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
