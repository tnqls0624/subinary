import 'reflect-metadata';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import type { RequestWithUser } from '../decorators/current-user.decorator';
import { AccessTokenGuard } from './access-token.guard';

const U = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function setup(payload: Record<string, unknown> = { sub: U, email: 'synthetic@example.invalid' }) {
  const request = { headers: { authorization: 'Bearer synthetic-test-token' } } as unknown as RequestWithUser;
  const verifyAsync = vi.fn(async () => payload);
  const getAllAndOverride = vi.fn(() => false);
  const config = { get: vi.fn(() => ({ accessSecret: 'synthetic-test-secret' })) } as unknown as ConfigService;
  const guard = new AccessTokenGuard({ getAllAndOverride } as unknown as Reflector, { verifyAsync } as unknown as JwtService, config);
  const context = { getHandler: () => function handler() {}, getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { guard, request, verifyAsync, getAllAndOverride, context };
}

describe('verified access-token expiry metadata', () => {
  it('copies only a successfully verified expiry and the existing principal fields', async () => {
    const { guard, request, verifyAsync, context } = setup({ sub: U, email: 'synthetic@example.invalid', exp: 1_800_000_000.125, extra: 'not exposed' });
    expect(await guard.canActivate(context)).toBe(true);
    expect(verifyAsync).toHaveBeenCalledWith('synthetic-test-token', { secret: 'synthetic-test-secret' });
    expect(request.user).toEqual({ userId: U, email: 'synthetic@example.invalid', accessTokenExpiresAt: 1_800_000_000_125 });
    expect(request.user).not.toHaveProperty('exp'); expect(request.user).not.toHaveProperty('extra');
    expect(request.user).not.toHaveProperty('token');
  });

  it('rounds fractional milliseconds down so the stream cannot outlive the verified NumericDate', async () => {
    const { guard, request, context } = setup({ sub: U, email: 'synthetic@example.invalid', exp: 1_800_000_000.1235 });
    await guard.canActivate(context);
    expect(request.user?.accessTokenExpiresAt).toBe(Math.floor(1_800_000_000.1235 * 1000));
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 'untrusted'])('preserves the existing principal shape when safe optional expiry metadata is absent (%s)', async exp => {
    const { guard, request, context } = setup({ sub: U, email: 'synthetic@example.invalid', exp });
    await guard.canActivate(context);
    expect(request.user).toEqual({ userId: U, email: 'synthetic@example.invalid' });
  });

  it('does not attach claims from a failed or expired token verification', async () => {
    const { guard, request, verifyAsync, context } = setup({ sub: U, email: 'synthetic@example.invalid', exp: 1 });
    verifyAsync.mockRejectedValueOnce(new Error('synthetic expired-token details'));
    const failed = guard.canActivate(context);
    await expect(failed).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(failed).rejects.toThrow('unauthorized'); expect(request.user).toBeUndefined();
  });

  it('continues to require bearer authentication on guarded routes', async () => {
    const { guard, request, verifyAsync, context } = setup();
    delete request.headers.authorization;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyAsync).not.toHaveBeenCalled(); expect(request.user).toBeUndefined();
  });

  it('does not change explicitly public-route authentication behavior', async () => {
    const { guard, request, verifyAsync, getAllAndOverride, context } = setup();
    getAllAndOverride.mockReturnValueOnce(true);
    expect(await guard.canActivate(context)).toBe(true);
    expect(verifyAsync).not.toHaveBeenCalled(); expect(request.user).toBeUndefined();
  });
});
