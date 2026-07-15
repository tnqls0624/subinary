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
 * The authenticated device principal is read via `@Device()`; the request body
 * is validated by the global `ZodValidationPipe` against the contract DTO. A
 * successful ingest replies `200 OK` (idempotent — a duplicate is still a 200).
 */
import {
  Body,
  Controller,
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
import { Device, type DeviceContext } from '../devices/decorators/device.decorator';
import { CardSmsIngestService } from './card-sms-ingest.service';

class CardSmsIngestDto extends createZodDto(cardSmsIngestRequestSchema) {}

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
}
