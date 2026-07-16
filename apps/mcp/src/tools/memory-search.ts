import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FamilyApiClient } from '../api-client';
import { describeError, formatCitations, textResult } from './shared';

/**
 * `memory_search` → `POST /v1/ai/work-query`.
 *
 * Asks a natural-language question grounded in the owner's Slack-derived memory.
 * Returns a grounded answer plus its citations, or the API's refusal reason when
 * there is no supporting evidence (the LLM is not invoked in that case).
 */
export function registerMemorySearch(
  server: McpServer,
  client: FamilyApiClient,
): void {
  server.registerTool(
    'memory_search',
    {
      title: '기억 검색 (근거 기반 질의응답)',
      description:
        '자연어 질문에 대해 개인 기억(Slack 대화 기반)에서 근거를 찾아 답변합니다. ' +
        '답변과 함께 출처(채널/시각/원문 스니펫)를 포함합니다. 근거가 없으면 답변하지 않고 사유를 반환합니다. ' +
        'workspaceId를 생략하면 기본 워크스페이스를 자동으로 사용합니다.',
      inputSchema: {
        question: z
          .string()
          .min(1)
          .max(1000)
          .describe('자연어 질문 (예: "결제 인증서 만료 장애는 어떻게 해결했나요?")'),
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
    async ({ question, workspaceId }) => {
      try {
        const wsId = await client.resolveWorkspaceId(workspaceId);
        const res = await client.workQuery({ workspaceId: wsId, question });

        if (res.refused) {
          return textResult(
            `근거를 찾지 못해 답변하지 않았습니다.\n사유: ${res.reason ?? '관련 근거 없음'}`,
          );
        }

        const body = [
          res.answer ?? '(빈 답변)',
          '',
          formatCitations(res.citations),
        ].join('\n');
        return textResult(body);
      } catch (err) {
        return textResult(`기억 검색 실패: ${describeError(err)}`, true);
      }
    },
  );
}
