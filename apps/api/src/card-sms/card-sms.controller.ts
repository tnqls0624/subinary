/**
 * Card-SMS ingestion HTTP surface (Phase 3 Build Spec §5.2).
 *
 * `POST /v1/mobile-events/card-sms` is `@Public()` (bypasses the global
 * access-token guard) and instead authenticated by {@link DeviceHmacGuard} —
 * the same per-device HMAC guard Phase 2 uses for `mobile-events/ping`. The two
 * routes share the `mobile-events` prefix but never collide (different paths),
 * so this controller lives alongside Phase 2's `MobileEventsController` rather
 * than being merged into it.
 *
 * `POST /v1/mobile-events/card-sms-token` (addendum) is the low-friction path
 * for automation tools that cannot compute an HMAC signature (iOS Shortcuts /
 * Android MacroDroid): it is authenticated by {@link DeviceTokenGuard} against a
 * per-device Bearer collect token, then delegates to the *same*
 * `CardSmsIngestService.ingest`, so idempotency and parsing behave identically.
 *
 * The authenticated device principal is read via `@Device()`; the request body
 * is validated by the global `ZodValidationPipe` against the contract DTO. A
 * successful ingest replies `200 OK` (idempotent — a duplicate is still a 200).
 */
import { createHash } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  cardSmsIngestRequestSchema,
  type CardSmsIngestResponse,
} from '@family/contracts';

import { Public } from '../auth/decorators/public.decorator';
import { DeviceHmacGuard } from '../devices/device-hmac.guard';
import { DeviceTokenGuard } from '../devices/device-token.guard';
import { Device, type DeviceContext } from '../devices/decorators/device.decorator';
import { CardSmsIngestService } from './card-sms-ingest.service';

class CardSmsIngestDto extends createZodDto(cardSmsIngestRequestSchema) {}

/**
 * HTTP 헤더 값 디코딩 보정. Node는 헤더 바이트를 latin-1로 해석하므로, 자동화
 * 도구가 발신자 표시명(RCS/알림톡의 '신한카드' 등)을 UTF-8 바이트로 실어 보내면
 * mojibake('ì‹ í•œ…')로 도착한다. 0x80~0xFF 범위 문자가 보이면 latin1→utf8로
 * 재디코드해 원문을 복원한다(순수 ASCII 전화번호는 그대로 통과).
 */
function decodeHeader(value: string | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw || !/[\u0080-\u00ff]/.test(raw)) return raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  // 재디코드 결과에 대체문자(U+FFFD)가 생기면 원래 latin-1 텍스트였던 것 — 원문 유지.
  return decoded.includes('�') ? raw : decoded;
}

@Controller('mobile-events')
export class CardSmsController {
  constructor(private readonly ingestService: CardSmsIngestService) {}

  /** POST /v1/mobile-events/card-sms — HMAC-authenticated card-SMS ingest. */
  @Public()
  @UseGuards(DeviceHmacGuard)
  @Post('card-sms')
  @HttpCode(HttpStatus.OK)
  ingest(
    @Device() device: DeviceContext,
    @Body() dto: CardSmsIngestDto,
  ): Promise<CardSmsIngestResponse> {
    return this.ingestService.ingest(device, dto);
  }

  /**
   * POST /v1/mobile-events/card-sms-token — collect-token (Bearer) card-SMS
   * ingest for Shortcuts/MacroDroid. Reuses `CardSmsIngestService.ingest`, so
   * idempotency (`UNIQUE(device_id, event_id)`) and parsing are identical to
   * the HMAC path.
   */
  @Public()
  @UseGuards(DeviceTokenGuard)
  @Post('card-sms-token')
  @HttpCode(HttpStatus.OK)
  ingestWithToken(
    @Device() device: DeviceContext,
    @Body() dto: CardSmsIngestDto,
  ): Promise<CardSmsIngestResponse> {
    return this.ingestService.ingest(device, dto);
  }

  /**
   * POST /v1/mobile-events/card-sms-text — collect-token(Bearer) 기반의 **JSON
   * 이스케이프가 필요 없는** 수집 경로. 자동화 도구(MacroDroid/단축어)가 개행·
   * 따옴표가 든 카드문자를 `Content-Type: text/plain` 본문에 **원문 그대로** 보낸다.
   * 메타데이터(eventId/sender)는 헤더로 받는다 — 헤더 값엔 개행이 없어 안전.
   *
   * 멱등 키(eventId) 결정 규칙 — `X-Event-Id`(문자당 유니크, 강력 권장) >
   * `sha256(sender+content[+X-Received-At])` 자동 생성. 카드문자 시각은 분 단위라
   * 같은 분의 동일 가맹점·금액 결제는 원문이 바이트 단위로 같아질 수 있다 —
   * X-Received-At(문자 수신 시각, 형식 자유·초 단위 권장)을 보내면 해시에 섞여
   * 서로 다른 결제로 구분되고, 같은 문자의 재시도는 같은 값이라 멱등이 유지된다.
   * receivedAt(저장용)은 서버가 now()로 채운다. 파싱/멱등은 기존 ingest와 동일.
   */
  @Public()
  @UseGuards(DeviceTokenGuard)
  @Post('card-sms-text')
  @HttpCode(HttpStatus.OK)
  ingestText(
    @Device() device: DeviceContext,
    @Headers('x-event-id') eventIdHeader: string | undefined,
    @Headers('x-sender') senderHeader: string | undefined,
    @Headers('x-received-at') receivedAtHeader: string | undefined,
    @Body() content: unknown,
  ): Promise<CardSmsIngestResponse> {
    const text = typeof content === 'string' ? content : '';
    const sender = decodeHeader(senderHeader);
    // X-Event-Id 미지정 시 발신자+내용(+수신시각)을 해시해 결정적 생성(재전송 멱등).
    const receivedAtTag = (receivedAtHeader ?? '').trim();
    const eventId =
      (eventIdHeader ?? '').trim() ||
      createHash('sha256')
        .update(
          `${sender}\n${text}${receivedAtTag ? `\n${receivedAtTag}` : ''}`,
          'utf8',
        )
        .digest('hex');

    const parsed = cardSmsIngestRequestSchema.safeParse({
      eventId,
      sender,
      content: text,
    });
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join(', ');
      throw new BadRequestException(`invalid card-sms-text request — ${detail}`);
    }
    return this.ingestService.ingest(device, parsed.data);
  }
}
