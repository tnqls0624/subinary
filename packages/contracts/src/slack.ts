import { z } from 'zod';

/**
 * Slack import contracts (PRD §18/§26; Phase 6). Slack data is owner-only —
 * only the workspace `ownerUserId` may read it (family members cannot; §26).
 * Timestamps are ISO strings; `ts`/`threadTs` are Slack "epoch.micro" strings.
 */

// --- Responses ---

/** Slack export 재수집 동기화 방식. snapshot은 번들에 포함된 채널만 완전본으로 본다. */
export const slackImportSyncModeSchema = z.enum(['merge', 'snapshot']);
export type SlackImportSyncMode = z.infer<typeof slackImportSyncModeSchema>;

/**
 * 업로드 형식. Slack Export **ZIP**과 (기존) 사전 변환된 **단일 JSON 번들**을 둘 다
 * 받는다. 고급 사용자·스크립트가 이미 JSON을 올리고 있을 수 있어 깨뜨리지 않는다.
 * 서버가 매직 바이트로 판별하므로 클라이언트가 지정하지 않는다.
 */
export const slackImportFormatSchema = z.enum(['json', 'zip']);
export type SlackImportFormat = z.infer<typeof slackImportFormatSchema>;

/** import 처리 상태(마이그레이션 0054). */
export const slackImportStatusSchema = z.enum([
  'queued',
  'processing',
  'completed',
  'failed',
]);
export type SlackImportStatus = z.infer<typeof slackImportStatusSchema>;

/**
 * 실패 사유 코드.
 *
 * **자유 텍스트가 아니라 닫힌 어휘인 이유**: 이 값은 저장되고 그대로 사용자 화면까지
 * 간다. 서버 예외 메시지를 흘려보내면 파일 경로·엔트리 이름·원문 조각이 새어 나간다
 * (로깅 규약: `apps/api/src/slack/slack.service.ts` 상단). 화면 문구는 이 코드로 갈라
 * 쓰고, 코드에 없는 실패는 전부 `internal_error`로 접는다.
 */
export const slackImportErrorCodeSchema = z.enum([
  /* --- ZIP 형식·안전 --- */
  /** ZIP 구조가 아니거나 손상됨(EOCD 없음, CRC 불일치). */
  'zip_invalid',
  /** 엔트리 이름이 아카이브 루트를 벗어남(zip-slip) 또는 심볼릭 링크. */
  'zip_unsafe_entry',
  /** 엔트리 개수 상한 초과. */
  'zip_too_many_entries',
  /** 엔트리 1개의 해제 후 크기 상한 초과. */
  'zip_entry_too_large',
  /** 해제 후 누적 크기 상한 초과. */
  'zip_total_too_large',
  /** 압축비 상한 초과(zip bomb). */
  'zip_ratio_exceeded',
  /** 암호화된 아카이브 — 열 수 없다. */
  'zip_encrypted',
  /** Zip64·멀티디스크·미지원 압축 방식. */
  'zip_unsupported',
  /* --- Slack Export 구조 --- */
  /** 아카이브에 `channels.json`이 없다. */
  'zip_missing_channels',
  /** 아카이브에 `users.json`이 없다. */
  'zip_missing_users',
  /** 목록 파일이 JSON 배열이 아니다. */
  'zip_malformed_metadata',
  /* --- 단일 JSON 번들 --- */
  /** 업로드가 JSON으로 파싱되지 않는다. */
  'bundle_invalid_json',
  /** 번들 구조가 계약과 다르다(`workspace`/`channels`/`users`/`messages`). */
  'bundle_invalid_structure',
  /* --- 그 밖 --- */
  /** 원문 저장소(MinIO)에서 번들을 읽지 못했다. */
  'storage_unavailable',
  /** 분류되지 않은 실패. 상세는 서버 로그에만 남는다. */
  'internal_error',
]);
export type SlackImportErrorCode = z.infer<typeof slackImportErrorCodeSchema>;

/**
 * `POST /v1/slack/import` acknowledgement. `importId` is the created
 * `source_items.id`; parsing runs asynchronously on the `slack-import` queue,
 * so the initial status is always `queued`.
 *
 * 이 응답만으로는 **성공을 알 수 없다.** 결과는 `GET /v1/slack/imports/:importId`를
 * 폴링해 확인한다 — 예전에는 그 조회가 없어서 워커에서 실패해도 사용자가 이유를
 * 영영 알 수 없었다.
 */
export const slackImportResponseSchema = z.object({
  importId: z.string(),
  slackWorkspaceId: z.string(),
  syncMode: slackImportSyncModeSchema,
  status: z.enum(['queued']),
  /** 서버가 매직 바이트로 판별한 업로드 형식. */
  format: slackImportFormatSchema,
});
export type SlackImportResponse = z.infer<typeof slackImportResponseSchema>;

/**
 * `GET /v1/slack/imports/:importId` — import 1건의 상태(owner 전용).
 *
 * 새로고침·앱 재시작 뒤에도 복구된다(DB에 저장한다 — BullMQ 잡은 `removeOnComplete`로
 * 사라진다). 건수는 `completed` 전에는 `null`이다: "아직 모른다"와 "0건"은 다른 사실이다.
 */
export const slackImportStatusResponseSchema = z.object({
  importId: z.string(),
  slackWorkspaceId: z.string(),
  status: slackImportStatusSchema,
  format: slackImportFormatSchema,
  syncMode: slackImportSyncModeSchema,
  /** `failed`일 때만 채워진다. */
  errorCode: slackImportErrorCodeSchema.nullable(),
  /** 업로드된 (압축) 파일 크기 bytes. */
  uploadBytes: z.number().int(),
  /** 워커 시도 횟수(재시도 포함). */
  attempt: z.number().int(),
  channelCount: z.number().int().nullable(),
  userCount: z.number().int().nullable(),
  messageCount: z.number().int().nullable(),
  createdMessageCount: z.number().int().nullable(),
  updatedMessageCount: z.number().int().nullable(),
  deletedMessageCount: z.number().int().nullable(),
  skippedMessageCount: z.number().int().nullable(),
  warningCount: z.number().int().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type SlackImportStatusResponse = z.infer<
  typeof slackImportStatusResponseSchema
>;

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

/** `PATCH /v1/slack/messages/:id` 요청. 빈 본문은 DELETE로만 처리한다. */
export const slackMessageEditRequestSchema = z.object({
  text: z.string().min(1).max(200_000),
  editedTs: z.string().trim().min(1).max(64).optional(),
});
export type SlackMessageEditRequest = z.infer<
  typeof slackMessageEditRequestSchema
>;

/** Slack message current projection 변경 접수 결과. */
export const slackMessageChangeResponseSchema = z.object({
  messageId: z.string().uuid(),
  eventId: z.string().uuid(),
  operation: z.enum(['edited', 'deleted']),
  status: z.literal('queued'),
  changedAt: z.string(),
});
export type SlackMessageChangeResponse = z.infer<
  typeof slackMessageChangeResponseSchema
>;
