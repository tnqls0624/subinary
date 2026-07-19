import { z } from 'zod';
import { householdMembershipSummarySchema } from './household.js';

// --- Requests ---

const emailInputSchema = z
  .string({ error: '이메일을 입력해 주세요.' })
  .trim()
  .min(1, { error: '이메일을 입력해 주세요.' })
  .pipe(z.email({ error: '올바른 이메일 주소를 입력해 주세요.' }));

const requiredPasswordSchema = z
  .string({ error: '비밀번호를 입력해 주세요.' })
  .min(1, { error: '비밀번호를 입력해 주세요.' })
  .max(200, { error: '비밀번호는 200자 이하로 입력해 주세요.' });

const newPasswordSchema = z
  .string({ error: '비밀번호를 입력해 주세요.' })
  .min(8, { error: '비밀번호는 8자 이상 입력해 주세요.' })
  .max(200, { error: '비밀번호는 200자 이하로 입력해 주세요.' });

const userNameInputSchema = z
  .string({ error: '이름을 입력해 주세요.' })
  .trim()
  .min(1, { error: '이름을 입력해 주세요.' })
  .max(100, { error: '이름은 100자 이하로 입력해 주세요.' });

/** `POST /v1/auth/register` — create an account. */
export const registerRequestSchema = z.object({
  email: emailInputSchema,
  password: newPasswordSchema,
  name: userNameInputSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** `POST /v1/auth/login` — authenticate with email + password. */
export const loginRequestSchema = z.object({
  email: emailInputSchema,
  password: requiredPasswordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `POST /v1/auth/change-password` — rotate password; revokes all sessions. */
export const changePasswordRequestSchema = z.object({
  currentPassword: requiredPasswordSchema,
  newPassword: newPasswordSchema,
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
