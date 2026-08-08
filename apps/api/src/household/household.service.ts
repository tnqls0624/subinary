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
import { and, desc, eq, inArray } from 'drizzle-orm';

import type {
  AcceptInvitationRequest,
  HouseholdCreateRequest,
  HouseholdRole,
  HouseholdSummary,
  HouseholdUpdateRequest,
  InvitationCreateRequest,
  InvitationCreated,
  InvitationPreview,
  InvitationSummary,
  MemberColorUpdateRequest,
  MemberRoleUpdateRequest,
  MemberSummary,
} from '@family/contracts';
import { schema, type Db, type DbExecutor } from '@family/database';

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

/**
 * 초대자 이름 마스킹(`홍길동` → `홍*동`, `김철` → `김*`, `이` → `이`).
 *
 * 미리보기는 비인증 경로다. 받는 사람은 누가 초대했는지 이미 알고 있으므로 확인에는
 * 첫 글자와 끝 글자면 충분하고, 링크가 대화방·메일로 흘러나갔을 때 수집되는 값은
 * 줄어든다. 공백이 든 이름(영문 'Gil Dong Hong')은 토큰 단위로 각각 가린다.
 */
function maskPersonName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  return trimmed
    .split(/\s+/)
    .map((part) => {
      const chars = [...part];
      if (chars.length <= 1) return part;
      if (chars.length === 2) return `${chars[0]}*`;
      return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
    })
    .join(' ');
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

    // 멤버십 제거와 장치 폐기는 **같은 트랜잭션**이어야 한다. 멤버십만 removed가 되고
    // 장치가 살아남는 중간 상태에서는 떠난 사람의 폰이 계속 카드 문자를 밀어 넣는다
    // (양방향 침해: 떠난 사람은 동의 철회 후에도 수집되고, 남은 가족은 제거한
    // 구성원의 데이터를 계속 받는다).
    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(schema.householdMembers)
        .set({ status: 'removed', updatedAt: now })
        .where(eq(schema.householdMembers.id, targetMemberId));

      const revokedDevices = await tx
        .update(schema.registeredDevices)
        .set({
          status: 'revoked',
          revokedAt: now,
          updatedAt: now,
          // 수집 토큰 해시까지 지운다 — 장치 행이 어떤 경로로 다시 active가 되더라도
          // 이미 유출됐을 수 있는 옛 Bearer 토큰이 되살아나면 안 된다.
          collectTokenHash: null,
        })
        .where(
          and(
            eq(schema.registeredDevices.memberId, targetMemberId),
            eq(schema.registeredDevices.status, 'active'),
          ),
        )
        .returning({ id: schema.registeredDevices.id });

      if (revokedDevices.length > 0) {
        await tx
          .update(schema.deviceCredentials)
          .set({ status: 'revoked', revokedAt: now })
          .where(
            and(
              inArray(
                schema.deviceCredentials.deviceId,
                revokedDevices.map((device) => device.id),
              ),
              eq(schema.deviceCredentials.status, 'active'),
            ),
          );
      }
    });

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

  /**
   * 초대 미리보기 (`GET /v1/household-invitations/:token`, **비인증**).
   *
   * `/join`이 "어느 가족이, 누가, 어떤 역할로 초대했는지"를 보여준 뒤 동의를 받게
   * 하려면 로그인 전에 읽을 수 있어야 한다. 노출 범위와 그 근거는 계약
   * (`invitationPreviewSchema`)에 적어 뒀다 — 요약하면 `pending`일 때만 가족명·
   * 마스킹된 초대자명·역할을 주고, 그 외 상태에서는 상태와 만료 시각만 준다.
   *
   * 만료된 초대를 여기서 `expired`로 **기록하지 않는다.** GET은 쓰기를 하지 않으며,
   * 상태 전이는 수락 경로가 잠금 안에서 소유한다(그쪽이 유일한 직렬화 지점이다).
   * 대신 `expiresAt`이 지났으면 응답에서만 `expired`로 계산해 보여준다.
   *
   * 토큰이 없으면 404. 토큰은 256비트 난수(`randomBytes(32)`)라 추측으로 존재를
   * 캐낼 수 없으므로, 404/200 구분이 의미 있는 오라클이 되지 않는다.
   */
  async previewInvitation(rawToken: string): Promise<InvitationPreview> {
    const tokenHash = this.tokenService.hashToken(rawToken);

    const [row] = await this.db
      .select({
        status: schema.householdInvitations.status,
        role: schema.householdInvitations.role,
        email: schema.householdInvitations.email,
        expiresAt: schema.householdInvitations.expiresAt,
        householdName: schema.households.name,
        householdDeletedAt: schema.households.deletedAt,
        inviterName: schema.users.name,
      })
      .from(schema.householdInvitations)
      .innerJoin(
        schema.households,
        eq(schema.households.id, schema.householdInvitations.householdId),
      )
      .innerJoin(
        schema.users,
        eq(schema.users.id, schema.householdInvitations.createdBy),
      )
      .where(eq(schema.householdInvitations.tokenHash, tokenHash))
      .limit(1);

    if (!row) {
      throw new NotFoundException('invitation not found');
    }

    // 삭제된 가구의 초대는 수락해도 들어갈 곳이 없다 — 만료와 같게 취급해 이름을 막는다.
    const dead =
      row.householdDeletedAt !== null ||
      row.expiresAt.getTime() < Date.now();
    const status =
      row.status === 'pending' && dead ? ('expired' as const) : row.status;
    const usable = status === 'pending';

    return {
      status,
      expiresAt: row.expiresAt.toISOString(),
      householdName: usable ? row.householdName : null,
      inviterName: usable ? maskPersonName(row.inviterName) : null,
      role: usable ? row.role : null,
      emailRestricted: usable && row.email !== null,
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

    // 수락과 같은 잠금 순서(초대 행 FOR UPDATE → 상태 전이)를 쓴다. 잠그지 않으면
    // revoke와 accept가 겹칠 때 늦게 끝난 쪽이 상대의 상태를 덮어쓴다.
    return this.db.transaction(async (tx) => {
      const [invitation] = await tx
        .select()
        .from(schema.householdInvitations)
        .where(
          and(
            eq(schema.householdInvitations.id, invitationId),
            eq(schema.householdInvitations.householdId, householdId),
          ),
        )
        .for('update')
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
      const [updated] = await tx
        .update(schema.householdInvitations)
        .set({ status: 'revoked', revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.householdInvitations.id, invitationId),
            eq(schema.householdInvitations.status, 'pending'),
          ),
        )
        .returning();

      if (!updated) {
        throw new NotFoundException('invitation not found');
      }
      return toInvitationSummary(updated);
    });
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

    /*
     * 수락 **전 과정**을 한 트랜잭션에 넣고 초대 행을 `FOR UPDATE`로 잠근다.
     *
     * 왜 잠금인가(조건부 UPDATE claim 대신): 이메일 미지정 초대는 수락자가 정해져
     * 있지 않아 claim을 먼저 하면 이메일 불일치·비활성 가구 같은 정상 거절 경로에서도
     * 초대가 소모된다. 또 실패한 claim의 원인을 알려면 상태를 다시 읽어야 하는데,
     * 그 재조회가 또 경합한다. 행을 잠그면 기존 검사 순서와 에러 의미론
     * (accepted→409 / revoked·expired→410 / 이메일 불일치→403)을 **그대로 두고**
     * 동시 수락만 직렬화된다 — 뒤에 온 쪽은 잠금이 풀린 뒤 `accepted`를 보고 409다.
     *
     * DB unique는 (householdId, userId)뿐이라 **서로 다른 두 사용자**는 각각 다른 키로
     * 둘 다 커밋에 성공한다. 즉 이 잠금이 유일한 직렬화 지점이다.
     */
    const outcome = await this.db.transaction(async (tx) => {
      const [invitation] = await tx
        .select()
        .from(schema.householdInvitations)
        .where(eq(schema.householdInvitations.tokenHash, tokenHash))
        .for('update')
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
        // 만료 표기는 커밋되어야 하므로 여기서 던지지 않고 밖에서 410을 던진다.
        await tx
          .update(schema.householdInvitations)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(schema.householdInvitations.id, invitation.id));
        return { kind: 'expired' as const };
      }

      if (invitation.email) {
        const [user] = await tx
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        if (
          !user ||
          user.email.toLowerCase() !== invitation.email.toLowerCase()
        ) {
          throw new ForbiddenException('invitation is for a different account');
        }
      }

      const [existing] = await tx
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
        await this.markInvitationAccepted(tx, invitation.id, userId);
        const household = await this.loadHousehold(invitation.householdId, tx);
        return {
          kind: 'joined' as const,
          household,
          role: existing.role,
        };
      }

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

      await this.markInvitationAccepted(tx, invitation.id, userId);

      const [row] = await tx
        .select()
        .from(schema.households)
        .where(eq(schema.households.id, invitation.householdId))
        .limit(1);
      if (!row) {
        throw new NotFoundException('household not found');
      }
      return { kind: 'joined' as const, household: row, role: invitation.role };
    });

    if (outcome.kind === 'expired') {
      throw new GoneException('invitation has expired');
    }
    return toHouseholdSummary(outcome.household, outcome.role);
  }

  /* ---------------------------------------------------------------------- */
  /* Internal loaders                                                        */
  /* ---------------------------------------------------------------------- */

  private async loadHousehold(
    householdId: string,
    executor: DbExecutor = this.db,
  ): Promise<schema.Household> {
    const [household] = await executor
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

  /**
   * 초대를 `accepted`로 마감한다. 호출부는 이미 초대 행을 `FOR UPDATE`로 잠근
   * 트랜잭션 안이므로 여기서 상태를 다시 확인하지 않는다 — 대신 실행기를 반드시
   * 그 트랜잭션(`tx`)으로 받아 잠금 밖에서 쓰이는 일이 없게 한다.
   */
  private async markInvitationAccepted(
    executor: DbExecutor,
    invitationId: string,
    userId: string,
  ): Promise<void> {
    const acceptedAt = new Date();
    await executor
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
