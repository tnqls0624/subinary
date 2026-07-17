import 'reflect-metadata';

import { Readable } from 'node:stream';

import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import type { AppConfig } from '@family/config';
import { createLogger } from '@family/shared';

import { AppModule } from './app.module';

const DEFAULT_API_PORT = 3001;

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
  const webConfig = configService.get<AppConfig['web']>('web');
  app.enableCors({
    origin: webConfig?.corsOrigin ?? 'http://localhost:3000',
    credentials: true,
    // 프리플라이트 Access-Control-Allow-Methods에 전체 메서드를 명시한다.
    // 미지정 시 기본값이 좁아 DELETE/PATCH/PUT 요청이 preflight에서 차단된다.
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
