import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FamilyApiClient } from '../api-client';
import { describeError, textResult } from './shared';

/**
 * `memory_forget` → `DELETE /v1/memory/memories/:id`.
 *
 * Soft-deletes a memory by id (owner-only, enforced by the API). Returns a
 * confirmation. Deleting the same id again is a no-op from the caller's view.
 */
export function registerMemoryForget(
  server: McpServer,
  client: FamilyApiClient,
): void {
  server.registerTool(
    'memory_forget',
    {
      title: '기억 삭제',
      description:
        '기억을 id로 삭제(soft-delete)합니다. memory_remember가 반환한 id를 사용하세요. ' +
        '로그인한 사용자가 소유한 기억만 삭제할 수 있습니다(API가 권한을 강제).',
      inputSchema: {
        memoryId: z.string().min(1).describe('삭제할 기억의 id'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ memoryId }) => {
      try {
        const result = await client.deleteMemory(memoryId);
        if (result.deleted) {
          return textResult(`기억을 삭제했습니다 (id=${memoryId}).`);
        }
        return textResult(`기억 삭제가 확인되지 않았습니다 (id=${memoryId}).`, true);
      } catch (err) {
        return textResult(`기억 삭제 실패: ${describeError(err)}`, true);
      }
    },
  );
}
