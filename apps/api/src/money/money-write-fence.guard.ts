/**
 * 쓰기 펜스 가드 — ADR-0027 5단계의 "API 쓰기를 503으로 막는다".
 *
 * ## 왜 전역 미들웨어가 아니라 핸들러별 가드인가
 *
 * 막아야 하는 것은 **정확히 4개 경로**이고, 절대 막으면 안 되는 것이 그 옆에 있다:
 *
 * - ⛔ **카드문자 수집**(`POST /v1/mobile-events/card-sms*`)은 막으면 안 된다.
 *   **카드 문자는 재전송이 없다.** 막는 순간 그 결제는 영영 유실된다. 수집은
 *   `card_sms_events` + `data_events`를 한 트랜잭션으로 쓰고 worker가 멈춰도 Postgres에
 *   남으므로, **열어 두는 것이 안전한 선택**이다(승격은 pause가 따로 막는다).
 * - ⛔ **모든 읽기**. 펜스 중에도 가족은 앱을 볼 수 있어야 한다.
 *
 * 경로 패턴 매칭(정규식·prefix)으로 막으면 새 라우트가 생길 때 조용히 범위가 넓어지거나
 * 좁아진다. `@UseGuards()`를 **핸들러에 직접** 붙이면 무엇이 막히는지가 코드 리뷰에서
 * 눈으로 보이고, 수집 컨트롤러에 가드가 없다는 사실도 함께 보인다.
 *
 * ## 응답
 *
 * 503 + `Retry-After`. 사용자 문구는 한국어다 — 영문 예외를 그대로 노출하지 않는다
 * (P1-4에서 이미 고친 문제).
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  MONEY_FENCE_MESSAGE_KO,
  MONEY_FENCE_RETRY_AFTER_SEC,
} from '@family/shared';

import { MoneyRuntimeService } from './money-runtime.service';

@Injectable()
export class MoneyWriteFenceGuard implements CanActivate {
  private readonly logger = new Logger(MoneyWriteFenceGuard.name);

  constructor(private readonly runtime: MoneyRuntimeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!(await this.runtime.isWriteFenceOn())) {
      return true;
    }

    // 남은 시간을 알면 그만큼, 모르면 기본값. 사용자에게 "언제쯤"이 전달돼야 한다.
    const ttl = await this.runtime.fenceTtlSeconds();
    const retryAfter =
      ttl !== null && ttl > 0 ? ttl : MONEY_FENCE_RETRY_AFTER_SEC;

    const http = context.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    // Fastify 어댑터. header()가 없는 환경(테스트 더블 등)에서도 죽지 않게 방어한다.
    if (typeof reply?.header === 'function') {
      reply.header('Retry-After', String(retryAfter));
    }

    // 원문·PII 없이 어느 핸들러가 막혔는지만 남긴다.
    this.logger.warn(
      `money write fence blocked ${context.getClass().name}.${context.getHandler().name}`,
    );

    throw new ServiceUnavailableException({
      message: MONEY_FENCE_MESSAGE_KO,
      // 클라이언트가 문구가 아니라 코드로 분기할 수 있게 남긴다.
      errorCode: 'money_write_fenced',
      retryAfterSeconds: retryAfter,
    });
  }
}
