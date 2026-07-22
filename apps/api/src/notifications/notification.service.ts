/**
 * 알림 도메인 서비스 — 푸시 구독(FCM 토큰) 관리 + 알림 선호.
 *
 * 구독은 `token`이 유일하다. 재등록은 onConflict로 소유 userId/platform을 교체하고
 * revoke를 해제한다(기기 양도·복구). 해지는 revokedAt를 세팅(로그아웃). 선호는
 * 행이 없으면 기본값(전부 켬)으로 응답하고, 갱신은 upsert 한다.
 *
 * 인증만 요구하고 가족 스코프는 없다 — 구독/선호는 사용자 단위 자원이다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';

import type {
  NotificationItem,
  NotificationKind,
  NotificationListResponse,
  NotificationPreferences,
  NotificationPreferencesUpdateRequest,
  NotificationUnreadCount,
  PushSubscriptionRegisterRequest,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';

/** 알림함 목록 기본/최대 페이지 크기. */
const NOTIFICATIONS_DEFAULT_LIMIT = 30;
const NOTIFICATIONS_MAX_LIMIT = 100;

/** 선호 행이 없을 때 응답할 기본값(전부 켬, 임계/무음 없음). */
const DEFAULT_PREFERENCES: NotificationPreferences = {
  pushEnabled: true,
  minAmount: null,
  quietStartMinute: null,
  quietEndMinute: null,
  notifyOwnCollected: true,
};

@Injectable()
export class NotificationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** FCM 토큰을 등록/갱신한다(token 기준 upsert, 재등록 시 소유자 교체·되살림). */
  async registerSubscription(
    userId: string,
    input: PushSubscriptionRegisterRequest,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(schema.pushSubscriptions)
      .values({
        userId,
        platform: input.platform,
        token: input.token,
      })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.token,
        set: {
          userId,
          platform: input.platform,
          revokedAt: null,
          failCount: 0,
          lastSeenAt: now,
          updatedAt: now,
        },
      });
  }

  /**
   * 구독을 해지한다(로그아웃). token 소유자가 호출자일 때만 revoke — 남의 토큰을
   * 임의로 끄지 못하게 한다. 이미 없거나 남의 토큰이면 조용히 무시(멱등).
   */
  async removeSubscription(userId: string, token: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(schema.pushSubscriptions)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.pushSubscriptions.token, token),
          eq(schema.pushSubscriptions.userId, userId),
        ),
      );
  }

  /** 현재 알림 선호(행 없으면 기본값). */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const [row] = await this.db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, userId))
      .limit(1);
    if (!row) return DEFAULT_PREFERENCES;
    return {
      pushEnabled: row.pushEnabled,
      minAmount: row.minAmount,
      quietStartMinute: row.quietStartMinute,
      quietEndMinute: row.quietEndMinute,
      notifyOwnCollected: row.notifyOwnCollected,
    };
  }

  /** 알림 선호를 전체 대체 저장한다(upsert). */
  async updatePreferences(
    userId: string,
    input: NotificationPreferencesUpdateRequest,
  ): Promise<NotificationPreferences> {
    const now = new Date();
    await this.db
      .insert(schema.notificationPreferences)
      .values({
        userId,
        pushEnabled: input.pushEnabled,
        minAmount: input.minAmount,
        quietStartMinute: input.quietStartMinute,
        quietEndMinute: input.quietEndMinute,
        notifyOwnCollected: input.notifyOwnCollected,
      })
      .onConflictDoUpdate({
        target: schema.notificationPreferences.userId,
        set: {
          pushEnabled: input.pushEnabled,
          minAmount: input.minAmount,
          quietStartMinute: input.quietStartMinute,
          quietEndMinute: input.quietEndMinute,
          notifyOwnCollected: input.notifyOwnCollected,
          updatedAt: now,
        },
      });
    return {
      pushEnabled: input.pushEnabled,
      minAmount: input.minAmount,
      quietStartMinute: input.quietStartMinute,
      quietEndMinute: input.quietEndMinute,
      notifyOwnCollected: input.notifyOwnCollected,
    };
  }

  /* --- 인앱 알림함 (userId 스코프, 최신순 커서 페이지네이션) --- */

  /** 알림 목록(최신순). 커서는 `createdAt desc, id desc` 키셋. */
  async listNotifications(
    userId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<NotificationListResponse> {
    const take = Math.min(
      Math.max(limit ?? NOTIFICATIONS_DEFAULT_LIMIT, 1),
      NOTIFICATIONS_MAX_LIMIT,
    );
    // 최근 30일 내역만 노출(그 이전은 목록에서 제외).
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const conditions = [
      eq(schema.notifications.userId, userId),
      gte(schema.notifications.createdAt, since),
    ];
    const key = decodeCursor(cursor);
    if (key) {
      const after = or(
        lt(schema.notifications.createdAt, key.createdAt),
        and(
          eq(schema.notifications.createdAt, key.createdAt),
          lt(schema.notifications.id, key.id),
        ),
      );
      if (after) conditions.push(after);
    }

    const rows = await this.db
      .select()
      .from(schema.notifications)
      .where(and(...conditions))
      .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
      .limit(take + 1);

    let nextCursor: string | null = null;
    let page = rows;
    if (rows.length > take) {
      page = rows.slice(0, take);
      const last = page[page.length - 1];
      nextCursor = encodeCursor(last.createdAt, last.id);
    }
    return { items: page.map(toItem), nextCursor };
  }

  /** 안읽음 개수. */
  async unreadCount(userId: string): Promise<NotificationUnreadCount> {
    const [agg] = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, userId),
          isNull(schema.notifications.readAt),
        ),
      );
    return { count: Number(agg?.count ?? 0) || 0 };
  }

  /** 단건 읽음 처리(본인 소유·안읽음만, 멱등). */
  async markRead(userId: string, id: string): Promise<void> {
    await this.db
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.id, id),
          eq(schema.notifications.userId, userId),
          isNull(schema.notifications.readAt),
        ),
      );
  }

  /** 전체 읽음 처리(본인 안읽음 전부). */
  async markAllRead(userId: string): Promise<void> {
    await this.db
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.userId, userId),
          isNull(schema.notifications.readAt),
        ),
      );
  }
}

/** DB row → 알림함 항목 DTO(ISO 시각). */
function toItem(row: schema.Notification): NotificationItem {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 커서 = base64url("<epochMs>:<uuid>"). */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.getTime()}:${id}`).toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    const createdAt = new Date(Number(decoded.slice(0, sep)));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
