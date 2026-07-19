/**
 * Household domain service (Phase 1 Build Spec §4.3).
 *
 * Authorization is enforced *here* in the service layer against `actorUserId`
 * (PRD §26) — controllers never make trust decisions. Every mutating path runs
 * `requireMembership` first, so a non-member always receives a 403 and never
 * learns whether the target household exists.
 *
 * Secret hygiene: raw invitation tokens are generated locally and only their
 * sha256 hash (via {@link TokenService.hashToken}) is persisted. Neither the raw
 * token nor its hash is ever logged.
 */
import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import type {
  AcceptInvitationRequest,
  HouseholdCreateRequest,
  HouseholdRole,
  HouseholdSummary,
  HouseholdUpdateRequest,
  InvitationCreateRequest,
  InvitationCreated,
  InvitationSummary,
  MemberColorUpdateRequest,
  MemberRoleUpdateRequest,
  MemberSummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { TokenService } from '../auth/token.service';
import { DB } from '../database/database.constants';

/** Projection used for member listings (user profile joined onto membership). */
const MEMBER_COLUMNS = {
  memberId: schema.householdMembers.id,
  userId: schema.householdMembers.userId,
  name: schema.users.name,
  email: schema.users.email,
  role: schema.householdMembers.role,
  status: schema.householdMembers.status,
  color: schema.householdMembers.color,
  joinedAt: schema.householdMembers.joinedAt,
};

interface MemberRow {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: HouseholdRole;
  status: 'active' | 'removed';
  color: string | null;
  joinedAt: Date;
}

function toMemberSummary(row: MemberRow): MemberSummary {
  return {
    memberId: row.memberId,
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    // DB는 text — 쓰기 경로가 zod(memberColorSchema)로 검증하므로 좁혀도 안전.
    color: (row.color as MemberSummary['color']) ?? null,
    joinedAt: row.joinedAt.toISOString(),
  };
}

function toHouseholdSummary(
  household: schema.Household,
  myRole: HouseholdRole,
): HouseholdSummary {
  return {
    id: household.id,
    name: household.name,
    createdAt: household.createdAt.toISOString(),
    myRole,
  };
}

function toInvitationSummary(
  invitation: schema.HouseholdInvitation,
): InvitationSummary {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
  };
}

