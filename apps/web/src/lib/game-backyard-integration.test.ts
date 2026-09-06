import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { loadBackyard, settle, cell } from './game-backyard-test-utils';
import { createMiniappClient } from './miniapp-client-test-utils';
import { createMiniappHostRuntime, createMiniappStateHandlers } from './miniapp-host';

/** 실제 HTTP 요청 기록을 남기는 테스트 저장소를 연다. */
async function httpStore(failGet: boolean) {
  let saved: unknown = null;
  const network: string[] = [];
  const server = createServer(async (request, response) => {
    network.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      response.statusCode = failGet ? 503 : 200;
      response.end(JSON.stringify({ items: saved === null ? [] : [{ stateKey: 'garden', state: saved }] }));
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      saved = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
      response.end('{"ok":true}');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('검증 포트가 없어요');
  const base = `http://127.0.0.1:${address.port}/garden`;
  return { server, network, getSaved: () => saved,
    store: {
      list: async () => {
        const response = await fetch(base); if (!response.ok) throw new Error(`GET ${response.status}`);
        return response.json() as Promise<{ items: { stateKey: string; state: unknown }[] }>;
      },
      save: async (_household: string, _app: string, _key: string, state: Record<string, unknown>) => {
        const response = await fetch(base, { method: 'PUT', body: JSON.stringify(state) });
        if (!response.ok) throw new Error(`PUT ${response.status}`);
      },
      remove: async () => undefined,
    },
  };
}

/** 제품 브릿지·부모 큐·세션을 연결한다. */
function connect(store: Awaited<ReturnType<typeof httpStore>>['store']) {
  const listeners = new Set<EventListener>();
  const source = { addEventListener: (_type: string, fn: EventListener) => { listeners.add(fn); }, removeEventListener: (_type: string, fn: EventListener) => { listeners.delete(fn); } };
  const handlers = createMiniappStateHandlers('test-household', 'backyard', [], store);
  const frame = { postMessage: (data: unknown) => { for (const fn of listeners) fn({ source: target, data } as unknown as Event); } };
  const host = createMiniappHostRuntime({ appKey: 'backyard', permissions: [], getFrame: () => frame, getHandlers: () => handlers });
  const target = { postMessage: (data: unknown) => { void host.receive({ source: frame, data }); } };
  const client = createMiniappClient({ source, target, captureReady: true });
  const session = loadBackyard().session.createSession({ bridge: client, nowSec: () => 1000, seed: () => 1, setTimer: (fn, ms) => Number(setTimeout(fn, ms)), clearTimer: id => clearTimeout(id) });
  host.loaded();
  return { session, destroy: () => { session.destroy(); client.destroy(); host.destroy(); } };
}

/** 테스트 HTTP 서버의 연결을 정리한다. */
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

/** 저장 ACK까지 기다린 뒤 실패를 검사한다. */
async function saved(connection: ReturnType<typeof connect>): Promise<void> {
  for (let index = 0; index < 100; index++) {
    const state = connection.session.getState();
    if (state.status === 'playable' && !state.writer.getSaveState().dirty) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('저장 ACK가 도착하지 않았어요');
}

describe('실제 HTTP·브릿지·부모 큐·세션 통합', () => {
  it('초기 GET 503이면 네트워크 PUT=0이며 writer가 없다', async () => {
    const h = await httpStore(true), connection = connect(h.store);
    try {
      await connection.session.load(); await settle();
      expect(connection.session.getState().status).toBe('load_error');
      expect(connection.session.getState()).not.toHaveProperty('writer');
      expect(h.network).toEqual(['GET /garden']);
      console.log('초기 GET 실패 네트워크 로그:', JSON.stringify(h.network), 'PUT=0');
    } finally { connection.destroy(); await close(h.server); }
  });
  it('수확·구매·이동·swap 후 재진입 DTO가 일치한다', async () => {
    const h = await httpStore(false); let connection = connect(h.store);
    try {
      await connection.session.load(); await saved(connection);
      for (const action of [
        { type: 'harvest', cell: cell(0) }, { type: 'harvest', cell: cell(1) }, { type: 'harvest', cell: cell(2) },
        { type: 'buyAndPlace', kind: 'p', cell: cell(4) }, { type: 'move', from: cell(4), to: cell(5) }, { type: 'move', from: cell(5), to: cell(0) },
      ] satisfies Action[]) {
        const state = connection.session.getState(); if (state.status !== 'playable') throw new Error('플레이 상태가 아니에요');
        expect(state.writer.dispatch(action).status).toBe('ok');
      }
      await saved(connection); const before = h.getSaved(); connection.destroy(); connection = connect(h.store);
      await connection.session.load();
      const state = connection.session.getState(); if (state.status !== 'playable') throw new Error('복원 실패');
      const dto = loadBackyard().codec.serializeGarden(state.garden, 1000);
      expect(dto.status).toBe('ok'); if (dto.status === 'ok') expect(dto.value).toEqual(before);
      expect(h.network.at(-1)).toBe('GET /garden');
    } finally { connection.destroy(); await close(h.server); }
  });
});
