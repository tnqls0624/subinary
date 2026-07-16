import type {
  AuthResult,
  MeResponse,
  MemoryCreateRequest,
  MemoryListResponse,
  MemorySummary,
  MonthlyAnalytics,
  RetrievalResponse,
  SlackWorkspaceSummary,
  TimelineResponse,
  WorkQueryResponse,
} from '@family/contracts';

import type { McpConfig } from './config';

/**
 * HTTP client for the Family Memory API (Phase 10 spec §2.3).
 *
 * All MCP tools call the API through this client — never the database directly.
 * Authorization/ownership is enforced by the API (the logged-in user may only
 * touch data they own), so the tools inherit those guarantees for free.
 *
 * Auth flow: `login()` exchanges email+password for a short-lived access token
 * (kept in memory) plus an HttpOnly refresh cookie (managed manually here, since
 * Node's fetch has no cookie jar). `authedFetch` sends `Authorization: Bearer`
 * (+ the refresh cookie); on a 401 it refreshes once and retries.
 *
 * SECRETS: the access token, refresh cookie, and password are never logged.
 */

/** `DELETE /v1/memory/memories/:id` result (mirrors the API's MemoryDeleteResult). */
export interface MemoryDeleteResult {
  deleted: true;
}

/** Error carrying the HTTP status + a short, non-sensitive message. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type QueryParams = Record<string, string | number | undefined>;

interface FetchOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  query?: QueryParams;
}

export class FamilyApiClient {
  private readonly baseUrl: string;
  /** In-memory access token (never persisted, never logged). */
  private accessToken: string | null = null;
  /** Manual cookie jar (name -> value); holds the refresh cookie. */
  private readonly cookies = new Map<string, string>();
  /** Cached auto-resolved defaults (only when derived from lookup, not args). */
  private cachedWorkspaceId: string | null = null;
  private cachedHouseholdId: string | null = null;

  constructor(private readonly config: McpConfig) {
    this.baseUrl = config.apiUrl;
  }

  /* ---------------------------------------------------------------------- */
  /* Auth                                                                    */
  /* ---------------------------------------------------------------------- */

  /** Log in with the configured credentials; stores access token + refresh cookie. */
  async login(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: this.config.email,
          password: this.config.password,
        }),
      });
    } catch (err) {
      throw new ApiError(
        0,
        '/v1/auth/login',
        `API 서버에 연결할 수 없습니다 (${this.baseUrl}): ${errMessage(err)}`,
      );
    }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        '/v1/auth/login',
        await this.safeErrorMessage(res),
      );
    }
    const data = (await res.json()) as AuthResult;
    this.accessToken = data.tokens.accessToken;
    this.storeCookies(res);
  }

  /** Rotate the refresh cookie and obtain a fresh access token. */
  private async refresh(): Promise<void> {
    const headers: Record<string, string> = {};
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;

    const res = await fetch(`${this.baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers,
    });
    if (!res.ok) {
      throw new ApiError(
        res.status,
        '/v1/auth/refresh',
        '세션이 만료되었습니다. 자격 증명을 확인하고 다시 시도하세요.',
      );
    }
    const data = (await res.json()) as AuthResult;
    this.accessToken = data.tokens.accessToken;
    this.storeCookies(res);
  }

  /* ---------------------------------------------------------------------- */
  /* Core request                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Authenticated request. Sends Bearer token (+ refresh cookie); on 401 it
   * refreshes once and retries. Throws {@link ApiError} on any non-2xx result.
   */
  private async authedFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);

    const run = (): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
      const cookie = this.cookieHeader();
      if (cookie) headers.cookie = cookie;
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
      return fetch(url, { method: opts.method ?? 'GET', headers, body });
    };

    let res: Response;
    try {
      res = await run();
      if (res.status === 401) {
        // Single refresh + retry (spec §2.3).
        await this.refresh();
        res = await run();
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, path, `API 요청 실패: ${errMessage(err)}`);
    }

    if (!res.ok) {
      throw new ApiError(res.status, path, await this.safeErrorMessage(res));
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  /* ---------------------------------------------------------------------- */
  /* Domain methods (spec §1 tool ↔ API mapping)                             */
  /* ---------------------------------------------------------------------- */

  /** POST /v1/ai/work-query — grounded answer + citations (or refusal). */
  workQuery(input: {
    workspaceId: string;
    question: string;
  }): Promise<WorkQueryResponse> {
    return this.authedFetch<WorkQueryResponse>('/v1/ai/work-query', {
      method: 'POST',
      body: input,
    });
  }

  /** POST /v1/ai/retrieval — ranked chunks (snippet + citation). */
  retrieve(input: {
    workspaceId: string;
    query: string;
    topK?: number;
  }): Promise<RetrievalResponse> {
    return this.authedFetch<RetrievalResponse>('/v1/ai/retrieval', {
      method: 'POST',
      body: input,
    });
  }

  /** POST /v1/memory/memories — directly create an approved memory. */
  createMemory(input: MemoryCreateRequest): Promise<MemorySummary> {
    return this.authedFetch<MemorySummary>('/v1/memory/memories', {
      method: 'POST',
      body: input,
    });
  }

  /** DELETE /v1/memory/memories/:id — soft-delete a memory. */
  deleteMemory(memoryId: string): Promise<MemoryDeleteResult> {
    return this.authedFetch<MemoryDeleteResult>(
      `/v1/memory/memories/${encodeURIComponent(memoryId)}`,
      { method: 'DELETE' },
    );
  }

  /** GET /v1/graph/timeline — relationship history for an entity (validFrom asc). */
  graphTimeline(input: {
    workspaceId: string;
    entityId: string;
  }): Promise<TimelineResponse> {
    return this.authedFetch<TimelineResponse>('/v1/graph/timeline', {
      query: { workspaceId: input.workspaceId, entityId: input.entityId },
    });
  }

  /** GET /v1/memory/memories — a workspace's memories (optionally current only). */
  listMemories(input: {
    workspaceId: string;
    current?: boolean;
  }): Promise<MemoryListResponse> {
    return this.authedFetch<MemoryListResponse>('/v1/memory/memories', {
      query: {
        workspaceId: input.workspaceId,
        current: input.current ? 'true' : undefined,
      },
    });
  }

  /** GET /v1/analytics/monthly — net spend + previous-period delta. */
  monthly(input: {
    householdId: string;
    month?: string;
  }): Promise<MonthlyAnalytics> {
    return this.authedFetch<MonthlyAnalytics>('/v1/analytics/monthly', {
      query: { householdId: input.householdId, month: input.month },
    });
  }

  /** GET /v1/slack/workspaces — the caller's own Slack workspaces. */
  listWorkspaces(): Promise<SlackWorkspaceSummary[]> {
    return this.authedFetch<SlackWorkspaceSummary[]>('/v1/slack/workspaces');
  }

  /** GET /v1/auth/me — current user + active memberships. */
  me(): Promise<MeResponse> {
    return this.authedFetch<MeResponse>('/v1/auth/me');
  }

  /* ---------------------------------------------------------------------- */
  /* Default resolution (spec §1: arg ?? env ?? auto)                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolve the workspace scope id (workspaces.id). Precedence:
   * explicit arg → `FAMILY_WORKSPACE_ID` → first Slack workspace's `workspaceId`.
   * Throws a clear error when none can be determined.
   */
  async resolveWorkspaceId(arg?: string): Promise<string> {
    if (arg && arg.trim() !== '') return arg;
    if (this.config.workspaceId) return this.config.workspaceId;
    if (this.cachedWorkspaceId) return this.cachedWorkspaceId;

    const workspaces = await this.listWorkspaces();
    const first = workspaces[0];
    if (!first) {
      throw new ApiError(
        0,
        '/v1/slack/workspaces',
        '워크스페이스를 찾을 수 없습니다. FAMILY_WORKSPACE_ID를 지정하거나 먼저 Slack 워크스페이스를 만드세요.',
      );
    }
    // The RAG/memory/graph scope is `workspaces.id`, exposed as `workspaceId`
    // on the summary (NOT the `id`, which is slack_workspaces.id).
    this.cachedWorkspaceId = first.workspaceId;
    return first.workspaceId;
  }

  /**
   * Resolve the household id. Precedence:
   * explicit arg → `FAMILY_HOUSEHOLD_ID` → first membership's `householdId`.
   * Throws a clear error when none can be determined.
   */
  async resolveHouseholdId(arg?: string): Promise<string> {
    if (arg && arg.trim() !== '') return arg;
    if (this.config.householdId) return this.config.householdId;
    if (this.cachedHouseholdId) return this.cachedHouseholdId;

    const me = await this.me();
    const first = me.memberships[0];
    if (!first) {
      throw new ApiError(
        0,
        '/v1/auth/me',
        '가구(household)를 찾을 수 없습니다. FAMILY_HOUSEHOLD_ID를 지정하거나 먼저 가구에 소속되세요.',
      );
    }
    this.cachedHouseholdId = first.householdId;
    return first.householdId;
  }

  /* ---------------------------------------------------------------------- */
  /* Internal helpers                                                        */
  /* ---------------------------------------------------------------------- */

  private buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Capture Set-Cookie headers into the manual cookie jar. */
  private storeCookies(res: Response): void {
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [];
    for (const raw of setCookies) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  /** Serialize the cookie jar into a `Cookie` header value. */
  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /**
   * Extract a short, non-sensitive error message from a failed response.
   * Reads the API's `{ message }` when present; never returns raw bodies that
   * could contain secrets.
   */
  private async safeErrorMessage(res: Response): Promise<string> {
    try {
      const text = await res.text();
      if (!text) return res.statusText || `HTTP ${res.status}`;
      const json: unknown = JSON.parse(text);
      if (json && typeof json === 'object' && 'message' in json) {
        const message = (json as { message: unknown }).message;
        if (typeof message === 'string') return message;
        if (Array.isArray(message)) return message.map(String).join('; ');
      }
      return res.statusText || `HTTP ${res.status}`;
    } catch {
      return res.statusText || `HTTP ${res.status}`;
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
