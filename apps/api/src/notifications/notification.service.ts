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
import { and, eq } from 'drizzle-orm';

import type {
  NotificationPreferences,
  NotificationPreferencesUpdateRequest,
  PushSubscriptionRegisterRequest,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';

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
}
