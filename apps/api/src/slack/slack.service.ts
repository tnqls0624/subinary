/**
 * Slack import & query service (Phase 6 Build Spec §5.2).
 *
 * Owner-only personal-workspace data (PRD §18/§26): every Slack read/write is
 * scoped through a `workspaces` container whose `ownerUserId` must equal the
 * acting user. Family members are *not* granted access — a non-owner always
 * receives a 403 ({@link requireOwnedSlackWorkspace}).
 *
 * Import는 upload마다 새 `source_items`와 MinIO 원본을 만들되 동일
 * `slack_workspaces`를 재사용한다. Worker는 `(slackChannelId, ts)` change-set으로
 * merge/snapshot을 멱등 적용하고 기존 tombstone을 자동 복구하지 않는다.
 *
 * Secret hygiene (spec §0 / §1): the bundle text, message bodies, and any PII
 * are never logged — only counts, hashes (truncated), and identifiers are
 * emitted.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  SlackImportSyncMode,
  SlackImportResponse,
  SlackMessageListResponse,
  SlackMessageSummary,
  SlackThreadResponse,
  SlackWorkspaceSummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { OUTBOX_EVENT_TYPES } from '@family/shared';

import { DB } from '../database/database.constants';
import { ObjectStorageService } from '../storage/object-storage.service';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Message-list pagination bounds (spec §5.2 — default 50, max 100). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Fallback workspace display name when neither the field nor bundle names it. */
const DEFAULT_WORKSPACE_NAME = 'Slack';

/** Allowed workspace kinds (mirrors DB `workspaceKindEnum`). */
const WORKSPACE_KINDS = ['personal', 'company'] as const;
type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/**
 * Shared message projection (SELECT shape) reused by the list and thread
 * queries so both map through {@link SlackService.toMessageSummary} identically.
 * Requires the joins: `slack_channels` (channel name) and `slack_users`
 * (author name, left-joined on workspace + slack user id).
 */
const messageColumns = {
  id: schema.slackMessages.id,
  slackChannelId: schema.slackMessages.slackChannelId,
  channelName: schema.slackChannels.name,
  slackUserId: schema.slackMessages.slackUserId,
  userName: schema.slackUsers.name,
  realName: schema.slackUsers.realName,
  ts: schema.slackMessages.ts,
  threadTs: schema.slackMessages.threadTs,
  text: schema.slackMessages.text,
  editedTs: schema.slackMessages.editedTs,
  occurredAt: schema.slackMessages.occurredAt,
};

