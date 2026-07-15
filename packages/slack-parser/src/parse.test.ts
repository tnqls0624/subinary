import { describe, expect, it } from 'vitest';

import { compareTs, parseSlackExport, tsToDate } from './parse.js';
import type { SlackExportBundle } from './types.js';

/**
 * A representative bundle: a 3-message thread in `C1`, a standalone message and a
 * system (no user/text) message in `C2`, a message referencing an unknown channel
 * (`C9`, to be skipped), and a message carrying an obvious secret token.
 */
function makeBundle(): SlackExportBundle {
  return {
    workspace: { name: '회사 슬랙', slackTeamId: 'T123' },
    channels: [
      { id: 'C1', name: 'eng-backend' },
      { id: 'C2', name: 'general' },
    ],
    users: [
      { id: 'U1', name: 'soobeen', real_name: '수빈' },
      { id: 'U2', name: 'alex' },
    ],
    messages: [
      // Thread root (thread_ts === ts).
      {
        channel: 'C1',
        ts: '1721040600.000100',
        user: 'U1',
        text: 'root message',
        thread_ts: '1721040600.000100',
      },
      // Reply 1 (edited).
      {
        channel: 'C1',
        ts: '1721040700.000200',
        user: 'U2',
        text: 'first reply',
        thread_ts: '1721040600.000100',
        edited_ts: '1721040750.000000',
      },
      // Reply 2 (latest).
      {
        channel: 'C1',
        ts: '1721040800.000300',
        user: 'U1',
        text: 'second reply',
        thread_ts: '1721040600.000100',
      },
      // Standalone message, different channel, no thread_ts.
      { channel: 'C2', ts: '1721050000.000000', user: 'U2', text: 'standalone' },
      // System message: no user, no text, edited_ts null.
      { channel: 'C2', ts: '1721050100.000000', edited_ts: null },
      // References a channel that does not exist -> skipped with warning.
      { channel: 'C9', ts: '1721050200.000000', user: 'U1', text: 'ghost' },
      // Carries an obvious Slack bot token -> secret warning, still stored.
      { channel: 'C1', ts: '1721050300.000000', user: 'U1', text: 'creds: xoxb-abc-123' },
    ],
  };
}

describe('parseSlackExport — normalization', () => {
  it('normalizes workspace, channels and users', () => {
    const result = parseSlackExport(makeBundle());

    expect(result.workspace).toEqual({ name: '회사 슬랙', slackTeamId: 'T123' });
    expect(result.channels).toEqual([
      { slackChannelId: 'C1', name: 'eng-backend' },
      { slackChannelId: 'C2', name: 'general' },
    ]);
    expect(result.users).toEqual([
      { slackUserId: 'U1', name: 'soobeen', realName: '수빈' },
      // real_name absent -> realName null.
      { slackUserId: 'U2', name: 'alex', realName: null },
    ]);
  });

  it('defaults missing text to empty string and missing user to null', () => {
    const result = parseSlackExport(makeBundle());
    const system = result.messages.find((m) => m.ts === '1721050100.000000');

    expect(system).toBeDefined();
    expect(system?.text).toBe('');
    expect(system?.slackUserId).toBeNull();
    expect(system?.threadTs).toBeNull();
    expect(system?.editedTs).toBeNull();
  });

  it('maps edited_ts and thread_ts onto normalized messages', () => {
    const result = parseSlackExport(makeBundle());
    const reply = result.messages.find((m) => m.ts === '1721040700.000200');

    expect(reply?.editedTs).toBe('1721040750.000000');
    expect(reply?.threadTs).toBe('1721040600.000100');
    expect(reply?.slackUserId).toBe('U2');
  });
});

describe('parseSlackExport — unknown channel', () => {
  it('skips messages referencing an unknown channel and warns', () => {
    const result = parseSlackExport(makeBundle());

    // The C9 message is dropped; 6 of 7 raw messages survive.
    expect(result.messages).toHaveLength(6);
    expect(result.messages.some((m) => m.slackChannelId === 'C9')).toBe(false);
    expect(
      result.warnings.some((w) => w.includes('unknown channel') && w.includes('C9')),
    ).toBe(true);
  });
});

describe('parseSlackExport — thread grouping', () => {
  it('groups a root and its replies into one thread with the correct replyCount', () => {
    const result = parseSlackExport(makeBundle());

    // Only the C1 thread is a thread; standalone/system messages are not.
    expect(result.threads).toHaveLength(1);
    const thread = result.threads[0];
    expect(thread.slackChannelId).toBe('C1');
    expect(thread.threadTs).toBe('1721040600.000100');
    // 3 members (root + 2 replies) -> replyCount 2.
    expect(thread.replyCount).toBe(2);
  });

  it('derives rootTs as the smallest ts in the group', () => {
    const result = parseSlackExport(makeBundle());
    expect(result.threads[0].rootTs).toBe('1721040600.000100');
  });

  it('derives lastReplyAt as the largest occurredAt in the group', () => {
    const result = parseSlackExport(makeBundle());
    expect(result.threads[0].lastReplyAt).toEqual(tsToDate('1721040800.000300'));
  });

  it('does not create threads for standalone messages', () => {
    const result = parseSlackExport(makeBundle());
    const standalone = result.messages.find((m) => m.ts === '1721050000.000000');
    expect(standalone?.threadTs).toBeNull();
    expect(result.threads.some((t) => t.threadTs === '1721050000.000000')).toBe(false);
  });
});

