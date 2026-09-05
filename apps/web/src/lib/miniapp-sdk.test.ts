/**
 * 미니앱 SDK — 호스트가 답하지 않는 경우를 고정한다.
 *
 * 브릿지 버전이 어긋나 리스너가 없거나, 호스트 화면이 언마운트됐거나, 호스트가
 * 처리 중 크래시하면 응답이 오지 않는다. 타임아웃이 없으면 미니앱의 `await`가
 * 영원히 걸리고 화면은 로딩 상태로 멈춘 채 아무 말도 하지 않는다.
 */
import { describe, expect, it, vi } from 'vitest';

import { MINIAPP_BRIDGE_VERSION } from '@family/shared';
import { MiniappBridgeError, createMiniappClient } from './miniapp-sdk';

/** 호스트를 흉내내는 가짜 창 — 요청을 받아 정해진 응답을 돌려준다. */
function harness(
  respond?: (req: { requestId: string; method: string }) => unknown,
) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const sent: unknown[] = [];
  const source = {
    addEventListener: (_t: string, fn: EventListener) =>
      listeners.add(fn as (e: MessageEvent) => void),
    removeEventListener: (_t: string, fn: EventListener) =>
      listeners.delete(fn as (e: MessageEvent) => void),
  };
  const target = {
    postMessage: (message: unknown) => {
      sent.push(message);
      const req = message as { requestId: string; method: string };
      const reply = respond?.(req);
      if (reply === undefined) return;
      for (const fn of listeners) fn({ data: reply } as MessageEvent);
    },
  };
  return { source, target, sent, listeners };
}

const okReply = (requestId: string, data: unknown) => ({
  v: MINIAPP_BRIDGE_VERSION,
  kind: 'response' as const,
  requestId,
  ok: true as const,
  data,
});

describe('invoke — 정상 경로', () => {
  it('응답 데이터를 돌려준다', async () => {
    const h = harness((req) => okReply(req.requestId, { totalNet: 229_120 }));
    const client = createMiniappClient({ ...h, createId: () => 'r1' });
    await expect(client.invoke('spend.summary', { from: 'a', to: 'b' })).resolves.toEqual({
      totalNet: 229_120,
    });
  });

  it('요청에 버전과 메서드를 담는다', async () => {
    const h = harness((req) => okReply(req.requestId, null));
    const client = createMiniappClient({ ...h, createId: () => 'r1' });
    await client.invoke('host.info');
    expect(h.sent[0]).toMatchObject({
      v: MINIAPP_BRIDGE_VERSION,
      kind: 'request',
      requestId: 'r1',
      method: 'host.info',
    });
  });
});

describe('invoke — 응답 짝짓기', () => {
  it('다른 요청의 응답을 자기 것으로 받지 않는다', async () => {
    // 미니앱이 여러 요청을 동시에 보내고 응답 순서가 요청 순서와 다를 수 있다.
    const h = harness();
    const client = createMiniappClient({ ...h, createId: () => 'mine' });
    const pending = client.invoke('host.info');

    // 남의 응답을 흘려보낸다.
    for (const fn of h.listeners) {
      fn({ data: okReply('someone-else', { wrong: true }) } as MessageEvent);
    }
    // 그 다음 내 응답.
    for (const fn of h.listeners) {
      fn({ data: okReply('mine', { right: true }) } as MessageEvent);
    }
    await expect(pending).resolves.toEqual({ right: true });
  });

  it('응답 모양이 아닌 메시지를 무시한다', async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = createMiniappClient({
      ...h,
      createId: () => 'r1',
      timeoutMs: 100,
    });
    const pending = client.invoke('host.info');
    for (const fn of h.listeners) {
      fn({ data: { kind: 'ready' } } as MessageEvent); // 호스트 ready 브로드캐스트
      fn({ data: null } as MessageEvent);
      fn({ data: 'hello' } as MessageEvent);
    }
    vi.advanceTimersByTime(150);
    await expect(pending).rejects.toThrow(MiniappBridgeError);
    vi.useRealTimers();
  });
});

describe('invoke — 실패 경로', () => {
  it('호스트 오류를 코드와 함께 던진다', async () => {
    const h = harness((req) => ({
      v: MINIAPP_BRIDGE_VERSION,
      kind: 'response',
      requestId: req.requestId,
      ok: false,
      error: { code: 'permission_denied', message: '권한이 없습니다' },
    }));
    const client = createMiniappClient({ ...h, createId: () => 'r1' });
    await expect(client.invoke('spend.summary')).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  it('호스트가 답하지 않으면 타임아웃으로 끝난다', async () => {
    vi.useFakeTimers();
    const h = harness(); // 아무 응답도 하지 않는다
    const client = createMiniappClient({
      ...h,
      createId: () => 'r1',
      timeoutMs: 8000,
    });
    const pending = client.invoke('host.info');
    vi.advanceTimersByTime(8001);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    vi.useRealTimers();
  });

  it('타임아웃 뒤 늦게 온 응답이 아무것도 하지 않는다', async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = createMiniappClient({
      ...h,
      createId: () => 'r1',
      timeoutMs: 100,
    });
    const pending = client.invoke('host.info');
    vi.advanceTimersByTime(150);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });

    // 늦은 응답 — 리스너가 이미 제거됐어야 한다(누수 방지).
    expect(h.listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it('브라우저 밖에서는 명확히 실패한다', async () => {
    const client = createMiniappClient({
      target: undefined,
      source: undefined,
      createId: () => 'r1',
    });
    await expect(client.invoke('host.info')).rejects.toMatchObject({
      code: 'host_error',
    });
  });
});
