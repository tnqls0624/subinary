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

/** Public-safe device projection. Never carries credential material. */
export const deviceSummarySchema = z.object({
  id: z.string(),
  householdId: z.string(),
  memberId: z.string(),
  name: z.string(),
  platform: devicePlatformSchema,
  status: deviceStatusSchema,
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

/**
 * Register / rotate-secret response — the raw `secret` is exposed exactly once.
 * `signingRecipe` documents how the client must derive `X-Signature`.
 */
export const deviceSecretResponseSchema = z.object({
  device: deviceSummarySchema,
  deviceId: z.string(),
  secret: z.string(),
  algorithm: z.literal('HMAC-SHA256'),
  signingRecipe: z.string(),
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
