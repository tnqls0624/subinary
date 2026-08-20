import 'reflect-metadata';

import { Readable } from 'node:stream';

import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import type { AppConfig } from '@family/config';
import { NATIVE_CLIENT_ORIGINS } from '@family/shared';
import { createLogger } from '@family/shared';

import { AppModule } from './app.module';

const DEFAULT_API_PORT = 3001;

/**
 * 무차별 대입 위험이 큰 인증 경로. 별도 rate-limit 버킷(10회/분)을 쓴다.
 * refresh는 제외한다 — 정상 사용에서 다중 탭·앱 복귀로 빈번히 호출된다.
 */
const AUTH_RATE_LIMITED_PATHS = /^\/v1\/auth\/(login|register|change-password)\b/;

/**
 * JSON 문자열 리터럴 안의 raw 제어문자(개행/탭 등)를 이스케이프해 "거의 JSON"을
 * 유효한 JSON으로 수리한다. MacroDroid/단축어가 카드문자 원문을 JSON body에
 * 그대로 삽입하면 문자열 안에 raw 개행이 들어가 표준 파서가 400을 내는데, 이
 * 케이스가 자동화 도구에서는 사실상 회피 불가능하다(도구의 이스케이프 미지원).
 * 문자열 컨텍스트만 추적하므로 구조(따옴표/중괄호)는 건드리지 않는다.
 */
