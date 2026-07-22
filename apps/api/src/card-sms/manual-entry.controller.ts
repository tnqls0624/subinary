/**
 * 수동 거래 등록 HTTP 표면 (in-app). 전역 {@link AccessTokenGuard} 하에 동작하며
 * (`@Public()` 아님), 인증 주체(userId)를 서비스에 넘겨 멤버십을 강제한다.
 *
 * `@Controller('card-sms')` — 조회용 `card-sms-events`(CardSmsEventsController)와
 * prefix가 달라 충돌하지 않는다. 본문은 전역 ZodValidationPipe가 계약 DTO로 검증한다.
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  manualFieldsEntryRequestSchema,
  manualParsePreviewRequestSchema,
  manualTextEntryRequestSchema,
  type ManualParsePreviewResponse,
  type ManualTextEntryResponse,
  type TransactionSummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { ManualEntryService } from './manual-entry.service';

class ManualParsePreviewDto extends createZodDto(manualParsePreviewRequestSchema) {}
class ManualTextEntryDto extends createZodDto(manualTextEntryRequestSchema) {}
class ManualFieldsEntryDto extends createZodDto(manualFieldsEntryRequestSchema) {}

@Controller('card-sms')
export class ManualEntryController {
  constructor(private readonly manualEntryService: ManualEntryService) {}

  /** POST /v1/card-sms/parse-preview — 붙여넣은 문자 상태 없는 파싱 미리보기. */
  @Post('parse-preview')
  @HttpCode(HttpStatus.OK)
  parsePreview(@Body() dto: ManualParsePreviewDto): ManualParsePreviewResponse {
    return this.manualEntryService.parsePreview(dto);
  }

  /** POST /v1/card-sms/manual-text — 문자를 수집 파이프라인으로 등록(비동기 승격). */
  @Post('manual-text')
  @HttpCode(HttpStatus.OK)
  manualText(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ManualTextEntryDto,
  ): Promise<ManualTextEntryResponse> {
    return this.manualEntryService.manualText(user.userId, dto);
  }

  /** POST /v1/card-sms/manual-fields — 필드 직접 입력 거래 등록(동기). */
  @Post('manual-fields')
  @HttpCode(HttpStatus.CREATED)
  manualFields(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ManualFieldsEntryDto,
  ): Promise<TransactionSummary> {
    return this.manualEntryService.manualFields(user.userId, dto);
  }
}
