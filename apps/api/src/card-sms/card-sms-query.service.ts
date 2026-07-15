/**
 * Card-SMS query service (Phase 3 Build Spec §5.2).
 *
 * Read side of the card-SMS feature. Authorization is enforced here in the
 * service layer against `actorUserId` (PRD §26): every path runs a lightweight
 * `requireMembership` check first, so a non-member always receives a 403 and
 * never learns whether the household or event exists.
 *
 * `list` returns lightweight summaries (no raw text) with keyset pagination;
 * `get` returns the full detail including `rawContent` for reviewing parse
 * failures (spec completion condition §0.4).
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';

import type {
  CardSmsEventDetail,
  CardSmsEventSummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';

/** Pagination bounds (spec §5.2 — default 50, max 100). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Valid parse-status filter values (spec §2 `cardSmsParseStatus`). */
const PARSE_STATUSES = [
  'pending',
  'parsed',
  'parse_failed',
  'pending_review',
] as const;
type ParseStatus = (typeof PARSE_STATUSES)[number];

/** Decoded keyset cursor: order by `(createdAt desc, id desc)`. */
interface Cursor {
  createdAt: Date;
  id: string;
}

@Injectable()
export class CardSmsQueryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Lists card-SMS event summaries for a household the actor belongs to,
   * optionally filtered by parse status. Newest first, keyset-paginated.
   */
  async list(
    userId: string,
    householdId: string,
    status: string | undefined,
    limit: string | undefined,
    cursor: string | undefined,
  ): Promise<CardSmsEventSummary[]> {
    if (!householdId) {
      throw new BadRequestException('householdId is required');
    }
    await this.requireMembership(householdId, userId);

    const take = this.parseLimit(limit);
    const statusFilter = this.parseStatus(status);
    const keyset = this.decodeCursor(cursor);

    const conditions: SQL[] = [
      eq(schema.cardSmsEvents.householdId, householdId),
    ];
    if (statusFilter) {
      conditions.push(eq(schema.cardSmsEvents.parseStatus, statusFilter));
    }
    if (keyset) {
      const after = or(
        lt(schema.cardSmsEvents.createdAt, keyset.createdAt),
        and(
          eq(schema.cardSmsEvents.createdAt, keyset.createdAt),
          lt(schema.cardSmsEvents.id, keyset.id),
        ),
      );
      if (after) {
        conditions.push(after);
      }
    }

    const rows = await this.db
      .select()
      .from(schema.cardSmsEvents)
      .where(and(...conditions))
      .orderBy(desc(schema.cardSmsEvents.createdAt), desc(schema.cardSmsEvents.id))
      .limit(take);

    return rows.map(toSummary);
  }

  /**
   * Returns the full detail (including `rawContent`) of a single event, scoped
   * to the actor's household membership.
   */
  async get(userId: string, id: string): Promise<CardSmsEventDetail> {
    const [event] = await this.db
      .select()
      .from(schema.cardSmsEvents)
      .where(eq(schema.cardSmsEvents.id, id))
      .limit(1);

    if (!event) {
      throw new NotFoundException('card-sms event not found');
    }
    await this.requireMembership(event.householdId, userId);
    return toDetail(event);
  }

  /* ---------------------------------------------------------------------- */
  /* Authorization + input helpers                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforces that `userId` is an active member of `householdId`. Non-members
   * get a 403 that does not disclose whether the household exists (PRD §26).
   */
  private async requireMembership(
    householdId: string,
    userId: string,
  ): Promise<void> {
    const [member] = await this.db
      .select({ id: schema.householdMembers.id })
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
  }

  /** Clamps the requested page size to `[1, MAX_LIMIT]` (default 50). */
  private parseLimit(limit: string | undefined): number {
    if (limit === undefined) {
      return DEFAULT_LIMIT;
    }
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return Math.min(parsed, MAX_LIMIT);
  }

  /** Validates the optional parse-status filter against the known enum. */
  private parseStatus(status: string | undefined): ParseStatus | undefined {
    if (status === undefined) {
      return undefined;
    }
    if (!PARSE_STATUSES.includes(status as ParseStatus)) {
      throw new BadRequestException('invalid status filter');
    }
    return status as ParseStatus;
  }

  /** Decodes an opaque `base64url("<epochMs>:<uuid>")` keyset cursor. */
  private decodeCursor(cursor: string | undefined): Cursor | undefined {
    if (cursor === undefined || cursor === '') {
      return undefined;
    }
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('invalid cursor');
    }
    const sep = decoded.indexOf(':');
    if (sep <= 0) {
      throw new BadRequestException('invalid cursor');
    }
    const epochMs = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isInteger(epochMs) || id === '') {
      throw new BadRequestException('invalid cursor');
    }
    return { createdAt: new Date(epochMs), id };
  }
}

/* -------------------------------------------------------------------------- */
/* Row → contract mappers                                                     */
/* -------------------------------------------------------------------------- */

/** Maps a card-SMS event row to its lightweight summary (no raw text). */
function toSummary(event: schema.CardSmsEvent): CardSmsEventSummary {
  return {
    id: event.id,
    eventId: event.eventId,
    sender: event.sender,
    receivedAt: event.receivedAt.toISOString(),
    parseStatus: event.parseStatus,
    issuer: event.issuer,
    transactionType: event.transactionType,
    amount: event.amount,
    currency: event.currency,
    merchantRaw: event.merchantRaw,
    occurredAt: event.occurredAt ? event.occurredAt.toISOString() : null,
    installmentMonths: event.installmentMonths,
    confidence: event.confidence,
    parseError: event.parseError,
    createdAt: event.createdAt.toISOString(),
  };
}

/** Maps a card-SMS event row to the full detail (summary + raw text). */
function toDetail(event: schema.CardSmsEvent): CardSmsEventDetail {
  return {
    ...toSummary(event),
    rawContent: event.rawContent,
    maskedCardNumber: event.maskedCardNumber,
  };
}
