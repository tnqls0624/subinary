/**
 * Public types for `@family/slack-parser`.
 *
 * This package is intentionally free of any dependency on `@family/contracts`,
 * `@family/database` or `@family/shared` (Phase 6 spec §3): the parser is a pure
 * `unknown -> ParsedSlackExport` function, so it owns its own input/output shapes
 * to avoid import cycles and to keep the worker's dependency graph small (no zod,
 * no drizzle, no pino).
 *
 * The `Raw*` shapes mirror the uploaded Slack export JSON bundle exactly (Phase 6
 * spec §1.1). The `Normalized*` shapes are what the worker persists into the
 * `slack_channels` / `slack_users` / `slack_messages` / `slack_threads` tables.
 */

/** A single channel entry in the uploaded export bundle. */
export interface RawChannel {
  /** Slack channel id, e.g. `C1`. */
  id: string;
  /** Channel display name, e.g. `eng-backend`. */
  name: string;
}

/** A single user entry in the uploaded export bundle. */
export interface RawUser {
  /** Slack user id, e.g. `U1`. */
  id: string;
  /** Slack handle / username. */
  name: string;
  /** Optional real name; absent for some exports. */
  real_name?: string;
}

/** A single message entry in the uploaded export bundle. */
export interface RawMessage {
  /** Slack channel id this message belongs to. */
  channel: string;
  /** Slack timestamp, an `"epoch.micro"` string (also the per-channel message id). */
  ts: string;
  /** Authoring Slack user id; absent for system/bot messages. */
  user?: string;
  /** Message body; absent for some events (treated as empty text). */
  text?: string;
  /** Thread root ts. Equal to `ts` for a root, differs for a reply, absent for standalone. */
  thread_ts?: string;
  /** Last-edit ts, or `null`/absent when never edited. */
  edited_ts?: string | null;
}

/** The uploaded Slack export bundle (Phase 6 spec §1.1). */
export interface SlackExportBundle {
  /** Workspace metadata; both fields optional in the export. */
  workspace: { name?: string; slackTeamId?: string };
  channels: RawChannel[];
  users: RawUser[];
  messages: RawMessage[];
}

/** Normalized workspace metadata; absent fields become `null`. */
export interface NormalizedWorkspace {
  name: string | null;
  slackTeamId: string | null;
}

/** Normalized channel, keyed by its Slack channel id. */
export interface NormalizedChannel {
  slackChannelId: string;
  name: string;
}

/** Normalized user, keyed by its Slack user id. `realName` is `null` when absent. */
export interface NormalizedUser {
  slackUserId: string;
  name: string;
  realName: string | null;
}

/**
 * Normalized message ready for `slack_messages`. `text` is always a string (empty
 * when the raw message carried no text). `occurredAt` is derived from `ts` via
 * {@link tsToDate}. Its uniqueness key downstream is `(slackChannelId, ts)`.
 */
export interface NormalizedMessage {
  slackChannelId: string;
  /** Slack user id string, or `null` for system/bot messages. */
  slackUserId: string | null;
  ts: string;
  /** Thread root ts, or `null` for a standalone (non-threaded) message. */
  threadTs: string | null;
  text: string;
  /** Last-edit ts, or `null` when never edited. */
  editedTs: string | null;
  /** Absolute instant derived from the epoch seconds portion of `ts`. */
  occurredAt: Date;
}

/**
 * Normalized thread ready for `slack_threads`. One entry per
 * `(slackChannelId, threadTs)` group.
 */
export interface NormalizedThread {
  slackChannelId: string;
  threadTs: string;
  /** Smallest `ts` in the group (the thread root), by numeric comparison. */
  rootTs: string;
  /** Group size minus one (the root itself is not a reply). */
  replyCount: number;
  /** Largest `occurredAt` in the group, or `null` when the group is empty. */
  lastReplyAt: Date | null;
}

/**
 * Full result of parsing a Slack export bundle.
 *
 * `warnings` collects non-fatal notes (skipped messages that reference an unknown
 * channel, and possible-secret detections). Warnings never contain raw message
 * text, PII or the matched secret — only identifiers such as channel id and ts
 * (Phase 6 spec §0 / logging rules).
 */
export interface ParsedSlackExport {
  workspace: NormalizedWorkspace;
  channels: NormalizedChannel[];
  users: NormalizedUser[];
  messages: NormalizedMessage[];
  threads: NormalizedThread[];
  warnings: string[];
}
