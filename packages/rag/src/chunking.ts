/**
 * Slack thread chunking (Phase 7 spec §1.1 / §3).
 *
 * A Slack thread (all messages sharing a `threadTs`) is collapsed into a single
 * retrieval chunk so that surrounding context is preserved. The chunk text is the
 * ts-ordered concatenation of `"작성자명: 내용"` lines; empty-text messages are
 * skipped. The chunk's `occurredAt` is the thread root's `occurredAt`.
 *
 * This package is intentionally dependency-free (Phase 0/6/7 spec §3): it owns its
 * own input/output shapes and never imports `@family/database`, `@family/contracts`
 * or drizzle. Callers map {@link ChunkDraft} onto the `chunks` table
 * (`UNIQUE(workspaceId, sourceType, sourceRefId)`) for idempotent upserts.
 *
 * Logging discipline (spec §0): this module never logs; callers must log only
 * counts / identifiers, never the combined `text`.
 */

/** A single message belonging to a thread, as fed to the chunker. */
export interface ThreadMessageInput {
  /** Display name of the author (resolved upstream via a users join). */
  authorName: string;
  /** Message body; empty / whitespace-only messages are skipped when joining. */
  text: string;
  /** Slack `ts` (`"epoch.micro"`), used to order messages within the thread. */
  ts: string;
  /** Absolute instant derived from `ts`. */
  occurredAt: Date;
}

/** A thread (or standalone message group) to be chunked. */
export interface ThreadInput {
  /** Thread root ts; also becomes the chunk's `sourceRefId`. */
  threadTs: string;
  /** Channel display name, carried onto the chunk for citations. */
  channelName: string;
  /** Owning Slack channel id (fk target upstream). */
  slackChannelId: string;
  /** All messages in the thread; ordering is normalized here by `ts`. */
  messages: ThreadMessageInput[];
}

/** Source kind a chunk was derived from. */
export type ChunkSourceType = 'slack_thread' | 'slack_message';

/**
 * A retrieval chunk ready to be persisted into `chunks`. `workspaceRef` is left
 * for the caller to fill (the pure package is workspace-agnostic).
 */
export interface ChunkDraft {
  /** Optional caller-supplied workspace reference (filled downstream). */
  workspaceRef?: string;
  sourceType: ChunkSourceType;
  /** `threadTs` for a thread chunk, message `ts` for a standalone message chunk. */
  sourceRefId: string;
  slackChannelId: string;
  channelName: string;
  /** ts-ordered `"작성자: 내용"` join of the non-empty messages. */
  text: string;
  /** Thread root `occurredAt`. */
  occurredAt: Date;
}

/**
 * Numeric-first `ts` comparison, matching `@family/slack-parser`'s `compareTs`
 * (Phase 6 spec §3) so thread ordering is identical across packages. Falls back to
 * a lexical compare when either value is not a finite number.
 */
function compareTs(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  if (na < nb) return -1;
  if (na > nb) return 1;
  return 0;
}

/** True when a message carries usable text (not empty / whitespace only). */
function hasText(msg: ThreadMessageInput): boolean {
  return msg.text.trim().length > 0;
}

/**
 * Resolve the thread root: the message whose `ts` equals `threadTs`, otherwise the
 * earliest message by `ts`. Returns `null` for an empty thread.
 */
function resolveRoot(thread: ThreadInput): ThreadMessageInput | null {
  const { threadTs, messages } = thread;
  if (messages.length === 0) return null;
  const exact = messages.find((m) => m.ts === threadTs);
  if (exact) return exact;
  let earliest = messages[0];
  for (const m of messages) {
    if (compareTs(m.ts, earliest.ts) < 0) earliest = m;
  }
  return earliest;
}

/**
 * Build the combined chunk text for a set of thread messages (Phase 7 spec §1.1):
 * order by `ts` ascending, drop empty-text messages, then join each surviving
 * message as `"작성자명: 내용"` on newlines. Returns `''` when nothing remains.
 *
 * The input array is not mutated.
 */
export function buildThreadChunkText(msgs: ThreadMessageInput[]): string {
  return [...msgs]
    .sort((a, b) => compareTs(a.ts, b.ts))
    .filter(hasText)
    .map((m) => `${m.authorName}: ${m.text}`)
    .join('\n');
}

/**
 * Chunk a batch of Slack threads into {@link ChunkDraft}s (Phase 7 spec §1.1 / §3).
 *
 * One chunk per thread: `sourceType='slack_thread'`, `sourceRefId=threadTs`,
 * `occurredAt` = the thread root's `occurredAt`. Threads that yield no non-empty
 * text are skipped entirely (nothing worth indexing).
 */
export function chunkSlackThreads(threads: ThreadInput[]): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  for (const thread of threads) {
    const text = buildThreadChunkText(thread.messages);
    if (text.length === 0) continue;
    const root = resolveRoot(thread);
    if (root === null) continue;
    drafts.push({
      sourceType: 'slack_thread',
      sourceRefId: thread.threadTs,
      slackChannelId: thread.slackChannelId,
      channelName: thread.channelName,
      text,
      occurredAt: root.occurredAt,
    });
  }
  return drafts;
}
