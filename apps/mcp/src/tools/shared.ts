import type { Citation } from '@family/contracts';
import { toSeoulString } from '@family/shared';

import { ApiError } from '../api-client';

/**
 * Shared tool helpers (Phase 10 spec §2.4): a uniform `{ content: [text] }`
 * result shape, human-readable citation/timestamp/money formatting, and
 * error-to-message mapping. Every search/read result embeds its sources in a
 * human-readable "출처:" block; permission/refusal errors are surfaced as plain
 * prose (never leaking secrets).
 */

/** Minimal MCP tool result (a single text block, optional error flag). */
export interface ToolTextResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Build a text tool result. `isError` marks operational failures. */
export function textResult(text: string, isError = false): ToolTextResult {
  return { content: [{ type: 'text', text }], isError };
}

/** Render an ISO timestamp in Asia/Seoul; falls back to the raw string. */
export function formatSeoul(iso: string): string {
  try {
    return toSeoulString(new Date(iso));
  } catch {
    return iso;
  }
}

/** Collapse whitespace and hard-cap a snippet length for readable output. */
export function truncate(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Format KRW integer as `₩1,234` / `-₩1,234`. */
export function formatKrw(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}₩${Math.abs(amount).toLocaleString('ko-KR')}`;
}

/** Citation metadata only: `#channel · time · ref=…` (no snippet). */
export function formatCitationMeta(citation: Citation): string {
  const channel = citation.channelName ? `#${citation.channelName}` : '(채널 미상)';
  const when = formatSeoul(citation.occurredAt);
  return `${channel} · ${when} · ref=${citation.sourceRefId}`;
}

/** One citation line: `1. #channel · time · ref=… \n   "snippet"`. */
export function formatCitation(citation: Citation, index: number): string {
  const snippet = truncate(citation.snippet);
  return `${index}. ${formatCitationMeta(citation)}\n   "${snippet}"`;
}

/** A "출처:" block for a list of citations (or an explicit "(없음)"). */
export function formatCitations(citations: Citation[]): string {
  if (citations.length === 0) return '출처: (없음)';
  const lines = citations.map((c, i) => formatCitation(c, i + 1));
  return ['출처:', ...lines].join('\n');
}

/**
 * Map any thrown error to a concise, human-readable message. API refusals such
 * as 403 (ownership) are relayed verbatim in intent so the caller understands
 * that the API — not the MCP layer — enforced the boundary. Never leaks secrets.
 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return '인증이 만료되었거나 자격 증명이 올바르지 않습니다. FAMILY_EMAIL/FAMILY_PASSWORD를 확인하세요.';
      case 403:
        return '접근 권한이 없습니다. 로그인한 사용자가 소유한 데이터만 조회하거나 변경할 수 있습니다 (API가 권한을 강제합니다).';
      case 404:
        return '대상을 찾을 수 없습니다. 식별자(id)가 올바른지 확인하세요.';
      case 400:
        return `요청이 올바르지 않습니다: ${err.message}`;
      case 0:
        return err.message;
      default:
        return `API 오류 (HTTP ${err.status}): ${err.message}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