function escapeCtrlInJsonStrings(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of input) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) {
        out +=
          code === 0x0a
            ? '\\n'
            : code === 0x0d
              ? '\\r'
              : code === 0x09
                ? '\\t'
                : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

async function bootstrap(): Promise<void> {
  const logger = createLogger('api', {
    pretty: process.env.NODE_ENV !== 'production',
  });

  // bodyLimit은 config 로딩 이전이므로 상수를 사용한다(MOBILE_MAX_BODY_BYTES 기본값과 동일).
  // rawBody:true 는 장치 HMAC 서명 대상(원본 바이트) 접근을 위해 필수.
  // forceCloseConnections:true 는 종료 시 keep-alive 연결을 강제 종료해 리슨
  // 소켓(포트)을 즉시 반납하게 한다(미설정 시 idle 연결을 기다려 포트 반납 지연).
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 16384, forceCloseConnections: true }),
    { rawBody: true },
  );

  app.setGlobalPrefix('v1');

  // text/plain 본문 파서: 자동화 도구(안드로이드 MacroDroid, iOS 단축어)가 개행/
  // 따옴표가 든 카드문자 원문을 JSON 이스케이프 없이 raw body로 보낼 수 있게 한다
  // (POST /v1/mobile-events/card-sms-text). eventId/sender는 헤더로 받는다.
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addContentTypeParser(
    'text/plain',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  // card-sms-token(JSON) 경로 한정 lenient JSON 수리: MacroDroid가 content에
  // 카드문자를 raw로 넣으면 문자열 안 개행 때문에 표준 JSON 파서가 400을 낸다.
  // preParsing 훅에서 이 경로의 body가 strict JSON 파싱에 실패할 때만 문자열 내
  // 제어문자를 이스케이프해 재구성한다(유효 JSON은 바이트 그대로 통과, 다른
  // 라우트·HMAC(rawBody 서명) 경로는 접촉하지 않음). content-length는 수리로
  // 길이가 변하므로 함께 갱신한다.
  fastify.addHook('preParsing', (req, _reply, payload, done) => {
    const url = req.raw.url ?? '';
    const contentType = req.headers['content-type'] ?? '';
    if (
      !url.startsWith('/v1/mobile-events/card-sms-token') ||
      !contentType.includes('application/json')
    ) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    payload.on('data', (chunk: Buffer) => chunks.push(chunk));
    payload.on('error', (err: Error) => done(err));
    payload.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let repaired = raw;
      try {
        JSON.parse(raw);
      } catch {
        repaired = escapeCtrlInJsonStrings(raw);
      }
      const buf = Buffer.from(repaired, 'utf8');
      req.headers['content-length'] = String(buf.byteLength);
      const stream = Readable.from([buf]) as Readable & {
        receivedEncodedLength?: number;
      };
      stream.receivedEncodedLength = buf.byteLength;
      done(null, stream);
    });
  });

  // 무차별 대입·자원 고갈 방어. 이 API는 Cloudflare Tunnel로 인터넷에 열려 있고
  // argon2id 검증이 CPU를 많이 쓰므로, 인증 경로에 리밋이 없으면 로그인 시도만으로
  // 홈서버가 눕는다. 전역 기본값을 깔고 인증 라우트는 컨트롤러에서 더 조인다.
  //
  // keyGenerator가 헤더를 보는 이유: 실제 클라이언트 IP가 Cloudflare → cloudflared →
  // caddy를 거쳐 오므로 소켓 IP는 항상 내부 프록시 주소다(전원이 한 버킷을 공유하게 됨).
  //
  // ⚠️ `x-forwarded-for`의 **첫 요소**를 쓰면 안 된다. 클라이언트가 그 헤더를 직접
  // 실어 보내면 Cloudflare는 기존 값을 지우지 않고 뒤에 append하므로, 첫 요소는
  // 공격자가 정하는 값이 된다 — 매 요청 다른 값을 넣으면 버킷이 매번 새로 생겨
  // 리밋이 통째로 무력화되고, argon2id 검증으로 홈서버 CPU를 고갈시킬 수 있다.
  //
  // `cf-connecting-ip`는 Cloudflare가 **항상 덮어쓰는** 헤더라 통과하는 한 위조되지
  // 않는다. 이 API의 외부 노출 경로는 Cloudflare Tunnel 하나뿐이므로 이 값이 신뢰
  // 가능한 유일한 클라이언트 식별자다. 헤더가 없는 요청(호스트 로컬·컨테이너 내부
  // 헬스체크)은 CF를 거치지 않은 것이므로 소켓 IP로 폴백한다.
  await app.register(fastifyRateLimit, {
    global: true,
    timeWindow: '1 minute',
    // 인증 경로는 별도 버킷 + 훨씬 낮은 상한. 버킷을 나누지 않으면 정상 사용
    // (대시보드 폴링·SSE)이 로그인 시도와 같은 카운터를 공유해 서로를 굶긴다.
    keyGenerator: (req) => {
      const cfIp = req.headers['cf-connecting-ip'];
      const first = Array.isArray(cfIp) ? cfIp[0] : cfIp;
      const ip = first?.trim() || req.ip;
      return `${AUTH_RATE_LIMITED_PATHS.test(req.url) ? 'auth' : 'general'}:${ip}`;
    },
    // 가족 전원이 같은 공인 IP(가정 회선)를 공유하므로 일반 상한은 넉넉해야 한다 —
    // 대시보드 15초 폴링 × 여러 탭 × 여러 기기가 정상 트래픽이다. 비싼 경로(argon2)는
    // 위 auth 버킷이 따로 막으므로 여기서 조일 실익이 없다.
    max: (req) => (AUTH_RATE_LIMITED_PATHS.test(req.url) ? 10 : 600),
  });

  // HttpOnly refresh-token 쿠키 지원(Fastify 어댑터). listen 이전에 등록.
  await app.register(fastifyCookie);

  // Slack export 번들 업로드(Phase 6)용 multipart 파서. 파일 크기 50MB, 1개 제한.
  // multipart는 별도 content-type 파서로 처리되어 JSON bodyLimit(16KB)과 무관하다.
  await app.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  });

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig['app']>('app');
  const port = appConfig?.apiPort ?? DEFAULT_API_PORT;

  // web(3000)→api(3001)는 cross-origin. refresh 쿠키를 주고받기 위해
  // credentials 허용 + 명시적 origin(와일드카드 금지). listen 이전에 등록.
  //
  // Capacitor 네이티브 앱은 WebView origin이 capacitor://localhost(iOS) /
  // http://localhost(Android)라 정적 셸에서 원격 API를 호출할 때 CORS가 적용된다.
  // 이 origin들도 허용해야 preflight를 통과한다. 네이티브는 쿠키 대신 바디 토큰을
  // 쓰므로 refresh 토큰을 헤더로 실어보낸다 → X-Client-Platform/X-Refresh-Token 허용.
  const webConfig = configService.get<AppConfig['web']>('web');
  app.enableCors({
    origin: [
      webConfig?.corsOrigin ?? 'http://localhost:3000',
      ...NATIVE_CLIENT_ORIGINS,
    ],
    credentials: true,
    // 프리플라이트 Access-Control-Allow-Methods에 전체 메서드를 명시한다.
    // 미지정 시 기본값이 좁아 DELETE/PATCH/PUT 요청이 preflight에서 차단된다.
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    /**
     * ⚠️ 이 목록은 **컨트롤러가 `@Headers()`로 요구하는 헤더를 전부 담아야 한다.**
     *
     * 빠지면 same-origin 브라우저(운영 웹)에서는 멀쩡하고 **cross-origin에서만**
     * 조용히 죽는다 — Capacitor 앱의 origin은 `capacitor://localhost`라 preflight를
     * 타고, `Access-Control-Allow-Headers`에 없는 헤더를 붙인 요청은 WebView가
     * 본 요청을 보내지도 않고 취소한다. 서버 로그에는 아무것도 남지 않는다.
     *
     * 2026-08-20에 `Idempotency-Key`가 빠져 예산 "다음 달 계획 복사"가 **폰에서만**
     * 실패했다. 그 헤더를 필수로 요구하는 호출부가 앱 전체에서 하나뿐이라, 다른 기능은
     * 전부 정상이고 그 하나만 "잠시 후 다시 시도"를 무한 반복했다.
     *
     * `cors-headers.test.ts`가 이 목록과 `@Headers()` 사용처를 소스에서 대조한다.
     */
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Client-Platform',
      'X-Refresh-Token',
      // POST /v1/budgets/copy가 계약상 필수로 요구한다(budget.controller.ts).
      'Idempotency-Key',
    ],
  });

  // Graceful shutdown: `nest start --watch`(SWC)는 파일 변경 시 이전 프로세스의
  // 종료를 기다리지 않고 새 프로세스를 spawn한다. 이전 프로세스가 포트를 늦게
  // 반납하면 새 프로세스가 EADDRINUSE로 죽는다. SIGTERM/SIGINT에서 app.close()
  // (모듈 onApplicationShutdown 훅 실행 + HTTP 서버 close)로 포트를 즉시 반납하고
  // process.exit()로 잔여 핸들(DB 풀·Redis·소켓)에 매이지 않고 확실히 종료한다.
  // 3초 안에 close가 끝나지 않으면 강제 종료(이전 프로세스가 절대 남지 않게).
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'API server shutting down');
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen(port, '0.0.0.0');
  logger.info({ port, prefix: 'v1' }, 'API server listening');
}

bootstrap().catch((error: unknown) => {
  // Secrets/PII must never be logged; error message only.
  const message = error instanceof Error ? error.message : 'unknown error';
  // eslint-disable-next-line no-console
  console.error(`Fatal error during API bootstrap: ${message}`);
  process.exit(1);
});
