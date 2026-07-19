import { z } from 'zod';

/** 푸시 구독 플랫폼(FCM 토큰 발급처). */
export const pushPlatformSchema = z.enum(['android', 'ios', 'web']);
export type PushPlatform = z.infer<typeof pushPlatformSchema>;

// --- Requests ---

/**
 * `POST /v1/notifications/subscriptions` — FCM 토큰 등록/갱신.
 * 같은 token 재등록은 소유 userId를 호출자로 교체(기기 양도)하고 되살린다.
 */
export const pushSubscriptionRegisterRequestSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: pushPlatformSchema,
});
export type PushSubscriptionRegisterRequest = z.infer<
  typeof pushSubscriptionRegisterRequestSchema
>;

/**
 * `PUT /v1/notifications/preferences` — 알림 선호 갱신(부분 아님, 전체 대체).
 * minAmount는 KRW 정수(0 이상). 무음 시간대는 분 단위(0~1439), 자정 넘김 허용.
 * 켜려면 start/end 둘 다 지정, 끄려면 둘 다 null.
 */
export const notificationPreferencesUpdateRequestSchema = z
  .object({
    pushEnabled: z.boolean(),
    minAmount: z.number().int().min(0).nullable(),
    quietStartMinute: z.number().int().min(0).max(1439).nullable(),
    quietEndMinute: z.number().int().min(0).max(1439).nullable(),
    notifyOwnCollected: z.boolean(),
  })
  .refine(
    (v) =>
      (v.quietStartMinute === null) === (v.quietEndMinute === null),
    {
      message: '무음 시간대는 시작과 끝을 함께 지정하거나 함께 비워야 해요',
      path: ['quietEndMinute'],
    },
  );
export type NotificationPreferencesUpdateRequest = z.infer<
  typeof notificationPreferencesUpdateRequestSchema
>;

// --- Responses ---

/** 구독 등록 결과. */
export const pushSubscriptionResponseSchema = z.object({
  registered: z.literal(true),
});
export type PushSubscriptionResponse = z.infer<
  typeof pushSubscriptionResponseSchema
>;

/** 현재 알림 선호(행이 없으면 기본값으로 채워 반환). */
export const notificationPreferencesSchema = z.object({
  pushEnabled: z.boolean(),
  minAmount: z.number().int().nullable(),
  quietStartMinute: z.number().int().nullable(),
  quietEndMinute: z.number().int().nullable(),
  notifyOwnCollected: z.boolean(),
});
export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;
