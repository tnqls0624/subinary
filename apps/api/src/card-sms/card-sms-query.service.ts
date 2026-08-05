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
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { cardSmsParseStatusSchema } from '@family/contracts';
import type {
  CardSmsDeclineGroup,
  CardSmsDeclineListResponse,
  CardSmsEventDetail,
  CardSmsEventSummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { normalizeMerchant } from '@family/shared';

import { DB } from '../database/database.constants';

/** Pagination bounds (spec §5.2 — default 50, max 100). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * 유효한 parse-status 필터 값.
 *
 * **계약 스키마에서 파생한다** — 하드코딩 사본을 두면 DB enum·계약과 조용히 어긋난다.
 * 실제로 `quarantined`(ADR-0023)를 추가했을 때 이 목록만 갱신되지 않아 검토 화면이
 * 400 `invalid status filter`로 죽었고, 타입체크는 사본이 자기완결적이라 통과했다.
 */
const PARSE_STATUSES = cardSmsParseStatusSchema.options;
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
      conditions.push(inArray(schema.cardSmsEvents.parseStatus, statusFilter));
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
  /**
   * 실패한 결제 목록 — 같은 `(가맹점, 금액)`의 반복 시도를 한 묶음으로 모은다.
   *
   * 왜 이 화면이 필요한가: `declined`는 실제 체결이 아니라 거래로 승격되지 않는다(유령
   * 거래 방지 — 옳은 설계). 그런데 그 결과 **앱 어디에도 나타나지 않아** 사용자가 실패를
   * 알 수 없었다. 실측(2026-07): `분실카드 승인거절 ... OO피트니스 99,000원`이 7일 연속
   * 15:00에 반복됐고 승인은 0건 — 정기결제 수단을 갱신하지 않아 멤버십이 끊긴 것인데
   * 아무 신호도 없었다.
   *
   * 카드사가 매일 재시도하므로 낱개로 보여주면 같은 사건이 7줄이 되어 다른 실패를 밀어낸다.
   * 묶음의 `resolvedAt`은 마지막 거절 **이후** 같은 가맹점 승인이 있었는지로 채운다 —
   * 스스로 해결된 것(STEAMGAMES: 거절 → 재승인)과 미해결(OO피트니스)을 갈라야 사용자가
   * 무엇을 해야 할지 안다.
   */
  async listDeclines(
    actorUserId: string,
    householdId: string,
    days = 60,
  ): Promise<CardSmsDeclineListResponse> {
    if (!householdId) {
      throw new BadRequestException('householdId is required');
    }
    await this.requireMembership(householdId, actorUserId);

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const events = await this.db
      .select({
        merchantRaw: schema.cardSmsEvents.merchantRaw,
        amount: schema.cardSmsEvents.amount,
        currency: schema.cardSmsEvents.currency,
        reason: schema.cardSmsEvents.declineReason,
        issuer: schema.cardSmsEvents.issuer,
        maskedCardNumber: schema.cardSmsEvents.maskedCardNumber,
        occurredAt: schema.cardSmsEvents.occurredAt,
        createdAt: schema.cardSmsEvents.createdAt,
      })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.householdId, householdId),
          eq(schema.cardSmsEvents.transactionType, 'declined'),
          gt(schema.cardSmsEvents.createdAt, since),
        ),
      )
      .orderBy(asc(schema.cardSmsEvents.createdAt));

    if (events.length === 0) return { items: [], unresolvedCount: 0 };

    // 사용자가 확정한 별칭까지 반영해 묶는다 — 정규화만 하면 표기가 다른 같은 가게가
    // 갈라져 "3번 실패"가 "1번 + 2번"으로 쪼개진다.
    const aliases = await this.db
      .select({
        alias: schema.merchantAliases.alias,
        canonical: schema.merchantAliases.canonical,
      })
      .from(schema.merchantAliases)
      .where(eq(schema.merchantAliases.householdId, householdId));
    const aliasMap = new Map(aliases.map((a) => [a.alias, a.canonical]));
    const resolveMerchant = (raw: string | null): string | null => {
      if (!raw) return null;
      const normalized = normalizeMerchant(raw);
      if (!normalized) return null;
      return aliasMap.get(normalized) ?? normalized;
    };

    interface Bucket {
      merchant: string | null;
      amount: number | null;
      currency: string;
      reason: CardSmsDeclineGroup['reason'];
      issuer: string | null;
      maskedCardNumber: string | null;
      attempts: number;
      first: Date;
      last: Date;
    }
    const buckets = new Map<string, Bucket>();
    for (const e of events) {
      const merchant = resolveMerchant(e.merchantRaw);
      const at = e.occurredAt ?? e.createdAt;
      const key = `${merchant ?? ''}|${e.amount ?? ''}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.attempts += 1;
        if (at < existing.first) existing.first = at;
        if (at > existing.last) {
          existing.last = at;
          // 사유는 **최신 시도**의 것을 쓴다(원인이 바뀔 수 있다: 한도초과 → 분실신고).
          existing.reason = e.reason ?? existing.reason;
        }
        continue;
      }
      buckets.set(key, {
        merchant,
        amount: e.amount,
        currency: e.currency ?? 'KRW',
        reason: e.reason,
        issuer: e.issuer,
        maskedCardNumber: e.maskedCardNumber,
        attempts: 1,
        first: at,
        last: at,
      });
    }

    // 각 묶음이 그 뒤 승인으로 해결됐는지 확인. 묶음 수가 적어(가맹점 단위) N+1이
    // 문제되지 않으며, 가맹점별 시각 조건이 달라 단일 쿼리로 합치면 더 복잡해진다.
    const items: CardSmsDeclineGroup[] = [];
    for (const b of buckets.values()) {
      let resolvedAt: Date | null = null;
      if (b.merchant) {
        const [approved] = await this.db
          .select({ approvedAt: schema.cardTransactions.approvedAt })
          .from(schema.cardTransactions)
          .where(
            and(
              eq(schema.cardTransactions.householdId, householdId),
              eq(schema.cardTransactions.transactionType, 'approval'),
              this.sameMerchantLoose(b.merchant),
              isNotNull(schema.cardTransactions.approvedAt),
              gt(schema.cardTransactions.approvedAt, b.last),
            ),
          )
          .orderBy(asc(schema.cardTransactions.approvedAt))
          .limit(1);
        resolvedAt = approved?.approvedAt ?? null;
      }
      items.push({
        merchant: b.merchant,
        amount: b.amount,
        currency: b.currency,
        reason: b.reason,
        issuer: b.issuer,
        maskedCardNumber: b.maskedCardNumber,
        attempts: b.attempts,
        firstAttemptAt: b.first.toISOString(),
        lastAttemptAt: b.last.toISOString(),
        resolvedAt: resolvedAt ? resolvedAt.toISOString() : null,
      });
    }

    // 미해결 먼저 → 시도 많은 순 → 최근 순. 사용자가 조치해야 할 것이 맨 위로 온다.
    items.sort((a, b) => {
      const aUnresolved = a.resolvedAt === null ? 0 : 1;
      const bUnresolved = b.resolvedAt === null ? 0 : 1;
      if (aUnresolved !== bUnresolved) return aUnresolved - bUnresolved;
      if (a.attempts !== b.attempts) return b.attempts - a.attempts;
      return (b.lastAttemptAt ?? '').localeCompare(a.lastAttemptAt ?? '');
    });

    return {
      items,
      unresolvedCount: items.filter((i) => i.resolvedAt === null).length,
    };
  }

  /**
   * 거절 문자의 가맹점과 승인 거래의 가맹점을 **느슨하게** 비교한다.
   *
   * 카드사는 거절 통지와 승인 통지에서 가맹점명을 다르게 쓴다 — 실측:
   * 거절 `STEAMGAMES.COM425952` vs 승인 `STEAMGAMES`(5분 뒤 다른 카드로 재결제).
   * 완전 일치로 비교하면 이미 해결된 실패가 영구 "미해결"로 남아 배너가 사라지지 않는다.
   *
   * 한쪽이 다른 쪽의 **접두**이면 같은 가맹점으로 본다. 너무 짧은 이름은 다른 가맹점의
   * 접두일 수 있어(`GS` ⊂ `GS리테일`) 4자 이상일 때만 접두 매칭을 허용하고, 그 아래는
   * 완전 일치만 인정한다.
   */
  private sameMerchantLoose(merchant: string): SQL {
    const col = schema.cardTransactions.merchantNormalized;
    if (merchant.length < 4) return eq(col, merchant);
    // LIKE 와일드카드가 가맹점명에 들어가면 의도치 않게 매칭되므로 이스케이프한다.
    const escaped = merchant.replace(/([\\%_])/g, '\\$1');
    return or(
      eq(col, merchant),
      sql`${col} like ${escaped + '%'}`,
      sql`${merchant} like ${col} || '%'`,
    ) as SQL;
  }

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
  private parseStatus(status: string | undefined): ParseStatus[] | undefined {
    if (status === undefined || status === '') {
      return undefined;
    }
    // 쉼표 구분 다중 상태를 허용한다 — 검토 화면이 quarantined(LLM 추론)와
    // parse_failed(규칙 실패)를 한 목록으로 보여줘야 하기 때문(ADR-0023 S3).
    const requested = status.split(',').map((value) => value.trim()).filter((v) => v !== '');
    if (requested.length === 0) {
      throw new BadRequestException('invalid status filter');
    }
    for (const value of requested) {
      if (!PARSE_STATUSES.includes(value as ParseStatus)) {
        throw new BadRequestException('invalid status filter');
      }
    }
    return [...new Set(requested)] as ParseStatus[];
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
