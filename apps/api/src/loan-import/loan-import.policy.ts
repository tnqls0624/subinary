import { createHash } from 'node:crypto';

/** Capture time is observation time, never a bank valuation timestamp. */
export function assertLoanCaptureTime(capturedAt: string, now = Date.now()): void {
  const at = Date.parse(capturedAt);
  if (!Number.isFinite(at) || at > now + 120_000) throw new RangeError('loan_capture_future');
  if (at < now - 86_400_000) throw new RangeError('loan_capture_stale');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stored only in the immutable snapshot; never a public identifier or bank signature. */
export function loanCommitHash(ownerUserId: string, input: unknown): string {
  return createHash('sha256').update(canonical({ ownerUserId, input })).digest('hex');
}

