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
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  acceptInvitationRequestSchema,
  type HouseholdSummary,
} from '@family/contracts';

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
