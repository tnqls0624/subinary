/**
 * 본문 없는 변경 요청이 415로 죽지 않는지 **실제 Fastify로** 고정한다.
 *
 * 이 테스트는 `registerEmptyBodyParser`(제품 코드)를 그대로 불러 쓴다. 파서를 여기에
 * 옮겨 적으면 제품이 아니라 사본을 검증하게 되고, 그러면 `main.ts`에서 등록이 빠져도
 * 초록불이 뜬다.
 *
 * 배경: Cloudflare 터널을 지나면 본문 없는 POST가 "본문이 있는 요청"으로 보여
 * content-type이 없는 상태로 파서 조회에 실패하고, Fastify가 415로 끊었다. 그래서
 * 앱의 자동 로그인(`/v1/auth/refresh`)과 로그아웃·알림 읽음·초대 삭제가 전부 죽었다.
 * 자세한 계층별 실측은 `empty-body-parser.ts` 머리주석에 있다.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerEmptyBodyParser } from './empty-body-parser.js';

let app: FastifyInstance | undefined;

/** 제품 파서만 얹은 최소 서버. 라우트는 받은 본문을 그대로 되돌려준다. */
async function server(): Promise<FastifyInstance> {
  const instance = Fastify();
  // text/plain 파서는 운영과 같은 순서로 먼저 등록한다 — 구체 파서가 catch-all보다
  // 우선한다는 것도 함께 고정하기 위해서다.
  instance.addContentTypeParser(
    'text/plain',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );
  registerEmptyBodyParser(instance);
  instance.post('/echo', async (request) => ({
    reached: true,
    body: request.body ?? null,
  }));
  instance.delete('/echo', async () => ({ reached: true }));
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('빈 본문 파서', () => {
  it('content-type 없는 POST가 핸들러에 도달한다 — 앱 자동 로그인이 죽은 지점', async () => {
    const instance = await server();
    const response = await instance.inject({ method: 'POST', url: '/echo' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reached: true, body: null });
  });

  it('본문 없는 DELETE도 도달한다 — 초대·구성원 삭제가 같은 경로였다', async () => {
    const instance = await server();
    const response = await instance.inject({ method: 'DELETE', url: '/echo' });
    expect(response.statusCode).toBe(200);
  });

  it('파서가 없는 타입이어도 본문이 비었으면 도달한다', async () => {
    const instance = await server();
    for (const contentType of [
      'application/octet-stream',
      'application/x-unknown',
      'text/csv',
    ]) {
      const response = await instance.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': contentType },
        payload: '',
      });
      expect(response.statusCode, contentType).toBe(200);
    }
  });

  it('실제 페이로드가 있는 미지원 타입은 여전히 415다 — 이것이 완화의 경계다', async () => {
    const instance = await server();
    const response = await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(response.statusCode).toBe(415);
  });

  it('구체 파서가 catch-all보다 우선한다 — text/plain·JSON 경로는 그대로다', async () => {
    const instance = await server();
    const plain = await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'text/plain' },
      payload: '카드문자 원문\n두 번째 줄',
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().body).toBe('카드문자 원문\n두 번째 줄');

    const json = await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    });
    expect(json.statusCode).toBe(200);
    expect(json.json().body).toEqual({ hello: 'world' });
  });
});

describe('main.ts 등록', () => {
  it('부트스트랩이 파서를 실제로 등록한다', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    // 등록이 빠지면 위 동작 테스트는 전부 통과하는데 운영만 415로 돌아간다.
    expect(main).toMatch(/registerEmptyBodyParser\(fastify\)/);
  });
});
