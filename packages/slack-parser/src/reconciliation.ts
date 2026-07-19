/** Slack export 재수집 시 사용할 동기화 방식. */
export type SlackImportSyncMode = 'merge' | 'snapshot';

/** DB 식별자로 정규화한 수신 메시지 projection. */
export interface IncomingSlackMessageProjection {
  slackChannelId: string;
  slackUserId: string | null;
  ts: string;
  threadTs: string | null;
  text: string;
  editedTs: string | null;
  occurredAt: Date;
}

/** 비교에 필요한 기존 메시지 projection. tombstone은 import로 복구하지 않는다. */
export interface CurrentSlackMessageProjection
  extends IncomingSlackMessageProjection {
  id: string;
  deletedAt: Date | null;
}

export interface SlackMessageUpdate {
  id: string;
  previous: CurrentSlackMessageProjection;
  incoming: IncomingSlackMessageProjection;
}

/** DB write와 후속 RAG target 계산에 필요한 결정적 change-set. */
export interface SlackMessageReconciliation {
  created: IncomingSlackMessageProjection[];
  updated: SlackMessageUpdate[];
  deleted: CurrentSlackMessageProjection[];
  duplicateIncomingCount: number;
  ignoredTombstoneCount: number;
  ignoredStaleUpdateCount: number;
}

function messageKey(slackChannelId: string, ts: string): string {
  return `${slackChannelId}\u0000${ts}`;
}

function hasProjectionChange(
  current: CurrentSlackMessageProjection,
  incoming: IncomingSlackMessageProjection,
): boolean {
  return (
    current.slackUserId !== incoming.slackUserId ||
    current.threadTs !== incoming.threadTs ||
    current.text !== incoming.text ||
    current.editedTs !== incoming.editedTs ||
    current.occurredAt.getTime() !== incoming.occurredAt.getTime()
  );
}

function compareSlackTs(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

/** 현재 편집 revision보다 최신임을 증명하지 못하는 수신 행은 덮어쓰지 않는다. */
function isStaleUpdate(
  current: CurrentSlackMessageProjection,
  incoming: IncomingSlackMessageProjection,
): boolean {
  if (current.editedTs === null) {
    return false;
  }
  if (incoming.editedTs === null) {
    return true;
  }
  return compareSlackTs(incoming.editedTs, current.editedTs) <= 0;
}

/**
 * 수신 bundle과 current projection을 비교한다.
 *
 * - merge: 수신 행의 생성·편집만 반영한다.
 * - snapshot: `snapshotChannelIds`에 포함된 채널에서 누락된 활성 행만 삭제한다.
 * - 이미 삭제된 행은 privacy tombstone으로 간주해 어떤 import도 되살리지 않는다.
 * - bundle 내부 중복 키는 마지막 행을 사용해 배치 upsert 충돌을 방지한다.
 */
export function reconcileSlackMessages(input: {
  syncMode: SlackImportSyncMode;
  incoming: readonly IncomingSlackMessageProjection[];
  current: readonly CurrentSlackMessageProjection[];
  snapshotChannelIds: ReadonlySet<string>;
}): SlackMessageReconciliation {
  const incomingByKey = new Map<string, IncomingSlackMessageProjection>();
  let duplicateIncomingCount = 0;
  for (const message of input.incoming) {
    const key = messageKey(message.slackChannelId, message.ts);
    if (incomingByKey.has(key)) {
      duplicateIncomingCount += 1;
    }
    incomingByKey.set(key, message);
  }

  const currentByKey = new Map(
    input.current.map((message) => [
      messageKey(message.slackChannelId, message.ts),
      message,
    ]),
  );
  const created: IncomingSlackMessageProjection[] = [];
  const updated: SlackMessageUpdate[] = [];
  let ignoredTombstoneCount = 0;
  let ignoredStaleUpdateCount = 0;

  for (const [key, incoming] of incomingByKey) {
    const current = currentByKey.get(key);
    if (current === undefined) {
      created.push(incoming);
    } else if (current.deletedAt !== null) {
      ignoredTombstoneCount += 1;
    } else if (hasProjectionChange(current, incoming)) {
      if (isStaleUpdate(current, incoming)) {
        ignoredStaleUpdateCount += 1;
      } else {
        updated.push({ id: current.id, previous: current, incoming });
      }
    }
  }

  const deleted =
    input.syncMode === 'snapshot'
      ? input.current.filter(
          (message) =>
            message.deletedAt === null &&
            input.snapshotChannelIds.has(message.slackChannelId) &&
            !incomingByKey.has(messageKey(message.slackChannelId, message.ts)),
        )
      : [];

  return {
    created,
    updated,
    deleted,
    duplicateIncomingCount,
    ignoredTombstoneCount,
    ignoredStaleUpdateCount,
  };
}
