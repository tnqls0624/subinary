import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FamilyApiClient } from '../api-client';
import { describeError, formatCitationMeta, textResult, truncate } from './shared';

/**
 * `memory_read` → `POST /v1/ai/retrieval`.
 *
 * Hybrid search over the owner's memory chunks. Returns the top-ranked passages
 * (snippet + citation) without generating an answer — useful for pulling the raw
 * source material behind a topic.
 */
export function registerMemoryRead(
  server: McpServer,
  client: FamilyApiClient,
): void {
  server.registerTool(
    'memory_read',
    {
      title: '기억 원문 검색 (하이브리드 검색)',
      description:
        '질의와 관련된 기억 원문 스니펫을 관련도 순으로 반환합니다(답변 생성 없음). ' +
        '각 항목에 출처(채널/시각/원문)를 포함합니다. topK로 개수를 조절할 수 있습니다(1-20, 기본 5). ' +
        'workspaceId를 생략하면 기본 워크스페이스를 자동으로 사용합니다.',
      inputSchema: {
        query: z.string().min(1).describe('검색어 또는 자연어 질의'),
        topK: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('반환할 최대 항목 수 (1-20, 기본 5)'),
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
    async ({ query, topK, workspaceId }) => {
      try {
        const wsId = await client.resolveWorkspaceId(workspaceId);
        const res = await client.retrieve({ workspaceId: wsId, query, topK });

        if (res.items.length === 0) {
          return textResult('관련 기록을 찾지 못했습니다.');
        }

        const header = res.hasEvidence
          ? `검색 결과 ${res.items.length}건:`
          : `검색 결과 ${res.items.length}건 (정확히 일치하는 근거 없음 — 참고용):`;

        const blocks = res.items.map((item, index) => {
          const snippet = truncate(item.snippet);
          // Item snippet as the content, plus a one-line source (출처) beneath it.
          return `${index + 1}. "${snippet}"\n   출처: ${formatCitationMeta(item.citation)}`;
        });

        return textResult([header, '', ...blocks].join('\n'));
      } catch (err) {
        return textResult(`기억 원문 검색 실패: ${describeError(err)}`, true);
      }
    },
  );
}
