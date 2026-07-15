/**
 * Auth module constants (Phase 1 Build Spec §4.2).
 *
 * These values are intentionally free of any secret material — only metadata
 * keys and the HttpOnly refresh cookie name/scope live here.
 */

/** Reflector metadata key marking a route (or controller) as publicly accessible. */
export const IS_PUBLIC_KEY = 'isPublic' as const;

/** HttpOnly cookie name carrying the opaque refresh token. */
export const REFRESH_COOKIE = 'refresh_token' as const;

/**
 * Cookie path scope. The refresh cookie is only sent to `/v1/auth/*` so it
 * never leaks to unrelated endpoints.
 */
export const REFRESH_COOKIE_PATH = '/v1/auth' as const;
