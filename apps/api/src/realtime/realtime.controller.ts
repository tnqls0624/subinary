/**
 * 실시간 SSE 스트림 (GET /v1/realtime/stream?householdId=...).
 *
 * - 인증: 전역 AccessTokenGuard(Bearer). 웹은 fetch 기반 SSE 클라이언트로
 *   Authorization 헤더를 실어 연결한다(EventSource는 헤더 불가).
 * - 인가: 연결과 각 hint/heartbeat 전 활성 멤버십·사용자·가족 상태를 검증한다.
 *   최초 멤버십 행의 xmin을 고정해 제거 후 재가입해도 옛 연결을 재사용하지 않는다.
 * - 하트비트 25초: Cloudflare Tunnel/프록시의 유휴(~100초) 절단 회피 + 좀비
 *   연결 감지. 검증된 토큰 만료 또는 최대 수명 15분 중 먼저 닿으면 스트림을 닫아
 *   클라이언트 재연결로 재인증을 유도한다.
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Inject,
  Query,
  ServiceUnavailableException,
  Sse,
  UnauthorizedException,
  type MessageEvent,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  EMPTY, catchError, concatMap, defer, interval, map, merge, of,
  takeUntil, takeWhile, timer, type Observable,
} from 'rxjs';

import { schema, type Db } from '@family/database';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { DB } from '../database/database.constants';
import { RealtimeService } from './realtime.service';

/** 하트비트 주기(ms). Cloudflare 유휴 절단(~100초)의 1/4 수준. */
const HEARTBEAT_MS = 25_000;
/**
 * householdId 형식 검증(uuid). 원시 @Query는 zod 파이프를 타지 않아 중복 쿼리
 * 키(배열)·비uuid가 그대로 들어오면 DB 바인딩에서 500이 나므로 여기서 400 처리.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 스트림 최대 수명(ms). access token TTL(900초)과 정렬 — 만료 시 재연결로 재인증. */
const MAX_STREAM_LIFETIME_MS = 15 * 60 * 1000;
interface MembershipIncarnation { id: string; incarnation: string }

@Controller('realtime')
export class RealtimeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly realtimeService: RealtimeService,
  ) {}

  private async activeMembership(householdId: string, userId: string): Promise<MembershipIncarnation | undefined> {
    const [member] = await this.db
      .select({ id: schema.householdMembers.id,
        // PostgreSQL row versions change even if remove/rejoin share a clock
        // timestamp. A color/role update also closes the old stream safely.
        incarnation: sql<string>`${schema.householdMembers}.xmin::text` })
      .from(schema.householdMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
      .innerJoin(schema.households, eq(schema.households.id, schema.householdMembers.householdId))
      .where(and(
        eq(schema.householdMembers.householdId, householdId),
        eq(schema.householdMembers.userId, userId),
        eq(schema.householdMembers.status, 'active'),
        isNull(schema.users.deletedAt),
        isNull(schema.households.deletedAt),
      )).limit(1);
    return member;
  }

  @Sse('stream')
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId: string,
  ): Promise<Observable<MessageEvent>> {
    if (typeof householdId !== 'string' || !UUID_RE.test(householdId)) {
      throw new BadRequestException('invalid householdId');
    }
    if (typeof user.userId !== 'string' || !UUID_RE.test(user.userId)) {
      throw new UnauthorizedException('unauthorized');
    }
    const startedAt = Date.now();
    const tokenExpiresAt = user.accessTokenExpiresAt;
    if (tokenExpiresAt !== undefined && (!Number.isSafeInteger(tokenExpiresAt) || tokenExpiresAt <= startedAt)) {
      throw new UnauthorizedException('unauthorized');
    }
    const deadline = Math.min(startedAt + MAX_STREAM_LIFETIME_MS, tokenExpiresAt ?? Number.POSITIVE_INFINITY);
    const id = householdId.toLowerCase();

    // 활성 멤버십 검증 — 비멤버는 가족 존재 여부를 알 수 없게 403(PRD §26).
    let member: MembershipIncarnation | undefined;
    try {
      member = await this.activeMembership(id, user.userId);
    } catch {
      // DB exceptions may contain SQL parameters. Do not log or expose them.
      throw new ServiceUnavailableException('stream unavailable');
    }
    if (!member || typeof member.incarnation !== 'string' || !member.incarnation) {
      throw new ForbiddenException('not a household member');
    }
    if (Date.now() >= deadline) throw new UnauthorizedException('unauthorized');
    const initial = { id: member.id, incarnation: member.incarnation };

    const events = this.realtimeService
      .streamFor(id)
      .pipe(map((event): MessageEvent => ({ type: 'hint', data: event })));

    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: { v: 1 } })),
    );

    return defer(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return EMPTY;
      return merge(events, heartbeat).pipe(
        // Check when each queued item is consumed, not when it was enqueued.
        // A failed check completes the stream and discards the remaining queue.
        concatMap((event) => defer(async (): Promise<MessageEvent | null> => {
          if (Date.now() >= deadline) return null;
          const current = await this.activeMembership(id, user.userId);
          if (Date.now() >= deadline || current?.id !== initial.id || current?.incarnation !== initial.incarnation) return null;
          return event;
        }).pipe(catchError(() => of(null)))),
        takeWhile((event): event is MessageEvent => event !== null),
        takeUntil(timer(remaining)),
      );
    });
  }
}
