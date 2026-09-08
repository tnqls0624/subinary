import type { FastifyInstance } from 'fastify';

/**
 * 빈 본문은 content-type이 없어도(또는 파서가 없는 타입이어도) 통과시킨다.
 *
 * ## 왜 필요한가 — 실제로 당한 일
 *
 * 2026-09-07부터 앱의 자동 로그인이 조용히 죽었다. `user_sessions`의 회전 기록
 * (`revoked_reason='rotated'`)이 그날 09:24를 마지막으로 끊겼고, 그 뒤로는 앱을 열 때마다
 * 새 로그인 세션만 쌓였다. 사용자에게는 "자동 로그인이 안 된다"로 보였다.
 *
 * 같은 요청을 계층별로 보내 원인을 갈랐다(`POST /v1/auth/refresh`, 본문 없음):
 *
 * | 보낸 곳 | 결과 |
 * |---|---|
 * | api 컨테이너 직접 | 401 invalid session (핸들러 도달, 정상) |
 * | caddy 직접 | 401 invalid session (핸들러 도달, 정상) |
 * | 공개 도메인(Cloudflare 경유) | **415 Unsupported Media Type** |
 *
 * 즉 Cloudflare 터널을 지나면 **본문 없는 POST가 "본문이 있는 요청"으로 보이고**,
 * content-type이 없으니 Fastify가 파서를 찾지 못해 415로 끊는다. 공개 경로에서
 * content-type별로 재보면 경계가 분명했다 — 파서가 있는 타입(`text/plain`,
 * `x-www-form-urlencoded`)은 빈 본문이어도 401까지 갔고, **없는 경우에만** 415였다.
 *
 * 클라이언트는 잘못이 없다. `apiFetch`가 본문이 없을 때 content-type을 붙이지 않는 것은
 * 맞는 동작이고, 본문 없는 POST는 규격 위반이 아니다.
 *
 * 이 경로로 죽은 것은 refresh만이 아니었다. `/v1/auth/logout`, 알림 읽음 처리,
 * 초대·구성원 삭제처럼 **본문 없는 변경 요청이 전부** 415였다.
 *
 * ## 왜 서버에서 고치는가
 *
 * 웹 번들(OTA)을 고치면 앱이 두 번 여닫아야 닿지만, 서버를 고치면 **이미 설치된 앱이
 * 그대로 복구된다.** 고쳐야 할 계층도 여기다 — 규격을 지킨 요청을 거절한 쪽이 서버다.
 *
 * ## 경계
 *
 * 0바이트 본문은 잘못 해석될 내용 자체가 없으므로 타입과 무관하게 받아도 안전하다.
 * **실제 페이로드가 실려 있으면 기존대로 415**이며, 그 경계를 `empty-body-parser.test.ts`가
 * 고정한다. 구체 파서(`text/plain`·JSON·urlencoded)가 먼저 매칭되므로 그 경로는 그대로다.
 */
export function registerEmptyBodyParser(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (_request, body: Buffer, done) => {
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      const error = new Error('Unsupported Media Type') as Error & {
        statusCode?: number;
      };
      error.statusCode = 415;
      done(error);
    },
  );
}
