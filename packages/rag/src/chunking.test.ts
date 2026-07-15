import { describe, expect, it } from 'vitest';

import {
  buildThreadChunkText,
  chunkSlackThreads,
  type ThreadInput,
  type ThreadMessageInput,
} from './chunking.js';

function msg(
  authorName: string,
  text: string,
  ts: string,
  occurredAt: Date,
): ThreadMessageInput {
  return { authorName, text, ts, occurredAt };
}

describe('buildThreadChunkText', () => {
  it('joins messages ts-ascending as "작성자: 내용" on newlines', () => {
    // Deliberately out of ts order to prove the function sorts.
    const out = buildThreadChunkText([
      msg('B', 'first reply', '1721040700.000200', new Date('2026-07-15T09:11:40+09:00')),
      msg('A', 'root message', '1721040600.000100', new Date('2026-07-15T09:10:00+09:00')),
      msg('A', 'second reply', '1721040800.000300', new Date('2026-07-15T09:13:20+09:00')),
    ]);

    expect(out).toBe('A: root message\nB: first reply\nA: second reply');
  });

  it('skips empty and whitespace-only messages', () => {
    const out = buildThreadChunkText([
      msg('A', 'kept', '1', new Date('2026-07-15T00:00:00+09:00')),
      msg('B', '', '2', new Date('2026-07-15T00:00:01+09:00')),
      msg('C', '   \n\t ', '3', new Date('2026-07-15T00:00:02+09:00')),
      msg('D', 'also kept', '4', new Date('2026-07-15T00:00:03+09:00')),
    ]);

    expect(out).toBe('A: kept\nD: also kept');
  });

  it('returns an empty string when every message is empty', () => {
    const out = buildThreadChunkText([
      msg('A', '', '1', new Date('2026-07-15T00:00:00+09:00')),
      msg('B', '  ', '2', new Date('2026-07-15T00:00:01+09:00')),
    ]);

    expect(out).toBe('');
  });

  it('does not mutate the input array order', () => {
    const input = [
      msg('B', 'b', '2', new Date('2026-07-15T00:00:01+09:00')),
      msg('A', 'a', '1', new Date('2026-07-15T00:00:00+09:00')),
    ];
    buildThreadChunkText(input);

    expect(input.map((m) => m.authorName)).toEqual(['B', 'A']);
  });
});

describe('chunkSlackThreads', () => {
  it('produces one slack_thread chunk per thread with root occurredAt', () => {
    const rootAt = new Date('2026-07-15T09:10:00+09:00');
    const thread: ThreadInput = {
      threadTs: '1721040600.000100',
      channelName: 'eng-backend',
      slackChannelId: 'chan-uuid-1',
      messages: [
        // Latest reply first to prove root resolution is not order-dependent.
        msg('A', 'second reply', '1721040800.000300', new Date('2026-07-15T09:13:20+09:00')),
        msg('A', 'root message', '1721040600.000100', rootAt),
        msg('B', 'first reply', '1721040700.000200', new Date('2026-07-15T09:11:40+09:00')),
      ],
    };

    const [chunk, ...rest] = chunkSlackThreads([thread]);

    expect(rest).toHaveLength(0);
    expect(chunk.sourceType).toBe('slack_thread');
    expect(chunk.sourceRefId).toBe('1721040600.000100');
    expect(chunk.slackChannelId).toBe('chan-uuid-1');
    expect(chunk.channelName).toBe('eng-backend');
    expect(chunk.text).toBe('A: root message\nB: first reply\nA: second reply');
    // occurredAt is the thread root's occurredAt (root = ts === threadTs).
    expect(chunk.occurredAt.getTime()).toBe(rootAt.getTime());
  });

  it('falls back to the earliest message when no ts equals threadTs', () => {
    const earliestAt = new Date('2026-07-15T09:00:00+09:00');
    const thread: ThreadInput = {
      threadTs: 'not-present.000000',
      channelName: 'general',
      slackChannelId: 'chan-uuid-2',
      messages: [
        msg('A', 'later', '200.000000', new Date('2026-07-15T09:05:00+09:00')),
        msg('B', 'earliest', '100.000000', earliestAt),
      ],
    };

    const [chunk] = chunkSlackThreads([thread]);

    expect(chunk.occurredAt.getTime()).toBe(earliestAt.getTime());
    expect(chunk.text).toBe('B: earliest\nA: later');
  });

  it('skips threads whose combined text is empty', () => {
    const drafts = chunkSlackThreads([
      {
        threadTs: '1.0',
        channelName: 'general',
        slackChannelId: 'chan-uuid-3',
        messages: [
          msg('A', '', '1.0', new Date('2026-07-15T00:00:00+09:00')),
          msg('B', '   ', '2.0', new Date('2026-07-15T00:00:01+09:00')),
        ],
      },
      {
        threadTs: '10.0',
        channelName: 'general',
        slackChannelId: 'chan-uuid-3',
        messages: [msg('A', 'kept', '10.0', new Date('2026-07-15T00:01:00+09:00'))],
      },
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].sourceRefId).toBe('10.0');
  });

  it('returns an empty array for empty input', () => {
    expect(chunkSlackThreads([])).toEqual([]);
  });
});
