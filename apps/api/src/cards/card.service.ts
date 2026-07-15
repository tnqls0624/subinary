/**
 * Payment-card domain service (Phase 4 Build Spec §5.1).
 *
 * Authorization is enforced *here* in the service layer against `actorUserId`
 * (PRD §26/§8) — controllers never make trust decisions. Every path resolves
 * the caller's active household membership first (a lightweight
 * `requireMembership` helper), so a non-member always receives a 403 and never
 * learns whether the household or card exists.
 *
 * `maskedNumber` hygiene: this value is used only to auto-link parsed card-SMS
 * to a card by its **last 4 digits** (spec §1.5; parser emits `****1234`).
 * Callers SHOULD persist only the last 4 digits (e.g. `'1234'`) — never a full
 * PAN. The value and any other PII are never logged.
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import type {
  CardCreateRequest,
  CardSummary,
  CardUpdateRequest,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';

/** Roles permitted to manage a card they do not personally own (spec §5.1). */
const MANAGER_ROLES: readonly schema.HouseholdMember['role'][] = [
  'owner',
  'admin',
];

/** Projects a payment-card row onto its public-safe summary (no fingerprint). */
function toCardSummary(card: schema.PaymentCard): CardSummary {
  return {
    id: card.id,
    householdId: card.householdId,
    ownerMemberId: card.ownerMemberId,
    issuer: card.issuer,
    alias: card.alias,
    maskedNumber: card.maskedNumber,
    visibility: card.visibility,
    status: card.status,
    createdAt: card.createdAt.toISOString(),
  };
}

@Injectable()
export class CardService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ---------------------------------------------------------------------- */
  /* Authorization helper                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforces that `userId` is an active member of `householdId`. Non-members
   * get a 403 that does not disclose whether the household exists (PRD §26).
   * Returns the membership so callers can apply owner/role checks.
   */
  private async requireMembership(
    householdId: string,
    userId: string,
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
    return member;
  }

  /* ---------------------------------------------------------------------- */
  /* Card management                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Registers a card under the caller's household. The card's `ownerMemberId`
   * is always the creator's own membership, so any active member may register
   * their own card. `visibility` governs the visibility of transactions later
   * auto-linked to this card (spec §1.4/§1.5).
   */
  async create(
    userId: string,
    input: CardCreateRequest,
  ): Promise<CardSummary> {
    const membership = await this.requireMembership(input.householdId, userId);

    const [created] = await this.db
      .insert(schema.paymentCards)
      .values({
        householdId: input.householdId,
        ownerMemberId: membership.id,
        issuer: input.issuer,
        alias: input.alias,
        // 저장 권장: 카드번호 뒤 4자리만(자동연결은 뒤 4자리 매칭, §1.5). 전체 PAN 금지.
        maskedNumber: input.maskedNumber ?? null,
        visibility: input.visibility,
        createdBy: userId,
      })
      .returning();

    if (!created) {
      throw new Error('failed to create payment card');
    }
    return toCardSummary(created);
  }

  /** Lists every card in the caller's household (any active member). */
  async list(userId: string, householdId: string): Promise<CardSummary[]> {
    await this.requireMembership(householdId, userId);

    const rows = await this.db
      .select()
      .from(schema.paymentCards)
      .where(eq(schema.paymentCards.householdId, householdId))
      .orderBy(desc(schema.paymentCards.createdAt));

    return rows.map(toCardSummary);
  }

  /** Returns a single card scoped to the caller's household membership. */
  async get(userId: string, id: string): Promise<CardSummary> {
    const card = await this.loadCard(id);
    await this.requireMembership(card.householdId, userId);
    return toCardSummary(card);
  }

  /**
   * Updates a card's `alias` / `visibility` / `status`. Permitted for the card
   * owner (its `ownerMemberId` is the caller's membership) or a household
   * owner/admin (spec §5.1). Everyone else gets a 403.
   */
  async update(
    userId: string,
    id: string,
    input: CardUpdateRequest,
  ): Promise<CardSummary> {
    const card = await this.loadCard(id);
    const membership = await this.requireMembership(card.householdId, userId);

    const isOwner = membership.id === card.ownerMemberId;
    const isManager = MANAGER_ROLES.includes(membership.role);
    if (!isOwner && !isManager) {
      throw new ForbiddenException('insufficient permission');
    }

    const patch: {
      alias?: string;
      visibility?: schema.PaymentCard['visibility'];
      status?: schema.PaymentCard['status'];
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (input.alias !== undefined) {
      patch.alias = input.alias;
    }
    if (input.visibility !== undefined) {
      patch.visibility = input.visibility;
    }
    if (input.status !== undefined) {
      patch.status = input.status;
    }

    const [updated] = await this.db
      .update(schema.paymentCards)
      .set(patch)
      .where(eq(schema.paymentCards.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundException('card not found');
    }
    return toCardSummary(updated);
  }

  /* ---------------------------------------------------------------------- */
  /* Internal loaders                                                        */
  /* ---------------------------------------------------------------------- */

  private async loadCard(id: string): Promise<schema.PaymentCard> {
    const [card] = await this.db
      .select()
      .from(schema.paymentCards)
      .where(eq(schema.paymentCards.id, id))
      .limit(1);
    if (!card) {
      throw new NotFoundException('card not found');
    }
    return card;
  }
}
