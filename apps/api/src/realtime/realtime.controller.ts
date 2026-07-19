/**
 * 실시간 SSE 스트림 (GET /v1/realtime/stream?householdId=...).
 *
 * - 인증: 전역 AccessTokenGuard(Bearer). 웹은 fetch 기반 SSE 클라이언트로
 *   Authorization 헤더를 실어 연결한다(EventSource는 헤더 불가).
 * - 인가: 연결 시점에 활성 가족 멤버십을 1회 검증(다른 조회 API와 동일 규칙).
 * - 하트비트 25초: Cloudflare Tunnel/프록시의 유휴(~100초) 절단 회피 + 좀비
 *   연결 감지. 최대 수명 15분(access token TTL과 정렬) 후 스트림을 닫아
 *   클라이언트 재연결로 재인증을 유도한다.
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Inject,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { interval, map, merge, takeUntil, timer, type Observable } from 'rxjs';

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

@Controller('realtime')
export class RealtimeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly realtimeService: RealtimeService,
  ) {}

  @Sse('stream')
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId: string,
  ): Promise<Observable<MessageEvent>> {
    if (typeof householdId !== 'string' || !UUID_RE.test(householdId)) {
      throw new BadRequestException('invalid householdId');
    }

    // 활성 멤버십 검증 — 비멤버는 가족 존재 여부를 알 수 없게 403(PRD §26).
    const [member] = await this.db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, user.userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);
    if (!member) {
      throw new ForbiddenException('not a household member');
    }

    const events = this.realtimeService
      .streamFor(householdId)
      .pipe(map((event): MessageEvent => ({ type: 'hint', data: event })));

    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: { v: 1 } })),
    );

    return merge(events, heartbeat).pipe(
      takeUntil(timer(MAX_STREAM_LIFETIME_MS)),
    );
  }
}