/** A single joined message row (result of selecting {@link messageColumns}). */
interface MessageRow {
  id: string;
  slackChannelId: string;
  channelName: string;
  slackUserId: string | null;
  userName: string | null;
  realName: string | null;
  ts: string;
  threadTs: string | null;
  text: string;
  editedTs: string | null;
  occurredAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Input shapes                                                               */
/* -------------------------------------------------------------------------- */

/** Multipart fields accompanying an import upload (all optional). */
export interface SlackImportFields {
  mySlackUserId?: string;
  workspaceName?: string;
  kind?: string;
  syncMode?: string;
}

/** Query parameters for `GET /v1/slack/messages` (all raw strings). */
export interface SearchMessagesQuery {
  slackWorkspaceId?: string;
  channelId?: string;
  from?: string;
  to?: string;
  q?: string;
  mine?: string;
  limit?: string;
  cursor?: string;
}

/** Decoded keyset cursor: order by `(occurredAt desc, id desc)`. */
interface Cursor {
  occurredAt: Date;
  id: string;
}

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Import                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * `userId`의 Slack export bundle을 수집한다. MinIO 원본, `source_items`,
   * transactional outbox event를 저장한다. 전체 구조 검증은 Worker의
   * `parseSlackExport`가 담당하며 여기서는 대상 workspace 결정을 위한 얕은 JSON
   * 파싱만 수행한다.
   */
  async import(
    userId: string,
    fileBuffer: Buffer,
    fields: SlackImportFields,
  ): Promise<SlackImportResponse> {
    const bundle = this.parseBundleShallow(fileBuffer);
    const kind = this.resolveKind(fields.kind);
    const syncMode = this.resolveSyncMode(fields.syncMode);

    const bundleWorkspace =
      isRecord(bundle) && isRecord(bundle.workspace) ? bundle.workspace : {};
    const bundleName =
      typeof bundleWorkspace.name === 'string' && bundleWorkspace.name !== ''
        ? bundleWorkspace.name
        : undefined;
    const slackTeamId =
      typeof bundleWorkspace.slackTeamId === 'string' &&
      bundleWorkspace.slackTeamId !== ''
        ? bundleWorkspace.slackTeamId
        : null;

    const overrideName =
      fields.workspaceName && fields.workspaceName.trim() !== ''
        ? fields.workspaceName.trim()
        : undefined;
    const name = overrideName ?? bundleName ?? DEFAULT_WORKSPACE_NAME;
    const mySlackUserId =
      fields.mySlackUserId && fields.mySlackUserId.trim() !== ''
        ? fields.mySlackUserId.trim()
        : null;

    const workspace = await this.ensureWorkspace(userId, {
      name,
      kind,
      slackTeamId,
      mySlackUserId,
    });

    const sourceItemId = randomUUID();
    const objectKey = `slack/${workspace.id}/${sourceItemId}.json`;
    const contentHash = createHash('sha256').update(fileBuffer).digest('hex');
    const sizeBytes = fileBuffer.byteLength;

    // Write the raw bundle to object storage first: the worker parses only from
    // MinIO (no DB copy of the bundle), so a storage failure must abort the
    // import rather than leave a source item pointing at a missing object.
    await this.storage.putObject(
      objectKey,
      fileBuffer,
      'application/json; charset=utf-8',
    );

    const receivedAt = new Date();
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.sourceItems).values({
        id: sourceItemId,
        // Slack 원문은 workspace 소유(householdId 아님, PRD §3.6). 범용 workspaces.id 사용.
        workspaceId: workspace.workspaceId,
        kind: 'slack',
        objectKey,
        contentHash,
        sizeBytes,
        receivedAt,
      });
      const [revision] = await tx
        .insert(schema.sourceRevisions)
        .values({
          sourceItemId,
          revision: 1,
          objectKey,
          contentHash,
          sizeBytes,
          parserSchemaVersion: 'slack-raw-v1',
          consentScope: { mode: 'workspace-only', importSyncMode: syncMode },
          validFrom: receivedAt,
        })
        .returning({ id: schema.sourceRevisions.id });
      if (!revision) {
        throw new Error('failed to create Slack source revision');
      }
      await tx
        .update(schema.sourceItems)
        .set({ currentRevisionId: revision.id })
        .where(eq(schema.sourceItems.id, sourceItemId));
      await tx.insert(schema.dataEvents).values({
        aggregateType: 'source_item',
        aggregateId: sourceItemId,
        eventType: OUTBOX_EVENT_TYPES.SOURCE_SLACK_RECEIVED,
        revisionId: revision.id,
        workspaceId: workspace.workspaceId,
        payload: {
          sourceItemId,
          slackWorkspaceId: workspace.id,
          syncMode,
        },
        occurredAt: receivedAt,
      });
    });

    this.logger.log(
      `slack import accepted id=${sourceItemId} workspace=${workspace.id} ` +
        `syncMode=${syncMode} hash=${contentHash.slice(0, 12)} ` +
        `size=${sizeBytes} status=outbox_pending`,
    );

    return {
      importId: sourceItemId,
      slackWorkspaceId: workspace.id,
      syncMode,
      status: 'queued',
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Workspace management                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Find-or-create the owner's Slack workspace container. A re-import matches an
   * existing workspace by Slack team id (when the export carries one) or, as a
   * fallback, by name among the owner's team-id-less workspaces; the match keeps
   * imports idempotent. On a match the display name/kind and the newly supplied
   * `slackTeamId`/`mySlackUserId` are refreshed (a null field keeps the stored
   * value). No match creates the `workspaces` + `slack_workspaces` pair.
   */
  private async ensureWorkspace(
    userId: string,
    opts: {
      name: string;
      kind: WorkspaceKind;
      slackTeamId: string | null;
      mySlackUserId: string | null;
    },
  ): Promise<schema.SlackWorkspace> {
    const existing = await this.findOwnedWorkspace(
      userId,
      opts.slackTeamId,
      opts.name,
    );

    if (existing) {
      const now = new Date();
      await this.db
        .update(schema.workspaces)
        .set({ name: opts.name, kind: opts.kind, updatedAt: now })
        .where(eq(schema.workspaces.id, existing.workspaceId));

      const [updated] = await this.db
        .update(schema.slackWorkspaces)
        .set({
          name: opts.name,
          slackTeamId: opts.slackTeamId ?? existing.slackTeamId,
          mySlackUserId: opts.mySlackUserId ?? existing.mySlackUserId,
          updatedAt: now,
        })
        .where(eq(schema.slackWorkspaces.id, existing.id))
        .returning();
      return updated ?? existing;
    }

    return this.db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(schema.workspaces)
        .values({ ownerUserId: userId, kind: opts.kind, name: opts.name })
        .returning();
      if (!workspace) {
        throw new Error('failed to create workspace');
      }

      const [slackWorkspace] = await tx
        .insert(schema.slackWorkspaces)
        .values({
          workspaceId: workspace.id,
          name: opts.name,
          slackTeamId: opts.slackTeamId,
          mySlackUserId: opts.mySlackUserId,
        })
        .returning();
      if (!slackWorkspace) {
        throw new Error('failed to create slack workspace');
      }
      return slackWorkspace;
    });
  }

  /** Locates an owner's Slack workspace by team id, else by team-id-less name. */
  private async findOwnedWorkspace(
    userId: string,
    slackTeamId: string | null,
    name: string,
  ): Promise<schema.SlackWorkspace | undefined> {
    const match = slackTeamId
      ? eq(schema.slackWorkspaces.slackTeamId, slackTeamId)
      : and(
          eq(schema.slackWorkspaces.name, name),
          isNull(schema.slackWorkspaces.slackTeamId),
        );

    const [row] = await this.db
      .select({ sw: schema.slackWorkspaces })
      .from(schema.slackWorkspaces)
      .innerJoin(
        schema.workspaces,
        eq(schema.slackWorkspaces.workspaceId, schema.workspaces.id),
      )
      .where(and(eq(schema.workspaces.ownerUserId, userId), match))
      .orderBy(asc(schema.slackWorkspaces.createdAt))
      .limit(1);

    return row?.sw;
  }

  /**
   * Loads a Slack workspace and asserts `userId` is its owner (PRD §26). A
   * missing workspace is a 404; one owned by another user is a 403 (family
   * members included).
   */
  private async requireOwnedSlackWorkspace(
    userId: string,
    slackWorkspaceId: string,
  ): Promise<schema.SlackWorkspace> {
    if (!slackWorkspaceId) {
      throw new BadRequestException('slackWorkspaceId is required');
    }
    const [row] = await this.db
      .select({
        sw: schema.slackWorkspaces,
        ownerUserId: schema.workspaces.ownerUserId,
      })
      .from(schema.slackWorkspaces)
      .innerJoin(
        schema.workspaces,
        eq(schema.slackWorkspaces.workspaceId, schema.workspaces.id),
      )
      .where(eq(schema.slackWorkspaces.id, slackWorkspaceId))
      .limit(1);

    if (!row) {
      throw new NotFoundException('slack workspace not found');
    }
    if (row.ownerUserId !== userId) {
      throw new ForbiddenException('not the workspace owner');
    }
    return row.sw;
  }

  /** Lists the caller's own Slack workspaces (newest first) with count rollups. */
  async listWorkspaces(userId: string): Promise<SlackWorkspaceSummary[]> {
    const rows = await this.db
      .select({ sw: schema.slackWorkspaces })
      .from(schema.slackWorkspaces)
      .innerJoin(
        schema.workspaces,
        eq(schema.slackWorkspaces.workspaceId, schema.workspaces.id),
      )
      .where(eq(schema.workspaces.ownerUserId, userId))
      .orderBy(desc(schema.slackWorkspaces.createdAt));

    return Promise.all(rows.map((r) => this.workspaceSummary(r.sw)));
  }

  /** Returns a single owned workspace summary (404/403 for missing/non-owner). */
  async getWorkspace(
    userId: string,
    slackWorkspaceId: string,
  ): Promise<SlackWorkspaceSummary> {
    const workspace = await this.requireOwnedSlackWorkspace(
      userId,
      slackWorkspaceId,
    );
    return this.workspaceSummary(workspace);
  }

  /** Builds a workspace summary, aggregating channel/user/message counts in SQL. */
  private async workspaceSummary(
    workspace: schema.SlackWorkspace,
  ): Promise<SlackWorkspaceSummary> {
    const countExpr = sql<string>`count(*)`;
    const [channelAgg, userAgg, messageAgg] = await Promise.all([
      this.db
        .select({ count: countExpr })
        .from(schema.slackChannels)
        .where(eq(schema.slackChannels.slackWorkspaceId, workspace.id)),
      this.db
        .select({ count: countExpr })
        .from(schema.slackUsers)
        .where(eq(schema.slackUsers.slackWorkspaceId, workspace.id)),
      this.db
        .select({ count: countExpr })
        .from(schema.slackMessages)
        .where(
          and(
            eq(schema.slackMessages.slackWorkspaceId, workspace.id),
            isNull(schema.slackMessages.deletedAt),
          ),
        ),
    ]);

    const channels = toInt(channelAgg[0]?.count);
    const users = toInt(userAgg[0]?.count);
    const messages = toInt(messageAgg[0]?.count);

    return {
      id: workspace.id,
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      slackTeamId: workspace.slackTeamId,
      mySlackUserId: workspace.mySlackUserId,
      channelCount: channels,
      userCount: users,
      messageCount: messages,
      lastImportedAt: workspace.lastImportedAt
        ? workspace.lastImportedAt.toISOString()
        : null,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Message search & threads                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Keyword/channel/date/mine search over a workspace's messages (owner-only),
   * newest first, keyset-paginated. Keyword uses `text ILIKE '%q%'` (trgm-backed,
   * Korean-safe); `mine` restricts to the workspace `mySlackUserId`; each row
   * carries the source hint (channel/author/ts/permalinkHint) and `isMine`.
   */
  async searchMessages(
    userId: string,
    query: SearchMessagesQuery,
  ): Promise<SlackMessageListResponse> {
    const workspace = await this.requireOwnedSlackWorkspace(
      userId,
      query.slackWorkspaceId ?? '',
    );
    const take = this.parseLimit(query.limit);
    const keyset = this.decodeCursor(query.cursor);
    const mine = query.mine === 'true';

    // `mine` with no configured mySlackUserId can never match — short-circuit.
    if (mine && workspace.mySlackUserId === null) {
      return { items: [], nextCursor: null };
    }

    const conditions: SQL[] = [
      eq(schema.slackMessages.slackWorkspaceId, workspace.id),
      isNull(schema.slackMessages.deletedAt),
    ];
    if (query.channelId) {
      conditions.push(eq(schema.slackMessages.slackChannelId, query.channelId));
    }
    if (query.q !== undefined && query.q !== '') {
      conditions.push(
        ilike(schema.slackMessages.text, `%${escapeLike(query.q)}%`),
      );
    }
    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    if (from) {
      conditions.push(gte(schema.slackMessages.occurredAt, from));
    }
    if (to) {
      conditions.push(lte(schema.slackMessages.occurredAt, to));
    }
    if (mine && workspace.mySlackUserId !== null) {
      conditions.push(
        eq(schema.slackMessages.slackUserId, workspace.mySlackUserId),
      );
    }
    if (keyset) {
      const after = or(
        lt(schema.slackMessages.occurredAt, keyset.occurredAt),
        and(
          eq(schema.slackMessages.occurredAt, keyset.occurredAt),
          lt(schema.slackMessages.id, keyset.id),
        ),
      );
      if (after) {
        conditions.push(after);
      }
    }

    const rows = await this.db
      .select(messageColumns)
      .from(schema.slackMessages)
      .innerJoin(
        schema.slackChannels,
        eq(schema.slackMessages.slackChannelId, schema.slackChannels.id),
      )
      .leftJoin(
        schema.slackUsers,
        and(
          eq(
            schema.slackUsers.slackWorkspaceId,
            schema.slackMessages.slackWorkspaceId,
          ),
          eq(schema.slackUsers.slackUserId, schema.slackMessages.slackUserId),
        ),
      )
      .where(and(...conditions))
      .orderBy(
        desc(schema.slackMessages.occurredAt),
        desc(schema.slackMessages.id),
      )
      .limit(take + 1);

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const items = page.map((row) =>
      this.toMessageSummary(row, workspace.mySlackUserId),
    );

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? this.encodeCursor(last.occurredAt, last.id) : null;

    return { items, nextCursor };
  }

  /**
   * Restores a single thread (owner-only): the root plus replies ordered by `ts`
   * ascending (numeric comparison — Slack `ts` is not zero-padded). Deleted
   * messages are excluded and `replyCount` is derived from the same active rows.
   */
  async getThread(
    userId: string,
    slackWorkspaceId: string | undefined,
    channelId: string | undefined,
    threadTs: string | undefined,
  ): Promise<SlackThreadResponse> {
    const workspace = await this.requireOwnedSlackWorkspace(
      userId,
      slackWorkspaceId ?? '',
    );
    if (!channelId) {
      throw new BadRequestException('channelId is required');
    }
    if (!threadTs) {
      throw new BadRequestException('threadTs is required');
    }

    const [channel] = await this.db
      .select({ id: schema.slackChannels.id, name: schema.slackChannels.name })
      .from(schema.slackChannels)
      .where(
        and(
          eq(schema.slackChannels.id, channelId),
          eq(schema.slackChannels.slackWorkspaceId, workspace.id),
        ),
      )
      .limit(1);
    if (!channel) {
      throw new NotFoundException('slack channel not found');
    }

    const rows = await this.db
      .select(messageColumns)
      .from(schema.slackMessages)
      .innerJoin(
        schema.slackChannels,
        eq(schema.slackMessages.slackChannelId, schema.slackChannels.id),
      )
      .leftJoin(
        schema.slackUsers,
        and(
          eq(
            schema.slackUsers.slackWorkspaceId,
            schema.slackMessages.slackWorkspaceId,
          ),
          eq(schema.slackUsers.slackUserId, schema.slackMessages.slackUserId),
        ),
      )
      .where(
        and(
          eq(schema.slackMessages.slackWorkspaceId, workspace.id),
          eq(schema.slackMessages.slackChannelId, channelId),
          eq(schema.slackMessages.threadTs, threadTs),
          isNull(schema.slackMessages.deletedAt),
        ),
      )
      .orderBy(
        asc(sql`${schema.slackMessages.ts}::numeric`),
        asc(schema.slackMessages.id),
      );

    const messages = rows.map((row) =>
      this.toMessageSummary(row, workspace.mySlackUserId),
    );

    const replyCount = messages.filter(
      (message) => message.ts !== threadTs,
    ).length;

    return {
      threadTs,
      channelName: channel.name,
      replyCount,
      messages,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Mappers & helpers                                                       */
  /* ---------------------------------------------------------------------- */

  /** Maps a joined message row to its API summary (source hint + `isMine`). */
  private toMessageSummary(
    row: MessageRow,
    mySlackUserId: string | null,
  ): SlackMessageSummary {
    const authorName = row.realName ?? row.userName ?? null;
    const isMine =
      row.slackUserId !== null &&
      mySlackUserId !== null &&
      row.slackUserId === mySlackUserId;

    return {
      id: row.id,
      slackChannelId: row.slackChannelId,
      channelName: row.channelName,
      slackUserId: row.slackUserId,
      authorName,
      ts: row.ts,
      threadTs: row.threadTs,
      text: row.text,
      editedTs: row.editedTs,
      occurredAt: row.occurredAt.toISOString(),
      isMine,
      permalinkHint: `#${row.channelName}@${row.ts}`,
    };
  }

  /** Shallow-parses the uploaded bundle to JSON (structure check is the worker's). */
  private parseBundleShallow(fileBuffer: Buffer): unknown {
    try {
      return JSON.parse(fileBuffer.toString('utf8'));
    } catch {
      throw new BadRequestException('file is not valid JSON');
    }
  }

  /** Validates the optional workspace kind field (default `company`). */
  private resolveKind(kind: string | undefined): WorkspaceKind {
    if (kind === undefined || kind === '') {
      return 'company';
    }
    if (!WORKSPACE_KINDS.includes(kind as WorkspaceKind)) {
      throw new BadRequestException('kind must be one of: personal, company');
    }
    return kind as WorkspaceKind;
  }

  /** 기본 merge, 명시적 snapshot만 번들 채널의 누락 메시지를 삭제로 판정한다. */
  private resolveSyncMode(syncMode: string | undefined): SlackImportSyncMode {
    if (syncMode === undefined || syncMode === '') {
      return 'merge';
    }
    if (syncMode !== 'merge' && syncMode !== 'snapshot') {
      throw new BadRequestException('syncMode must be one of: merge, snapshot');
    }
    return syncMode;
  }

  /** Clamps the requested page size to `[1, MAX_LIMIT]` (default 50). */
  private parseLimit(limit: string | undefined): number {
    if (limit === undefined || limit === '') {
      return DEFAULT_LIMIT;
    }
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return Math.min(parsed, MAX_LIMIT);
  }

  /** Parses an optional ISO datetime filter, throwing on a malformed value. */
  private parseDate(value: string | undefined, label: string): Date | undefined {
    if (value === undefined || value === '') {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${label} must be an ISO datetime`);
    }
    return parsed;
  }

  /** Decodes an opaque `base64url("<epochMs>:<uuid>")` keyset cursor. */
  private decodeCursor(cursor: string | undefined): Cursor | undefined {
    if (cursor === undefined || cursor === '') {
      return undefined;
    }
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('invalid cursor');
    }
    const sep = decoded.indexOf(':');
    if (sep <= 0) {
      throw new BadRequestException('invalid cursor');
    }
    const epochMs = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isInteger(epochMs) || id === '') {
      throw new BadRequestException('invalid cursor');
    }
    return { occurredAt: new Date(epochMs), id };
  }

  /** Encodes the `(occurredAt, id)` keyset into an opaque base64url cursor. */
  private encodeCursor(occurredAt: Date, id: string): string {
    return Buffer.from(`${occurredAt.getTime()}:${id}`, 'utf8').toString(
      'base64url',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Narrows an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Coerces a driver-returned numeric aggregate (string | number) to an int. */
function toInt(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** Escapes LIKE/ILIKE metacharacters so user input matches literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
