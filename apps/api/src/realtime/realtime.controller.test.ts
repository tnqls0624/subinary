import 'reflect-metadata';
import { BadRequestException, ForbiddenException, ServiceUnavailableException, UnauthorizedException, type MessageEvent } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { Observable, Subject, type Subscription } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@family/database';
import type { RealtimeEvent } from '@family/shared';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import type { RealtimeService } from './realtime.service';
import { RealtimeController } from './realtime.controller';

const H = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const M = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER: AuthenticatedUser = { userId: U, email: 'synthetic@example.invalid' };
const HINT: RealtimeEvent = { type: 'transactions.changed', v: 1 };
const SECOND_HINT: RealtimeEvent = { type: 'categories.changed', v: 1 };
const subscriptions: Subscription[] = [];
const flush = () => vi.advanceTimersByTimeAsync(0);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Real query construction/decoding, bounded in-memory results; no DB/Redis. */
function setup() {
  const state = { active: true, userDeleted: false, householdDeleted: false, incarnation: '100' };
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const read = vi.fn(async (): Promise<unknown[][]> => state.active && !state.userDeleted && !state.householdDeleted
    ? [[M, state.incarnation]] : []);
  const driver = { options: { parsers: {}, serializers: {} }, unsafe(text: string, params: unknown[]) {
    queries.push({ text, params });
    const result = Promise.resolve().then(() => read());
    return Object.assign(result, { values: () => result });
  } };
  const db = drizzle(driver as unknown as postgres.Sql, { schema });
  const hints = new Subject<RealtimeEvent>();
  let subscribers = 0;
  const events = new Observable<RealtimeEvent>(subscriber => {
    subscribers += 1;
    const sub = hints.subscribe(subscriber);
    return () => { sub.unsubscribe(); subscribers -= 1; };
  });
  const streamFor = vi.fn(() => events);
  const controller = new RealtimeController(db, { streamFor } as unknown as RealtimeService);
  return { controller, hints, state, queries, read, streamFor, subscribers: () => subscribers };
}

function observe(stream: Observable<MessageEvent>) {
  const seen: MessageEvent[] = [], complete = vi.fn(), error = vi.fn();
  const subscription = stream.subscribe({ next: event => seen.push(event), complete, error });
  subscriptions.push(subscription);
  return { seen, complete, error, subscription };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T15:00:00.000Z'));
});
afterEach(() => {
  for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
  vi.useRealTimers();
});

