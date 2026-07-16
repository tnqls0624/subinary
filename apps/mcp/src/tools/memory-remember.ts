import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { memoryTypeSchema } from '@family/contracts';
import { z } from 'zod';

import type { FamilyApiClient } from '../api-client';
import { describeError, textResult } from './shared';

/**
 * `memory_remember` → `POST /v1/memory/memories`.
 *
 * Directly stores an approved long-term memory ("remember this"). The memory
 * type is the `@family/contracts` enum. Returns the created memory's id/type/
 * subject so the caller can later `memory_forget` it.
 */
export function registerMemoryRemember(
  server: McpServer,
  client: FamilyApiClient,
): void {
  server.registerTool(
    'memory_remember',
    {
      title: '기억 저장',
      description:
        '장기 기억을 직접 저장합니다("이걸 기억해줘"). type은 다음 중 하나입니다: ' +
        'event(사건), fact(사실), decision(결정), preference(선호), procedure(절차), incident(장애), task(할일). ' +
        '저장 후 생성된 기억의 id를 반환하며, 이 id로 memory_forget 할 수 있습니다. ' +
        'workspaceId를 생략하면 기본 워크스페이스를 자동으로 사용합니다.',
      inputSchema: {
        type: memoryTypeSchema.describe(
          '기억 분류: event/fact/decision/preference/procedure/incident/task',
        ),
        subject: z.string().min(1).describe('기억의 제목/주제 (짧게)'),
        content: z.string().min(1).describe('기억의 상세 내용'),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('워크스페이스 ID(workspaces.id). 생략 시 기본값 자동 사용'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ type, subject, content, workspaceId }) => {
      try {
        const wsId = await client.resolveWorkspaceId(workspaceId);
        const memory = await client.createMemory({
          workspaceId: wsId,
          type,
          subject,
          content,
        });

        const body = [
          '기억을 저장했습니다.',
          `- id: ${memory.id}`,
          `- 분류(type): ${memory.type}`,
          `- 제목(subject): ${memory.subject}`,
          '',
          `이 기억을 지우려면 memory_forget에 memoryId="${memory.id}" 를 전달하세요.`,
        ].join('\n');
        return textResult(body);
      } catch (err) {
        return textResult(`기억 저장 실패: ${describeError(err)}`, true);
      }
    },
  );
}
