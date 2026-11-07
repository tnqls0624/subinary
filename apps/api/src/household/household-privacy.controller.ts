/**
 * 개인정보 Control Center HTTP 표면 (C-3 + SOO-34 보존 정책).
 *
 * 권한 판정은 서비스의 `requireMembership`(활성 구성원)과 같다 —
 * 동의·철회와 같은 모델을 쓰고 권한을 넓히지 않는다.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  privacyConsentGrantRequestSchema,
  privacyConsentRevokeRequestSchema,
  privacyRetentionPreviewRequestSchema,
  privacyRetentionUpdateRequestSchema,
  type PrivacyConsentRevokeResponse,
  type PrivacyOverview,
  type PrivacyRetentionPreviewResponse,
  type PrivacyRetentionUpdateResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { HouseholdPrivacyService } from './household-privacy.service';

class PrivacyConsentGrantDto extends createZodDto(
  privacyConsentGrantRequestSchema,
) {}
class PrivacyConsentRevokeDto extends createZodDto(
  privacyConsentRevokeRequestSchema,
) {}
class PrivacyRetentionPreviewDto extends createZodDto(
  privacyRetentionPreviewRequestSchema,
) {}
class PrivacyRetentionUpdateDto extends createZodDto(
  privacyRetentionUpdateRequestSchema,
) {}

@Controller('households')
export class HouseholdPrivacyController {
  constructor(private readonly privacyService: HouseholdPrivacyService) {}

  /** GET /v1/households/:id/privacy — 내 동의 현황·이력·보관 현황. */
  @Get(':id/privacy')
  getOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PrivacyOverview> {
    return this.privacyService.getOverview(id, user.userId);
  }

  /** POST /v1/households/:id/privacy/consent — 동의·재동의(멱등). */
  @Post(':id/privacy/consent')
  @HttpCode(HttpStatus.OK)
  grantConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PrivacyConsentGrantDto,
  ): Promise<PrivacyOverview> {
    return this.privacyService.grantConsent(id, user.userId, dto);
  }

  /** POST /v1/households/:id/privacy/consent/revoke — 철회. */
  @Post(':id/privacy/consent/revoke')
  @HttpCode(HttpStatus.OK)
  revokeConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _dto: PrivacyConsentRevokeDto,
  ): Promise<PrivacyConsentRevokeResponse> {
    return this.privacyService.revokeConsent(id, user.userId);
  }

  /** POST /v1/households/:id/privacy/retention/preview — 정책 변경 영향 미리보기. */
  @Post(':id/privacy/retention/preview')
  @HttpCode(HttpStatus.OK)
  previewRetention(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PrivacyRetentionPreviewDto,
  ): Promise<PrivacyRetentionPreviewResponse> {
    return this.privacyService.previewRetention(id, user.userId, dto.policy);
  }

  /**
   * POST /v1/households/:id/privacy/retention — 정책 적용 + 즉시 purge.
   * 미리보기 건수와 어긋나면 409.
   */
  @Post(':id/privacy/retention')
  @HttpCode(HttpStatus.OK)
  updateRetention(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PrivacyRetentionUpdateDto,
  ): Promise<PrivacyRetentionUpdateResponse> {
    return this.privacyService.updateRetention(id, user.userId, dto);
  }
}
