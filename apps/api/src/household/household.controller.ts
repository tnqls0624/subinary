/**
 * Household HTTP surface (Phase 1 Build Spec §4.3).
 *
 * All routes require authentication (the global {@link AccessTokenGuard} runs
 * unless a handler is `@Public()` — none here are). The authenticated principal
 * is passed to the service as `actorUserId`; the service enforces membership and
 * role. Request bodies are validated by the global `ZodValidationPipe` against
 * the `@family/contracts` schemas wrapped as DTOs.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  householdCreateRequestSchema,
  householdUpdateRequestSchema,
  invitationCreateRequestSchema,
  memberRoleUpdateRequestSchema,
  type HouseholdSummary,
  type InvitationCreated,
  type InvitationSummary,
  type MemberSummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { HouseholdService } from './household.service';

class HouseholdCreateDto extends createZodDto(householdCreateRequestSchema) {}
class HouseholdUpdateDto extends createZodDto(householdUpdateRequestSchema) {}
class InvitationCreateDto extends createZodDto(invitationCreateRequestSchema) {}
class MemberRoleUpdateDto extends createZodDto(memberRoleUpdateRequestSchema) {}

@Controller('households')
export class HouseholdController {
  constructor(private readonly householdService: HouseholdService) {}

  /** POST /v1/households — create a household (caller becomes owner). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: HouseholdCreateDto,
  ): Promise<HouseholdSummary> {
    return this.householdService.create(user.userId, dto);
  }

  /** GET /v1/households/:id — household summary for a member. */
  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<HouseholdSummary> {
    return this.householdService.get(id, user.userId);
  }

  /** PATCH /v1/households/:id — rename (owner or admin). */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: HouseholdUpdateDto,
  ): Promise<HouseholdSummary> {
    return this.householdService.update(id, user.userId, dto);
  }

  /** POST /v1/households/:id/invitations — create an invitation (owner). */
  @Post(':id/invitations')
  @HttpCode(HttpStatus.CREATED)
  createInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: InvitationCreateDto,
  ): Promise<InvitationCreated> {
    return this.householdService.createInvitation(id, user.userId, dto);
  }

  /** GET /v1/households/:id/invitations — list invitations (owner or admin). */
  @Get(':id/invitations')
  listInvitations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InvitationSummary[]> {
    return this.householdService.listInvitations(id, user.userId);
  }

  /** GET /v1/households/:id/members — list members (any active member). */
  @Get(':id/members')
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<MemberSummary[]> {
    return this.householdService.listMembers(id, user.userId);
  }

  /** PATCH /v1/households/:id/members/:memberId — change a member role (owner). */
  @Patch(':id/members/:memberId')
  updateMemberRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() dto: MemberRoleUpdateDto,
  ): Promise<MemberSummary> {
    return this.householdService.updateMemberRole(
      id,
      user.userId,
      memberId,
      dto,
    );
  }

  /** DELETE /v1/households/:id/members/:memberId — remove a member (owner/self). */
  @Delete(':id/members/:memberId')
  @HttpCode(HttpStatus.OK)
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ): Promise<{ removed: true }> {
    return this.householdService.removeMember(id, user.userId, memberId);
  }

  /** DELETE /v1/households/:id/invitations/:invitationId — revoke (owner). */
  @Delete(':id/invitations/:invitationId')
  @HttpCode(HttpStatus.OK)
  revokeInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
  ): Promise<InvitationSummary> {
    return this.householdService.revokeInvitation(
      id,
      user.userId,
      invitationId,
    );
  }
}
