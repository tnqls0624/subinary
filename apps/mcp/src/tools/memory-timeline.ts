import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemorySummary, RelationshipSummary } from '@family/contracts';
import { z } from 'zod';

import type { FamilyApiClient } from '../api-client';
import { describeError, formatSeoul, textResult, truncate } from './shared';

/**
 * `memory_timeline`.
 *
 * - With `entityId`: `GET /v1/graph/timeline` — the relationship history of that
 *   entity ordered by validFrom ascending (formation/change over time).
 * - Without `entityId`: `GET /v1/memory/memories?current=true` — recent current
 *   memories (most recent first).
 *
 * `workspaceId` is auto-resolved when omitted.
 */
export function registerMemoryTimeline(
  server: McpServer,
  client: FamilyApiClient,
): void {
  server.registerTool(
    'memory_timeline',
    {
      title: '기억 타임라인',
      description:
        'entityId를 주면 해당 엔티티(사람/기술 등)와 얽힌 관계의 시간순 이력(형성/변경)을 반환하고, ' +
        'entityId가 없으면 현재 유효한 최근 기억을 최신순으로 반환합니다. ' +
        'workspaceId를 생략하면 기본 워크스페이스를 자동으로 사용합니다.',
      inputSchema: {
        entityId: z
          .string()
          .uuid()
          .optional()
          .describe('엔티티 ID. 주면 그래프 관계 이력, 생략하면 최근 기억 목록'),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('워크스페이스 ID(workspaces.id). 생략 시 기본값 자동 사용'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ entityId, workspaceId }) => {
      try {
        const wsId = await client.resolveWorkspaceId(workspaceId);

        if (entityId) {
          const res = await client.graphTimeline({
            workspaceId: wsId,
            entityId,
          });
          if (res.items.length === 0) {
            return textResult('해당 엔티티와 얽힌 관계 이력이 없습니다.');
          }
          const lines = res.items.map((rel, i) => formatRelationship(rel, i + 1));
          return textResult(
            [`엔티티 관계 이력 ${res.items.length}건 (시간순):`, '', ...lines].join(
              '\n',
            ),
          );
        }

        const res = await client.listMemories({
          workspaceId: wsId,
          current: true,
        });
        if (res.items.length === 0) {
          return textResult('현재 유효한 기억이 없습니다.');
        }
        // Most recent first.
        const sorted = [...res.items].sort(
          (a, b) => toTime(b.createdAt) - toTime(a.createdAt),
        );
        const lines = sorted.map((m, i) => formatMemory(m, i + 1));
        return textResult(
          [`최근 기억 ${sorted.length}건 (최신순):`, '', ...lines].join('\n'),
        );
      } catch (err) {
        return textResult(`타임라인 조회 실패: ${describeError(err)}`, true);
      }
    },
  );
}

function toTime(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function formatValidity(
  validFrom: string | null,
  validUntil: string | null,
): string {
  const from = validFrom ? formatSeoul(validFrom) : '(시작 미상)';
  const until = validUntil ? formatSeoul(validUntil) : '현재';
  return `${from} ~ ${until}`;
}

function formatRelationship(rel: RelationshipSummary, index: number): string {
  const flag = rel.isCurrent ? '현재' : '과거';
  const validity = formatValidity(rel.validFrom, rel.validUntil);
  const ref = rel.sourceRefId ? ` · ref=${rel.sourceRefId}` : '';
  return (
    `${index}. [${flag}] ${rel.sourceName} --${rel.type}--> ${rel.targetName}\n` +
    `   (${validity})${ref}`
  );
}

function formatMemory(memory: MemorySummary, index: number): string {
  const flag = memory.isCurrent ? '현재' : '과거';
  const validity = formatValidity(memory.validFrom, memory.validUntil);
  const sources =
    memory.sources.length > 0
      ? `\n   출처: ${memory.sources
          .map((s) => `${s.sourceType}:${s.sourceRefId}`)
          .join(', ')}`
      : '';
  return (
    `${index}. [${flag}][${memory.type}] ${memory.subject}\n` +
    `   ${truncate(memory.content)}\n` +
    `   (${validity})${sources}`
  );
}
