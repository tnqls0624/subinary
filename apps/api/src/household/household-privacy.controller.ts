/**
 * 개인정보 Control Center HTTP 표면 (C-3 1단계).
 *
 * `HouseholdController`와 프리픽스를 공유하지만 파일을 나눈 이유: 이 세 경로는 동의와
 * 보관 현황이라는 별도 관심사이고, 권한 판정도 서비스 계층
 * ({@link HouseholdPrivacyService})에 있어 컨트롤러가 신뢰 결정을 하지 않는다.
 *
 * 경로에 `:id`(가구)를 두는 이유: 동의는 **가구별**이다. 두 가족에 속한 사용자가 한쪽
 * 동의만 철회할 수 있어야 한다.
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
  type PrivacyConsentRevokeResponse,
  type PrivacyOverview,
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

  /**
   * POST /v1/households/:id/privacy/consent/revoke — 철회.
   *
   * 본문의 `confirm: true`는 계약이 강제한다(z.literal(true)). 실수로 도달하는 경로가
   * 없어야 하기 때문이고, 되돌리려면 위 consent 경로로 재동의하면 된다.
   */
  @Post(':id/privacy/consent/revoke')
  @HttpCode(HttpStatus.OK)
  revokeConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _dto: PrivacyConsentRevokeDto,
  ): Promise<PrivacyConsentRevokeResponse> {
    return this.privacyService.revokeConsent(id, user.userId);
  }
}