describe('SSE membership incarnation and event authorization', () => {
  it('validates query and principal before querying a membership', async () => {
    const { controller, read } = setup();
    await expect(controller.stream(USER, ['invalid'] as unknown as string)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.stream({ ...USER, userId: 'invalid' }, H)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(read).not.toHaveBeenCalled();
  });

  it('checks active membership, live user and live household on every emitted hint and heartbeat', async () => {
    const { controller, hints, read, queries, streamFor } = setup();
    const out = observe(await controller.stream(USER, H.toUpperCase()));
    hints.next(HINT); await flush();
    hints.next(SECOND_HINT); await flush();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(out.seen).toEqual([{ type: 'hint', data: HINT }, { type: 'hint', data: SECOND_HINT }, { type: 'heartbeat', data: { v: 1 } }]);
    expect(read).toHaveBeenCalledTimes(4);
    expect(streamFor).toHaveBeenCalledWith(H);
    for (const { text, params } of queries) {
      expect(text).toContain('"household_members".xmin::text');
      expect(text).toContain('inner join "users"');
      expect(text).toContain('inner join "households"');
      expect(text).toContain('"users"."deleted_at" is null');
      expect(text).toContain('"households"."deleted_at" is null');
      expect(params.slice(0, 3)).toEqual([H, U, 'active']);
    }
    expect(out.error).not.toHaveBeenCalled();
  });

  it.each(['active', 'userDeleted', 'householdDeleted'] as const)('completes before emitting after %s authorization is lost', async field => {
    const { controller, hints, state, subscribers } = setup();
    const out = observe(await controller.stream(USER, H));
    if (field === 'active') state.active = false; else state[field] = true;
    hints.next(HINT); await flush();
    expect(out.seen).toEqual([]); expect(out.complete).toHaveBeenCalledTimes(1);
    expect(out.error).not.toHaveBeenCalled(); expect(subscribers()).toBe(0);
  });

  it('also closes a quiet stream on the next heartbeat after membership removal', async () => {
    const { controller, state, subscribers } = setup();
    const out = observe(await controller.stream(USER, H)); state.active = false;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(out.seen).toEqual([]); expect(out.complete).toHaveBeenCalledTimes(1);
    expect(subscribers()).toBe(0);
  });

  it('does not resurrect the old stream after removal and rejoin with the same member ID or timestamp', async () => {
    const { controller, hints, state } = setup();
    const out = observe(await controller.stream(USER, H));
    // ID is unchanged. PostgreSQL incarnation changes independently of clock precision.
    state.incarnation = '102';
    hints.next(HINT); await flush();
    expect(out.seen).toEqual([]); expect(out.complete).toHaveBeenCalledTimes(1);
    hints.next(SECOND_HINT); await flush(); expect(out.seen).toEqual([]);
  });

  it('checks the incarnation when queued hints are consumed and discards the queue on revocation', async () => {
    const { controller, hints, state, read } = setup();
    const out = observe(await controller.stream(USER, H));
    const firstCheck = deferred<unknown[][]>();
    read.mockImplementationOnce(() => firstCheck.promise);
    hints.next(HINT); await flush();
    state.incarnation = '102';
    hints.next(SECOND_HINT);
    // The already in-flight read may finish from its earlier snapshot. The new
    // queued hint must receive a fresh check and cannot inherit that decision.
    firstCheck.resolve([[M, '100']]); await flush();
    expect(out.seen).toEqual([{ type: 'hint', data: HINT }]);
    expect(out.complete).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(3);
    hints.next(SECOND_HINT); await flush(); expect(out.seen).toHaveLength(1);
  });

  it('revalidates a returned stream if subscription is delayed until after rejoin', async () => {
    const { controller, hints, state } = setup();
    const stream = await controller.stream(USER, H); state.incarnation = '102';
    const out = observe(stream); hints.next(HINT); await flush();
    expect(out.seen).toEqual([]); expect(out.complete).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a membership-query failure without propagating SQL or private bind details', async () => {
    const { controller, hints, read, subscribers } = setup();
    const out = observe(await controller.stream(USER, H));
    read.mockRejectedValueOnce(new Error('synthetic SQL with private bind details'));
    hints.next(HINT); await flush();
    expect(out.seen).toEqual([]); expect(out.error).not.toHaveBeenCalled();
    expect(out.complete).toHaveBeenCalledTimes(1); expect(subscribers()).toBe(0);
  });

  it('sanitizes an initial database failure and refuses an absent membership', async () => {
    const { controller, read, streamFor, state } = setup();
    read.mockRejectedValueOnce(new Error('synthetic private SQL parameters'));
    const failed = controller.stream(USER, H);
    await expect(failed).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(failed).rejects.toThrow('stream unavailable');
    state.active = false;
    await expect(controller.stream(USER, H)).rejects.toBeInstanceOf(ForbiddenException);
    expect(streamFor).not.toHaveBeenCalled();
  });

  it('unsubscribes sources and discards an in-flight authorization result on client disconnect', async () => {
    const { controller, hints, read, subscribers } = setup();
    const out = observe(await controller.stream(USER, H));
    const pending = deferred<unknown[][]>(); read.mockImplementationOnce(() => pending.promise);
    hints.next(HINT); await flush(); out.subscription.unsubscribe();
    expect(subscribers()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    pending.resolve([[M, '100']]); await flush(); expect(out.seen).toEqual([]);
  });
});

describe('SSE verified JWT expiry', () => {
  it('rejects an already expired or invalid expiry before membership reads', async () => {
    const { controller, read } = setup();
    for (const accessTokenExpiresAt of [Date.now(), Date.now() - 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(controller.stream({ ...USER, accessTokenExpiresAt }, H)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('closes at the verified JWT expiry instead of starting a fresh 15-minute lifetime', async () => {
    const { controller, hints, subscribers } = setup();
    const out = observe(await controller.stream({ ...USER, accessTokenExpiresAt: Date.now() + 30_000 }, H));
    await vi.advanceTimersByTimeAsync(25_000); expect(out.seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000); expect(out.complete).toHaveBeenCalledTimes(1);
    expect(subscribers()).toBe(0); hints.next(HINT); await flush(); expect(out.seen).toHaveLength(1);
  });

  it.each([undefined, 3_600_000])('retains the 15-minute cap when expiry metadata is %s', async remaining => {
    const { controller, subscribers } = setup();
    const user = remaining === undefined ? USER : { ...USER, accessTokenExpiresAt: Date.now() + remaining };
    const out = observe(await controller.stream(user, H));
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(out.complete).toHaveBeenCalledTimes(1); expect(subscribers()).toBe(0);
    expect(out.error).not.toHaveBeenCalled();
  });

  it('does not subscribe to a source if the token expires before subscription', async () => {
    const { controller, subscribers } = setup();
    const stream = await controller.stream({ ...USER, accessTokenExpiresAt: Date.now() + 100 }, H);
    vi.setSystemTime(Date.now() + 100);
    const out = observe(stream); expect(out.complete).toHaveBeenCalledTimes(1);
    expect(subscribers()).toBe(0); expect(out.seen).toEqual([]);
  });

  it('rejects a token that expires while initial membership authorization is waiting', async () => {
    const { controller, read, streamFor } = setup();
    const pending = deferred<unknown[][]>(); read.mockImplementationOnce(() => pending.promise);
    const connecting = controller.stream({ ...USER, accessTokenExpiresAt: Date.now() + 100 }, H);
    await flush(); vi.setSystemTime(Date.now() + 100); pending.resolve([[M, '100']]);
    await expect(connecting).rejects.toBeInstanceOf(UnauthorizedException);
    expect(streamFor).not.toHaveBeenCalled();
  });

  it('checks expiry again after a slow authorization query without relying only on the timer', async () => {
    const { controller, hints, read } = setup();
    const out = observe(await controller.stream({ ...USER, accessTokenExpiresAt: Date.now() + 100 }, H));
    const pending = deferred<unknown[][]>(); read.mockImplementationOnce(() => pending.promise);
    hints.next(HINT); await flush(); vi.setSystemTime(Date.now() + 100);
    pending.resolve([[M, '100']]); await flush();
    expect(out.complete).toHaveBeenCalledTimes(1); expect(out.seen).toEqual([]);
  });
});
