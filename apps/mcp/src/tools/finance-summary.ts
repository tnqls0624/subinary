import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FamilyApiClient } from '../api-client';
import { describeError, formatKrw, formatSeoul, textResult } from './shared';

/**
 * `finance_summary` → `GET /v1/analytics/monthly`.
 *
 * Net spend for a month (default: current Asia/Seoul month) with the delta vs.
 * the immediately preceding equal-length window. Amounts are KRW integers.
 * `householdId` is auto-resolved when omitted.
 */
export function registerFinanceSummary(
  server: McpServer,
  client: FamilyApiClient,
): void {
  server.registerTool(
    'finance_summary',
    {
      title: '금융 요약 (월별 순지출)',
      description:
        '지정한 달(YYYY-MM, 생략 시 이번 달)의 순지출과 전월 대비 증감을 요약합니다. ' +
        '금액은 KRW 정수입니다. 가구 구성원 권한/공개범위는 API가 적용합니다. ' +
        'householdId를 생략하면 기본 가구를 자동으로 사용합니다.',
      inputSchema: {
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/, 'YYYY-MM 형식이어야 합니다')
          .optional()
          .describe('대상 월 (예: 2026-07). 생략 시 이번 달(Asia/Seoul)'),
        householdId: z
          .string()
          .uuid()
          .optional()
          .describe('가구 ID. 생략 시 기본값 자동 사용'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ month, householdId }) => {
      try {
        const hhId = await client.resolveHouseholdId(householdId);
        const res = await client.monthly({ householdId: hhId, month });

        const period = `${formatSeoul(res.meta.period.from)} ~ ${formatSeoul(
          res.meta.period.to,
        )} (${res.meta.period.timezone})`;

        const rate =
          res.deltaRate === null
            ? '(전월 0원 — 비율 산출 불가)'
            : `${(res.deltaRate * 100).toFixed(1)}%`;
        const deltaSign = res.deltaNet > 0 ? '+' : '';

        const body = [
          '금융 요약',
          `- 기간: ${period}`,
          `- 순지출: ${formatKrw(res.totalNet)}`,
          `- 승인 합계: ${formatKrw(res.totalApproved)} · 취소 합계: ${formatKrw(
            res.totalCancelled,
          )}`,
          `- 거래 건수: ${res.transactionCount}건`,
          `- 전월(직전 동일기간) 순지출: ${formatKrw(res.previousNet)}`,
          `- 증감: ${deltaSign}${formatKrw(res.deltaNet)} (전월 대비 ${rate})`,
        ].join('\n');

        return textResult(body);
      } catch (err) {
        return textResult(`금융 요약 실패: ${describeError(err)}`, true);
      }
    },
  );
}
