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
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

import type {
  CardCreateRequest,
  CardSummary,
  CardUpdateRequest,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

/** Trailing 4 digits used for auto-link/backfill matching (min 4 digits). */
const CARD_TAIL_LENGTH = 4;

/**
 * Card registration result: the card plus how many previously-unlinked
 * transactions this registration retroactively linked (backfill). Kept out of
 * the shared `CardSummary` because it is meaningful only on create.
 */
export type CardCreateResult = CardSummary & {
  linkedTransactionCount: number;
};

/** Digits-only last 4, tolerating `****1234` vs `1234`; null under 4 digits. */
function lastFourDigits(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length < CARD_TAIL_LENGTH ? null : digits.slice(-CARD_TAIL_LENGTH);
}

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
   *
   * After insert, retroactively links previously-unlinked transactions whose
   * source SMS shares this card's last 4 digits ({@link backfillUnlinked}) and
   * returns the count so the UI can disclose the (visibility-changing) backfill.
   */
  async create(
    userId: string,
    input: CardCreateRequest,
  ): Promise<CardCreateResult> {
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

    const linkedTransactionCount = await this.backfillUnlinked(created);
    return { ...toCardSummary(created), linkedTransactionCount };
  }

  /**
   * Retroactively links previously-unlinked transactions to a newly registered
   * card by matching the card's last 4 digits against each transaction's source
   * SMS (`card_sms_events.maskedCardNumber`). Auto-linking is not retroactive on
   * its own (promotion only sees cards that existed at the time), so without this
   * a card registered after its transactions arrived would never claim them.
   *
   * Safeguards mirror the promotion path:
   * - only when this card is the *unique* active card with that tail (otherwise
   *   the attribution is ambiguous — same guard as worker `resolveCard`);
   * - only `cardId IS NULL` rows, and never `pending_review` rows (those were
   *   flagged for human review and must not be silently claimed);
   * - linked rows inherit the card's visibility (consistent with promotion and
   *   manual assignment — linking a card means its visibility applies).
   *
   * Best-effort: a failure here never fails card creation (returns 0).
   */
  private async backfillUnlinked(
    card: schema.PaymentCard,
  ): Promise<number> {
    const tail = lastFourDigits(card.maskedNumber);
    if (!tail) {
      return 0;
    }

    try {
      // 모호성 가드: 같은 뒤 4자리 활성 카드가 유일할 때만 소급 연결한다.
      const activeCards = await this.db
        .select({ maskedNumber: schema.paymentCards.maskedNumber })
        .from(schema.paymentCards)
        .where(
          and(
            eq(schema.paymentCards.householdId, card.householdId),
            eq(schema.paymentCards.status, 'active'),
          ),
        );
      const sameTail = activeCards.filter(
        (c) => lastFourDigits(c.maskedNumber) === tail,
      );
      if (sameTail.length !== 1) {
        return 0;
      }

      // cardId=null·비검토(pending_review 제외) 거래 중 원본 SMS 뒤 4자리 일치분.
      const candidates = await this.db
        .select({
          id: schema.cardTransactions.id,
          maskedCardNumber: schema.cardSmsEvents.maskedCardNumber,
        })
        .from(schema.cardTransactions)
        .innerJoin(
          schema.cardSmsEvents,
          eq(schema.cardSmsEvents.id, schema.cardTransactions.sourceEventId),
        )
        .where(
          and(
            eq(schema.cardTransactions.householdId, card.householdId),
            isNull(schema.cardTransactions.cardId),
            ne(schema.cardTransactions.status, 'pending_review'),
          ),
        );

      const matchIds = candidates
        .filter((c) => lastFourDigits(c.maskedCardNumber) === tail)
        .map((c) => c.id);
      if (matchIds.length === 0) {
        return 0;
      }

      await this.db
        .update(schema.cardTransactions)
        .set({
          cardId: card.id,
          visibility: card.visibility,
          updatedAt: new Date(),
        })
        .where(inArray(schema.cardTransactions.id, matchIds));

      return matchIds.length;
    } catch {
      return 0;
    }
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
