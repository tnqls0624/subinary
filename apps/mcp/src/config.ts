import { z } from 'zod';

/**
 * MCP server configuration loaded from environment variables (Phase 10 spec §2.2).
 *
 * The server is launched by Claude Code / Cursor with these variables injected;
 * it is not a compose service. `FAMILY_EMAIL`/`FAMILY_PASSWORD` are required
 * (used once at startup to log in and obtain an access token + refresh cookie).
 *
 * SECURITY: validation failures must be explicit but must NEVER echo the actual
 * value of any variable (a secret could leak into stderr). We surface only the
 * variable name and the reason, never `received`.
 */

/** Treat empty strings (`FOO=`) the same as unset so optionals/defaults apply. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

const envSchema = z.object({
  /** Base URL of the Family Memory API the tools call. */
  FAMILY_API_URL: z
    .string()
    .url('올바른 URL 형식이 아닙니다 (예: http://localhost:3001)')
    .default('http://localhost:3001'),
  /** Login email (required). */
  FAMILY_EMAIL: z.string().email('올바른 이메일 형식이 아닙니다'),
  /** Login password (required). */
  FAMILY_PASSWORD: z.string().min(1, '비어 있을 수 없습니다'),
  /** Optional default workspace id (workspaces.id). Auto-resolved when omitted. */
  FAMILY_WORKSPACE_ID: z
    .string()
    .uuid('UUID 형식이어야 합니다')
    .optional(),
  /** Optional default household id. Auto-resolved when omitted. */
  FAMILY_HOUSEHOLD_ID: z
    .string()
    .uuid('UUID 형식이어야 합니다')
    .optional(),
});

/** Validated, normalized configuration for the MCP server. */
export interface McpConfig {
  /** API base URL, trailing slash trimmed. */
  readonly apiUrl: string;
  readonly email: string;
  readonly password: string;
  /** Default workspace id (workspaces.id) or undefined for auto-resolution. */
  readonly workspaceId?: string;
  /** Default household id or undefined for auto-resolution. */
  readonly householdId?: string;
}

/**
 * Parse + validate the environment. Throws an `Error` with a clear, value-free
 * message when validation fails (the caller logs it to stderr and exits).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = envSchema.safeParse({
    FAMILY_API_URL: emptyToUndefined(env.FAMILY_API_URL),
    FAMILY_EMAIL: env.FAMILY_EMAIL,
    FAMILY_PASSWORD: env.FAMILY_PASSWORD,
    FAMILY_WORKSPACE_ID: emptyToUndefined(env.FAMILY_WORKSPACE_ID),
    FAMILY_HOUSEHOLD_ID: emptyToUndefined(env.FAMILY_HOUSEHOLD_ID),
  });

  if (!parsed.success) {
    // Report variable name + reason only — never the offending value.
    const issues = parsed.error.issues
      .map((issue) => {
        const name = issue.path.join('.') || '(unknown)';
        return `  - ${name}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`환경변수 검증 실패:\n${issues}`);
  }

  const data = parsed.data;
  return {
    apiUrl: data.FAMILY_API_URL.replace(/\/+$/, ''),
    email: data.FAMILY_EMAIL,
    password: data.FAMILY_PASSWORD,
    workspaceId: data.FAMILY_WORKSPACE_ID,
    householdId: data.FAMILY_HOUSEHOLD_ID,
  };
}
