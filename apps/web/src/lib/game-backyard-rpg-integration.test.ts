import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { settle } from './game-backyard-test-utils';
import { loadRpg, playable } from './game-backyard-rpg-test-utils';
import { createMiniappClient } from './miniapp-client-test-utils';
import { createMiniappHostRuntime, createMiniappStateHandlers } from './miniapp-host';

/** 실제 HTTP 요청 기록을 남기는 테스트 저장소를 연다. */
async function httpStore(failGet: boolean) {
  const saved: Record<string, unknown> = {};
  let failPut = false;
  const network: string[] = [];
  const server = createServer(async (request, response) => {
    network.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      response.statusCode = failGet ? 503 : 200;
      response.end(JSON.stringify({ items: Object.entries(saved).map(([stateKey,state])=>({stateKey,state})) }));
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if(failPut){response.statusCode=503;response.end('{}');return;}
      saved[request.url?.split('/').at(-1) ?? 'unknown'] = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
      response.end('{"ok":true}');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('검증 포트가 없어요');
  const base = `http://127.0.0.1:${address.port}/states`;
  return { server, network, getSaved: () => saved, failPut: (value:boolean) => {failPut=value;},
    store: {
      list: async () => {
        const response = await fetch(base); if (!response.ok) throw new Error(`GET ${response.status}`);
        return response.json() as Promise<{ items: { stateKey: string; state: unknown }[] }>;
      },
      save: async (_household: string, _app: string, _key: string, state: Record<string, unknown>) => {
        const response = await fetch(base + '/' + _key, { method: 'PUT', body: JSON.stringify(state) });
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
  const session = loadRpg().session.createSession({ bridge: client, setTimer: (fn, ms) => Number(setTimeout(fn, ms)), clearTimer: id => clearTimeout(id) });
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
      expect(h.network).toEqual(['GET /states']);
      process.stdout.write('RPG 초기 GET 실패 네트워크: ' + JSON.stringify(h.network) + ' PUT=0\n');
    } finally { connection.destroy(); await close(h.server); }
  });
  it('채집과 낚시가 각 PUT 하나로 발견·수량·재생성을 함께 저장하고 중복을 잠근다', async () => {
    const h=await httpStore(false);const connection=connect(h.store),life=loadRpg().life;
    try{
      await connection.session.load();await saved(connection);
      const start=h.network.length,state=playable(connection.session);
      const gathered=life.gather(state.data.rpg_collection,'node-0',1000);
      if(!gathered)throw Error('채집 fixture 실패');
      expect(state.writer.commit('rpg_collection',gathered)).toBe(true);
      expect(state.writer.commit('rpg_collection',gathered)).toBe(false);
      await saved(connection);
      expect(h.network.slice(start)).toEqual(['PUT /states/rpg_collection']);
      // node-0은 열매라 재생성이 3시간(1000+10800)이다. 버섯·솔방울·벌레는 60초다 —
      // 그 구분은 game-backyard-rpg-life.test.ts에서 고정한다.
      expect(h.getSaved().rpg_collection).toEqual({v:2,species:['s0:1:1000:node-0'],nodes:[`node-0:${1000+life.regrowSeconds('node-0')}`],fishing:[0,0,0]});
      const caught=life.catchFish(playable(connection.session).data.rpg_collection,1,1001,4821);
      if(!caught)throw Error('낚시 fixture 실패');
      expect(state.writer.commit('rpg_collection',caught.state)).toBe(true);await saved(connection);
      expect(h.network.slice(start)).toEqual(['PUT /states/rpg_collection','PUT /states/rpg_collection']);
      expect(state.writer.commit('rpg_collection',{...caught.state,species:[]})).toBe(false);
      expect(state.writer.commit('rpg_collection',{...caught.state,nodes:[]})).toBe(false);
      await connection.session.load();
      expect(playable(connection.session).data.rpg_collection).toEqual(caught.state);
      process.stdout.write('채집/낚시 실제 HTTP PUT: '+JSON.stringify(h.network.slice(start))+' DTO: '+JSON.stringify(caught.state)+'\n');
    }finally{connection.destroy();await close(h.server);}
  });
  it('물건 이동→ACK→재진입이 실제 HTTP 저장과 일치하고 PUT 503을 복구한다', async () => {
    const h = await httpStore(false); let connection = connect(h.store);
    try {
      await connection.session.load(); await saved(connection);
      const state = playable(connection.session);
      const next = { ...state.data.rpg_world, items: ['0:p:4:21', '1:w:4:20', '2:c:5:20'] };
      h.failPut(true);
      expect(state.writer.commit('rpg_world', next)).toBe(true);
      for(let i=0;i<100&&!state.writer.getSaveState().keys.rpg_world.error;i++) await new Promise(resolve=>setTimeout(resolve,5));
      expect(state.writer.getSaveState().message).toBe('저장 안 됨');
      expect(h.getSaved().rpg_world).not.toEqual(next);
      h.failPut(false); state.writer.flush(); await saved(connection);
      expect(h.getSaved().rpg_world).toEqual(next);
      const before = structuredClone(h.getSaved());
      connection.destroy(); connection = connect(h.store); await connection.session.load();
      expect(playable(connection.session).data).toEqual(before);
      expect(h.network.filter(n=>n.startsWith('PUT')).slice(0,5)).toEqual(['PUT /states/rpg_world','PUT /states/rpg_collection','PUT /states/rpg_residents','PUT /states/rpg_player','PUT /states/rpg_meta']);
      process.stdout.write('RPG 이동/503 복구/재진입 네트워크: ' + JSON.stringify(h.network) + '\n');
    } finally { connection.destroy(); await close(h.server); }
  });
});
