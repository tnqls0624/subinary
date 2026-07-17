import { z } from 'zod';
import { householdMembershipSummarySchema } from './household.js';

// --- Requests ---

/** `POST /v1/auth/register` — create an account. */
export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(100),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** `POST /v1/auth/login` — authenticate with email + password. */
export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `POST /v1/auth/change-password` — rotate password; revokes all sessions. */
export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

// --- Responses ---

/** Public-safe user projection. Never carries the password hash. */
export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.string(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

/** Access token bundle (the refresh token lives in an HttpOnly cookie, never here). */
export const authTokensSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresInSec: z.number(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

/**
 * Response body for register / login / refresh.
 *
 * `refreshToken` is populated **only for native clients** (Capacitor), which
 * cannot rely on the cross-site HttpOnly refresh cookie. Web clients keep the
 * cookie and never receive this field. Detected server-side via the
 * `X-Client-Platform: capacitor` request header.
 */
export const authResultSchema = z.object({
  user: userSummarySchema,
  tokens: authTokensSchema,
  refreshToken: z.string().optional(),
});
export type AuthResult = z.infer<typeof authResultSchema>;

/** `GET /v1/auth/me` — current user plus active household memberships. */
export const meResponseSchema = z.object({
  user: userSummarySchema,
  memberships: z.array(householdMembershipSummarySchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
