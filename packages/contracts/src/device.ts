import { z } from 'zod';

/** Smartphone platform a registered device runs on (PRD §31 Phase 2). */
export const devicePlatformSchema = z.enum(['ios', 'android', 'other']);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

/** Device lifecycle status. Revoked devices fail HMAC authentication. */
const deviceStatusSchema = z.enum(['active', 'revoked']);

// --- Requests ---

/** `POST /v1/devices/register` — register a smartphone under a household. */
export const deviceRegisterRequestSchema = z.object({
  householdId: z.string().uuid(),
  name: z.string().min(1).max(100),
  platform: devicePlatformSchema,
});
export type DeviceRegisterRequest = z.infer<typeof deviceRegisterRequestSchema>;

// --- Responses ---

/**
 * Public-safe device projection. Never carries credential material.
 *
 * 세 시각을 **모두** 내보내는 이유(로드맵 C-2 · 진단 D-2): `lastSeenAt`만 있으면
 * 화면이 "인증 성공"을 "문자 수신"으로 표시한다. 그러면 자동화의 문자 트리거가
 * 죽어도(= 인증만 계속 성공) 장치가 정상으로 보이고, 사용자는 지출이 왜 비어
 * 있는지 알 방법이 없다. 두 신호를 분리해야 원인을 좁힐 수 있다:
 *
 * - `lastSeenAt` 없음 → 인증조차 안 됨(토큰·주소 오타, 앱 권한).
 * - `lastSeenAt` 있고 `firstEventAt` 없음 → **인증은 되는데 문자 트리거가 안 걸림.**
 * - `firstEventAt` 있고 `lastEventAt`이 오래됨 → 살아 있다가 끊김(배터리 최적화 등).
 *
 * 컬럼은 이미 `registered_devices`에 있고 수집 시 갱신된다 — 마이그레이션 없음.
 */
export const deviceSummarySchema = z.object({
  id: z.string(),
  householdId: z.string(),
  memberId: z.string(),
  name: z.string(),
  platform: devicePlatformSchema,
  status: deviceStatusSchema,
  /** 마지막으로 이 장치가 **인증에 성공**한 시각(수집 POST·ping 포함). */
  lastSeenAt: z.string().nullable(),
  /** 이 장치에서 카드 문자가 **처음** 도착한 시각. 설정 완주 판정에 쓴다. */
  firstEventAt: z.string().nullable(),
  /** 이 장치에서 카드 문자가 **마지막으로** 도착한 시각. 수집 생존 판정에 쓴다. */
  lastEventAt: z.string().nullable(),
  createdAt: z.string(),
});
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

/**
 * Register / rotate-secret response — the raw `secret` is exposed exactly once.
 * `signingRecipe` documents how the client must derive `X-Signature`.
 * `collectToken` is the raw device collect token (Bearer) for the low-friction
 * Shortcuts/MacroDroid ingest path; like `secret`, it is exposed exactly once on
 * register/rotate and only its sha256 hash is persisted.
 */
export const deviceSecretResponseSchema = z.object({
  device: deviceSummarySchema,
  deviceId: z.string(),
  secret: z.string(),
  algorithm: z.literal('HMAC-SHA256'),
  signingRecipe: z.string(),
  collectToken: z.string(),
});
export type DeviceSecretResponse = z.infer<typeof deviceSecretResponseSchema>;

/** `POST /v1/mobile-events/ping` — confirms the HMAC guard accepted the request. */
export const devicePingResponseSchema = z.object({
  authenticated: z.literal(true),
  deviceId: z.string(),
  householdId: z.string(),
  receivedAt: z.string(),
});
export type DevicePingResponse = z.infer<typeof devicePingResponseSchema>;
