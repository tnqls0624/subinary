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
  BadRequestException,
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

/**
 * 발급사 비교용 정규화 키. 등록 카드는 `현대`, 파싱 이벤트는 `현대카드`처럼 '카드'
 * 접미사가 달라 공백·접미사를 제거해 맞춘다. 일반 `카드`(특정 실패)는 빈 키(→ null)가
 * 되어 매칭에서 제외된다. worker `resolveCard`의 동일 규칙과 대칭.
 */
function normalizeIssuer(value: string | null): string | null {
  if (!value) return null;
  const key = value.replace(/\s+/g, '').replace(/카드$/, '');
  return key.length > 0 ? key : null;
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

  /**
   * Validates that `memberId` is an **active** member of `householdId` — used to
   * guard card owner assignment/reassignment. A card's owner drives its icon
   * color and owner-scoped permissions, so an owner outside the household (or
   * inactive) must be rejected. 400 rather than 404 (client sent a bad owner).
   */
  private async assertActiveMember(
    householdId: string,
    memberId: string,
  ): Promise<void> {
    const [member] = await this.db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.id, memberId),
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);
    if (!member) {
      throw new BadRequestException('owner must be an active household member');
    }
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

    // 소유자: 지정 없으면 등록자 본인. 다른 구성원 지정 시 같은 household의 활성
    // 구성원인지 검증한다(아이콘 색·소유자 권한이 여기서 결정됨).
    const ownerMemberId = input.ownerMemberId ?? membership.id;
    if (ownerMemberId !== membership.id) {
      await this.assertActiveMember(input.householdId, ownerMemberId);
    }

    const [created] = await this.db
      .insert(schema.paymentCards)
      .values({
        householdId: input.householdId,
        ownerMemberId,
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
   * - 뒤 4자리 매칭: 같은 뒤 4자리 활성 카드가 *유일*할 때만(모호성 방지);
   * - 발급사 매칭(번호 없는 문자): 같은 발급사 활성 카드가 *유일*할 때만, 원본 SMS에
   *   카드번호가 없는 거래에 한해(뒤 4자리로 붙는 거래와 배타적) — worker `resolveCard`
   *   발급사 폴백과 대칭;
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
    const issuerKey = normalizeIssuer(card.issuer);
    if (!tail && !issuerKey) {
      return 0;
    }

    try {
      const activeCards = await this.db
        .select({
          maskedNumber: schema.paymentCards.maskedNumber,
          issuer: schema.paymentCards.issuer,
        })
        .from(schema.paymentCards)
        .where(
          and(
            eq(schema.paymentCards.householdId, card.householdId),
            eq(schema.paymentCards.status, 'active'),
          ),
        );

      // 모호성 가드: 같은 뒤 4자리 / 같은 발급사 활성 카드가 각각 유일할 때만 적용.
      const tailUnique =
        tail != null &&
        activeCards.filter((c) => lastFourDigits(c.maskedNumber) === tail)
          .length === 1;
      const issuerUnique =
        issuerKey != null &&
        activeCards.filter((c) => normalizeIssuer(c.issuer) === issuerKey)
          .length === 1;
      if (!tailUnique && !issuerUnique) {
        return 0;
      }

      // cardId=null·비검토 거래 + 원본 SMS의 뒤 4자리·발급사.
      const candidates = await this.db
        .select({
          id: schema.cardTransactions.id,
          maskedCardNumber: schema.cardSmsEvents.maskedCardNumber,
          issuer: schema.cardSmsEvents.issuer,
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

      const matchIds = new Set<string>();
      for (const c of candidates) {
        const cTail = lastFourDigits(c.maskedCardNumber);
        // 뒤 4자리 일치(번호 있는 거래).
        if (tailUnique && cTail === tail) {
          matchIds.add(c.id);
          continue;
        }
        // 번호 없는 거래 → 발급사 일치.
        if (issuerUnique && !cTail && normalizeIssuer(c.issuer) === issuerKey) {
          matchIds.add(c.id);
        }
      }
      if (matchIds.size === 0) {
        return 0;
      }

      await this.db
        .update(schema.cardTransactions)
        .set({
          cardId: card.id,
          visibility: card.visibility,
          updatedAt: new Date(),
        })
        .where(inArray(schema.cardTransactions.id, [...matchIds]));

      return matchIds.size;
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
      ownerMemberId?: string;
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
    // 소유자 재지정: 같은 household의 활성 구성원만 허용. 아이콘 색이 새 소유자
    // 색으로 바뀐다. 권한은 위 isOwner/isManager 게이트를 그대로 따른다.
    if (input.ownerMemberId !== undefined) {
      await this.assertActiveMember(card.householdId, input.ownerMemberId);
      patch.ownerMemberId = input.ownerMemberId;
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
