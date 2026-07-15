import { z } from 'zod';

/**
 * Slack import contracts (PRD §18/§26; Phase 6). Slack data is owner-only —
 * only the workspace `ownerUserId` may read it (family members cannot; §26).
 * Timestamps are ISO strings; `ts`/`threadTs` are Slack "epoch.micro" strings.
 */

// --- Responses ---

/**
 * `POST /v1/slack/import` acknowledgement. `importId` is the created
 * `source_items.id`; parsing runs asynchronously on the `slack-import` queue,
 * so the initial status is always `queued`.
 */
export const slackImportResponseSchema = z.object({
  importId: z.string(),
  slackWorkspaceId: z.string(),
  status: z.enum(['queued']),
});
export type SlackImportResponse = z.infer<typeof slackImportResponseSchema>;

/**
 * Workspace projection for `GET /v1/slack/workspaces` /
 * `GET /v1/slack/workspaces/:id`. Counts are aggregated over the normalized
 * channel/user/message tables; `lastImportedAt` is null before the first
 * successful import completes.
 */
export const slackWorkspaceSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slackTeamId: z.string().nullable(),
  mySlackUserId: z.string().nullable(),
  channelCount: z.number().int(),
  userCount: z.number().int(),
  messageCount: z.number().int(),
  lastImportedAt: z.string().nullable(),
});
export type SlackWorkspaceSummary = z.infer<typeof slackWorkspaceSummarySchema>;

/**
 * Message projection for `GET /v1/slack/messages` and thread views.
 * `isMine` is true when `slackUserId` matches the workspace `mySlackUserId`.
 * `permalinkHint` is a synthetic source hint (`#channel@ts`) — real Slack
 * permalinks are absent from exports (PRD §18).
 */
export const slackMessageSummarySchema = z.object({
  id: z.string(),
  slackChannelId: z.string(),
  channelName: z.string(),
  slackUserId: z.string().nullable(),
  authorName: z.string().nullable(),
  ts: z.string(),
  threadTs: z.string().nullable(),
  text: z.string(),
  editedTs: z.string().nullable(),
  occurredAt: z.string(),
  isMine: z.boolean(),
  permalinkHint: z.string().nullable(),
});
export type SlackMessageSummary = z.infer<typeof slackMessageSummarySchema>;

/** Cursor-paginated message list. `nextCursor` is null on the final page. */
export const slackMessageListResponseSchema = z.object({
  items: z.array(slackMessageSummarySchema),
  nextCursor: z.string().nullable(),
});
export type SlackMessageListResponse = z.infer<typeof slackMessageListResponseSchema>;

/**
 * `GET /v1/slack/threads` — a restored thread. `messages` are ordered by `ts`
 * ascending (root first, then replies); `replyCount` excludes the root.
 */
export const slackThreadResponseSchema = z.object({
  threadTs: z.string(),
  channelName: z.string(),
  replyCount: z.number().int(),
  messages: z.array(slackMessageSummarySchema),
});
export type SlackThreadResponse = z.infer<typeof slackThreadResponseSchema>;
