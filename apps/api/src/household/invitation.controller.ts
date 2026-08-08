/**
 * Invitation acceptance surface (Phase 1 Build Spec §4.3).
 *
 * Separate top-level controller so the accept URL (`/v1/household-invitations/
 * :token/accept`) is independent of any household the caller does not yet belong
 * to. Authentication is required — the accepting user is resolved from the
 * access token, and explicit consent is validated in the body.
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
  acceptInvitationRequestSchema,
  type HouseholdSummary,
  type InvitationPreview,
} from '@family/contracts';

import { Public } from '../auth/decorators/public.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { HouseholdService } from './household.service';

class AcceptInvitationDto extends createZodDto(acceptInvitationRequestSchema) {}

@Controller('household-invitations')
export class InvitationController {
  constructor(private readonly householdService: HouseholdService) {}

  /**
   * GET /v1/household-invitations/:token — 수락 전 미리보기.
   *
   * **의도적으로 `@Public()`이다.** 초대받은 사람은 계정이 없을 수도 있는데,
   * "어느 가족이 초대했는지"를 로그인 뒤에야 알려 주면 그 전에 이미 링크를 닫는다.
   * 노출을 최소화하는 판단(가족명 노출 / 초대자명 마스킹 / 이메일 비노출 /
   * 만료·수락·취소 시 전부 차단)은 서비스와 계약 주석에 근거를 남겼다.
   *
   * rate limit: 전역 일반 버킷(IP당 600회/분, `main.ts`)이 적용된다. 토큰이
   * 256비트 난수라 열거 자체가 불가능하므로 인증 버킷만큼 조일 실익이 없다.
   */
  @Public()
  @Get(':token')
  preview(@Param('token') token: string): Promise<InvitationPreview> {
    return this.householdService.previewInvitation(token);
  }

  /**
   * POST /v1/household-invitations/:token/accept — join a household by raw
   * invitation token, with explicit consent.
   */
  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
  ): Promise<HouseholdSummary> {
    return this.householdService.acceptInvitation(token, user.userId, dto);
  }
}