@Injectable()
export class HouseholdService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokenService: TokenService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Authorization helper                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforces that `userId` is an active member of `householdId` and (optionally)
   * holds one of `roles`. Returns the membership record for callers that need
   * the actor's role. Non-members get a 403 that does not disclose existence.
   */
  private async requireMembership(
    householdId: string,
    userId: string,
    roles?: readonly HouseholdRole[],
  ): Promise<schema.HouseholdMember> {
    const [member] = await this.db
      .select()
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);

    if (!member) {
      throw new ForbiddenException('not a household member');
    }
    if (roles && !roles.includes(member.role)) {
      throw new ForbiddenException('insufficient role');
    }
    return member;
  }

  /* ---------------------------------------------------------------------- */
  /* Households                                                              */
  /* ---------------------------------------------------------------------- */

  /** Creates a household and registers the creator as its owner (+ consent). */
  async create(
    userId: string,
    input: HouseholdCreateRequest,
  ): Promise<HouseholdSummary> {
    const household = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.households)
        .values({ name: input.name, createdBy: userId })
        .returning();
      if (!created) {
        throw new Error('failed to create household');
      }

      await tx.insert(schema.householdMembers).values({
        householdId: created.id,
        userId,
        role: 'owner',
        status: 'active',
      });

      await tx.insert(schema.householdConsents).values({
        householdId: created.id,
        userId,
        consentType: 'household_join',
      });

      return created;
    });

    return toHouseholdSummary(household, 'owner');
  }

  /** Returns the household as seen by a member (any active role). */
  async get(householdId: string, userId: string): Promise<HouseholdSummary> {
    const member = await this.requireMembership(householdId, userId);
    const household = await this.loadHousehold(householdId);
    return toHouseholdSummary(household, member.role);
  }

  /** Renames a household (owner or admin). */
  async update(
    householdId: string,
    userId: string,
    input: HouseholdUpdateRequest,
  ): Promise<HouseholdSummary> {
    const member = await this.requireMembership(householdId, userId, [
      'owner',
      'admin',
    ]);

    const [updated] = await this.db
      .update(schema.households)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(schema.households.id, householdId))
      .returning();

    if (!updated) {
      throw new NotFoundException('household not found');
    }
    return toHouseholdSummary(updated, member.role);
  }

  /* ---------------------------------------------------------------------- */
  /* Members                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Lists all members (with joined user profile) for any active member. */
  async listMembers(
    householdId: string,
    userId: string,
  ): Promise<MemberSummary[]> {
    await this.requireMembership(householdId, userId);

    const rows = await this.db
      .select(MEMBER_COLUMNS)
      .from(schema.householdMembers)
      .innerJoin(
        schema.users,
        eq(schema.householdMembers.userId, schema.users.id),
      )
      .where(eq(schema.householdMembers.householdId, householdId))
      .orderBy(schema.householdMembers.joinedAt);

    return rows.map(toMemberSummary);
  }

  /** Changes a member's role (owner only). Owner rows are immutable here. */
  async updateMemberRole(
    householdId: string,
    userId: string,
    targetMemberId: string,
    input: MemberRoleUpdateRequest,
  ): Promise<MemberSummary> {
    await this.requireMembership(householdId, userId, ['owner']);

    const target = await this.loadMember(householdId, targetMemberId);
    if (target.role === 'owner') {
      // Ownership transfer / owner demotion is out of scope for Phase 1.
      throw new ForbiddenException('cannot change an owner role');
    }

    await this.db
      .update(schema.householdMembers)
      .set({ role: input.role, updatedAt: new Date() })
      .where(eq(schema.householdMembers.id, targetMemberId));

    return this.loadMemberSummary(targetMemberId);
  }

  /**
   * Sets a member's accent color (`null` resets to automatic). Allowed for the
   * member themselves, or for an owner/admin changing anyone's color — the
   * color is a shared visual identifier (transactions/cards), not private data.
   */
  async updateMemberColor(
    householdId: string,
    userId: string,
    targetMemberId: string,
    input: MemberColorUpdateRequest,
  ): Promise<MemberSummary> {
    const actor = await this.requireMembership(householdId, userId);
    const target = await this.loadMember(householdId, targetMemberId);

    const isSelf = target.userId === userId;
    if (!isSelf && actor.role !== 'owner' && actor.role !== 'admin') {
      throw new ForbiddenException('insufficient role');
    }
    // UI(활성 행만 색상 편집 노출)와 정책 일치 — removed 행은 API로도 거부.
    if (target.status !== 'active') {
      throw new BadRequestException('cannot set color for a removed member');
    }

    await this.db
      .update(schema.householdMembers)
      .set({ color: input.color, updatedAt: new Date() })
      .where(eq(schema.householdMembers.id, targetMemberId));

    return this.loadMemberSummary(targetMemberId);
  }

  /**
   * Removes a member (soft delete). Allowed for the household owner, or for a
   * member removing themselves. The last active owner can never be removed.
   * Idempotent: removing an already-removed member succeeds.
   */
  async removeMember(
    householdId: string,
    userId: string,
    targetMemberId: string,
  ): Promise<{ removed: true }> {
    const actor = await this.requireMembership(householdId, userId);
    const target = await this.loadMember(householdId, targetMemberId);

    const isSelf = target.userId === userId;
    if (actor.role !== 'owner' && !isSelf) {
      throw new ForbiddenException('insufficient role');
    }

    if (target.status === 'removed') {
      return { removed: true };
    }

    if (target.role === 'owner') {
      const activeOwners = await this.db
        .select({ id: schema.householdMembers.id })
        .from(schema.householdMembers)
        .where(
          and(
            eq(schema.householdMembers.householdId, householdId),
            eq(schema.householdMembers.role, 'owner'),
            eq(schema.householdMembers.status, 'active'),
          ),
        );
      if (activeOwners.length <= 1) {
        throw new BadRequestException('cannot remove the last owner');
      }
    }

    await this.db
      .update(schema.householdMembers)
      .set({ status: 'removed', updatedAt: new Date() })
      .where(eq(schema.householdMembers.id, targetMemberId));

    return { removed: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Invitations                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates an invitation (owner only). The raw token is returned exactly once;
   * only its hash is stored. `acceptUrlPath` embeds the raw token for the
   * invitee.
   */
  async createInvitation(
    householdId: string,
    userId: string,
    input: InvitationCreateRequest,
  ): Promise<InvitationCreated> {
    await this.requireMembership(householdId, userId, ['owner']);

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenService.hashToken(rawToken);
    const expiresAt = new Date(
      Date.now() + input.expiresInHours * 60 * 60 * 1000,
    );

    const [invitation] = await this.db
      .insert(schema.householdInvitations)
      .values({
        householdId,
        email: input.email ? input.email.toLowerCase() : null,
        role: input.role,
        tokenHash,
        status: 'pending',
        expiresAt,
        createdBy: userId,
      })
      .returning();

    if (!invitation) {
      throw new Error('failed to create invitation');
    }

    return {
      invitationId: invitation.id,
      token: rawToken,
      expiresAt: invitation.expiresAt.toISOString(),
      role: invitation.role,
      acceptUrlPath: `/v1/household-invitations/${rawToken}/accept`,
    };
  }

  /** Lists a household's invitations (owner or admin). Never exposes tokens. */
  async listInvitations(
    householdId: string,
    userId: string,
  ): Promise<InvitationSummary[]> {
    await this.requireMembership(householdId, userId, ['owner', 'admin']);

    const rows = await this.db
      .select()
      .from(schema.householdInvitations)
      .where(eq(schema.householdInvitations.householdId, householdId))
      .orderBy(desc(schema.householdInvitations.createdAt));

    return rows.map(toInvitationSummary);
  }

  /** Revokes a pending invitation (owner only). Idempotent on already-revoked. */
  async revokeInvitation(
    householdId: string,
    userId: string,
    invitationId: string,
  ): Promise<InvitationSummary> {
    await this.requireMembership(householdId, userId, ['owner']);

    const [invitation] = await this.db
      .select()
      .from(schema.householdInvitations)
      .where(
        and(
          eq(schema.householdInvitations.id, invitationId),
          eq(schema.householdInvitations.householdId, householdId),
        ),
      )
      .limit(1);

    if (!invitation) {
      throw new NotFoundException('invitation not found');
    }
    if (invitation.status === 'revoked') {
      return toInvitationSummary(invitation);
    }
    if (invitation.status !== 'pending') {
      throw new ConflictException('invitation is no longer pending');
    }

    const now = new Date();
    const [updated] = await this.db
      .update(schema.householdInvitations)
      .set({ status: 'revoked', revokedAt: now, updatedAt: now })
      .where(eq(schema.householdInvitations.id, invitationId))
      .returning();

    if (!updated) {
      throw new NotFoundException('invitation not found');
    }
    return toInvitationSummary(updated);
  }

  /**
   * Accepts an invitation by raw token on behalf of `userId`.
   *
   * - `consent !== true` → 400 (explicit consent required, PRD §7.3).
   * - unknown token → 404.
   * - already accepted → 409 (reuse blocked).
   * - revoked → 410; expired → status persisted as `expired` then 410.
   * - targeted email mismatch → 403.
   * - already an active member → idempotent (invitation marked accepted).
   */
  async acceptInvitation(
    rawToken: string,
    userId: string,
    input: AcceptInvitationRequest,
  ): Promise<HouseholdSummary> {
    if (input.consent !== true) {
      throw new BadRequestException('consent is required to join a household');
    }

    const tokenHash = this.tokenService.hashToken(rawToken);
    const [invitation] = await this.db
      .select()
      .from(schema.householdInvitations)
      .where(eq(schema.householdInvitations.tokenHash, tokenHash))
      .limit(1);

    if (!invitation) {
      throw new NotFoundException('invitation not found');
    }

    switch (invitation.status) {
      case 'accepted':
        throw new ConflictException('invitation has already been accepted');
      case 'revoked':
        throw new GoneException('invitation has been revoked');
      case 'expired':
        throw new GoneException('invitation has expired');
      case 'pending':
        break;
    }

    if (invitation.expiresAt.getTime() < Date.now()) {
      await this.db
        .update(schema.householdInvitations)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(schema.householdInvitations.id, invitation.id));
      throw new GoneException('invitation has expired');
    }

    if (invitation.email) {
      const [user] = await this.db
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new ForbiddenException('invitation is for a different account');
      }
    }

    const [existing] = await this.db
      .select()
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, invitation.householdId),
          eq(schema.householdMembers.userId, userId),
        ),
      )
      .limit(1);

    // Already an active member: mark the invitation accepted and return the
    // existing membership (idempotent — no duplicate consent, no role change).
    if (existing && existing.status === 'active') {
      await this.markInvitationAccepted(invitation.id, userId);
      const household = await this.loadHousehold(invitation.householdId);
      return toHouseholdSummary(household, existing.role);
    }

    const household = await this.db.transaction(async (tx) => {
      if (existing) {
        // Re-activate a previously removed membership with the invited role
        // (avoids violating the unique (householdId, userId) constraint).
        await tx
          .update(schema.householdMembers)
          .set({
            role: invitation.role,
            status: 'active',
            joinedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.householdMembers.id, existing.id));
      } else {
        await tx.insert(schema.householdMembers).values({
          householdId: invitation.householdId,
          userId,
          role: invitation.role,
          status: 'active',
        });
      }

      await tx.insert(schema.householdConsents).values({
        householdId: invitation.householdId,
        userId,
        consentType: 'household_join',
      });

      const acceptedAt = new Date();
      await tx
        .update(schema.householdInvitations)
        .set({
          status: 'accepted',
          acceptedByUserId: userId,
          acceptedAt,
          updatedAt: acceptedAt,
        })
        .where(eq(schema.householdInvitations.id, invitation.id));

      const [row] = await tx
        .select()
        .from(schema.households)
        .where(eq(schema.households.id, invitation.householdId))
        .limit(1);
      return row;
    });

    if (!household) {
      throw new NotFoundException('household not found');
    }
    return toHouseholdSummary(household, invitation.role);
  }

  /* ---------------------------------------------------------------------- */
  /* Internal loaders                                                        */
  /* ---------------------------------------------------------------------- */

  private async loadHousehold(householdId: string): Promise<schema.Household> {
    const [household] = await this.db
      .select()
      .from(schema.households)
      .where(eq(schema.households.id, householdId))
      .limit(1);
    if (!household || household.deletedAt) {
      throw new NotFoundException('household not found');
    }
    return household;
  }

  private async loadMember(
    householdId: string,
    memberId: string,
  ): Promise<schema.HouseholdMember> {
    const [member] = await this.db
      .select()
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.id, memberId),
          eq(schema.householdMembers.householdId, householdId),
        ),
      )
      .limit(1);
    if (!member) {
      throw new NotFoundException('member not found');
    }
    return member;
  }

  private async loadMemberSummary(memberId: string): Promise<MemberSummary> {
    const [row] = await this.db
      .select(MEMBER_COLUMNS)
      .from(schema.householdMembers)
      .innerJoin(
        schema.users,
        eq(schema.householdMembers.userId, schema.users.id),
      )
      .where(eq(schema.householdMembers.id, memberId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('member not found');
    }
    return toMemberSummary(row);
  }

  private async markInvitationAccepted(
    invitationId: string,
    userId: string,
  ): Promise<void> {
    const acceptedAt = new Date();
    await this.db
      .update(schema.householdInvitations)
      .set({
        status: 'accepted',
        acceptedByUserId: userId,
        acceptedAt,
        updatedAt: acceptedAt,
      })
      .where(eq(schema.householdInvitations.id, invitationId));
  }
}