describe('parseSlackExport — secret detection', () => {
  it('warns on an xoxb- token but still stores the message', () => {
    const result = parseSlackExport(makeBundle());
    const secretMessage = result.messages.find((m) => m.ts === '1721050300.000000');

    expect(secretMessage).toBeDefined();
    expect(secretMessage?.text).toContain('xoxb-');
    expect(result.warnings.some((w) => w.includes('possible secret'))).toBe(true);
  });

  it('does not leak the raw text or the matched secret in the warning', () => {
    const result = parseSlackExport(makeBundle());
    const secretWarning = result.warnings.find((w) => w.includes('possible secret'));

    expect(secretWarning).toBeDefined();
    expect(secretWarning).not.toContain('xoxb-abc-123');
    expect(secretWarning).not.toContain('creds:');
    // Only identifiers are allowed through.
    expect(secretWarning).toContain('1721050300.000000');
  });

  it('flags AKIA and PEM secret patterns', () => {
    const base = makeBundle();
    const akia = parseSlackExport({
      ...base,
      messages: [{ channel: 'C1', ts: '1.0', text: 'AKIAIOSFODNN7EXAMPLE' }],
    });
    const pem = parseSlackExport({
      ...base,
      messages: [{ channel: 'C1', ts: '1.0', text: '-----BEGIN RSA PRIVATE KEY-----' }],
    });

    expect(akia.warnings.some((w) => w.includes('possible secret'))).toBe(true);
    expect(pem.warnings.some((w) => w.includes('possible secret'))).toBe(true);
  });
});

describe('tsToDate', () => {
  it('converts a Slack ts to a Date using the epoch-seconds part only', () => {
    const date = tsToDate('1721040600.000100');
    expect(date.getTime()).toBe(1721040600 * 1000);
  });

  it('maps ts onto occurredAt for normalized messages', () => {
    const result = parseSlackExport(makeBundle());
    const root = result.messages.find((m) => m.ts === '1721040600.000100');
    expect(root?.occurredAt).toEqual(new Date(1721040600 * 1000));
  });
});

describe('compareTs', () => {
  it('compares Slack timestamps numerically, not lexically', () => {
    // Lexically '10' < '2'; numerically 10 > 2.
    expect(compareTs('2', '10')).toBeLessThan(0);
    expect(compareTs('10', '2')).toBeGreaterThan(0);
    expect(compareTs('1721040600.000100', '1721040700.000200')).toBeLessThan(0);
    expect(compareTs('1721040600.000100', '1721040600.000100')).toBe(0);
  });
});

describe('parseSlackExport — empty and invalid input', () => {
  it('accepts an empty export and returns empty collections', () => {
    const result = parseSlackExport({
      workspace: {},
      channels: [],
      users: [],
      messages: [],
    });

    expect(result.workspace).toEqual({ name: null, slackTeamId: null });
    expect(result.channels).toEqual([]);
    expect(result.users).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.threads).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('throws on a non-object bundle', () => {
    expect(() => parseSlackExport(null)).toThrow(/must be a JSON object/);
    expect(() => parseSlackExport('nope')).toThrow(/must be a JSON object/);
    expect(() => parseSlackExport([])).toThrow(/must be a JSON object/);
  });

  it('throws when required top-level fields are missing or wrong-typed', () => {
    expect(() => parseSlackExport({ channels: [], users: [], messages: [] })).toThrow(
      /"workspace" must be an object/,
    );
    expect(() =>
      parseSlackExport({ workspace: {}, channels: {}, users: [], messages: [] }),
    ).toThrow(/"channels" must be an array/);
    expect(() =>
      parseSlackExport({ workspace: {}, channels: [], users: [] }),
    ).toThrow(/"messages" must be an array/);
  });

  it('throws on malformed channel/user/message items and invalid ts', () => {
    expect(() =>
      parseSlackExport({ workspace: {}, channels: [{ id: 'C1' }], users: [], messages: [] }),
    ).toThrow(/channels\[0\]\.name must be a string/);
    expect(() =>
      parseSlackExport({
        workspace: {},
        channels: [{ id: 'C1', name: 'eng' }],
        users: [],
        messages: [{ channel: 'C1', ts: 'not-a-ts' }],
      }),
    ).toThrow(/not a valid Slack timestamp/);
  });
});
