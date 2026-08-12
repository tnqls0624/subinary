/**
 * Slack Export ZIP → 번들 변환 테스트.
 *
 * 변환 결과를 **기존 `parseSlackExport`에 그대로 먹여** 통과하는지까지 본다 —
 * 변환기의 계약은 "번들 모양"이 아니라 "검증된 파서가 받아들이는 입력"이다.
 */
import { describe, expect, it } from 'vitest';

import { convertSlackExportZip, looksLikeZip, SlackZipError } from './export-zip.js';
import { parseSlackExport } from './parse.js';
import { buildNormalSlackExportZip, buildZip } from './zip-fixture.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    return code ?? `unexpected:${(error as Error).message}`;
  }
  return 'no-throw';
}

describe('looksLikeZip — 형식 분기', () => {
  it('ZIP 매직 바이트를 알아본다', () => {
    expect(looksLikeZip(buildNormalSlackExportZip())).toBe(true);
  });

  it('JSON 번들은 ZIP이 아니다 (기존 경로가 깨지면 안 된다)', () => {
    expect(looksLikeZip(Buffer.from('{"workspace":{}}', 'utf8'))).toBe(false);
    expect(looksLikeZip(Buffer.from('   {"a":1}', 'utf8'))).toBe(false);
    expect(looksLikeZip(Buffer.alloc(2))).toBe(false);
  });
});

describe('convertSlackExportZip — 정상 Export', () => {
  const { bundle, stats } = convertSlackExportZip(buildNormalSlackExportZip());

  it('채널을 id/이름으로 옮긴다', () => {
    expect(bundle.channels).toEqual([
      { id: 'C1', name: 'eng-backend' },
      { id: 'C2', name: 'general' },
    ]);
  });

  it('사용자를 옮기고 handle 없는 계정은 id로 채운다', () => {
    expect(bundle.users).toEqual([
      { id: 'U1', name: 'soobeen', real_name: '수빈' },
      { id: 'U2', name: 'alex', real_name: 'Alex' },
      { id: 'UBOT', name: 'notifier' },
    ]);
  });

  it('디렉터리 이름으로 메시지의 채널 id를 채운다 (날짜 파일에는 channel 필드가 없다)', () => {
    expect(bundle.messages.map((m) => m.channel)).toEqual(['C1', 'C1', 'C2']);
  });

  it('edited 객체를 edited_ts 문자열로 편다', () => {
    const edited = bundle.messages.find((m) => m.ts === '1785000060.000200');
    expect(edited?.edited_ts).toBe('1785000090.000000');
  });

  it('스레드 관계를 보존한다', () => {
    const root = bundle.messages.find((m) => m.ts === '1785000000.000100');
    expect(root?.thread_ts).toBe('1785000000.000100');
  });

  it('users.json의 team_id를 워크스페이스에 싣는다', () => {
    expect(bundle.workspace.slackTeamId).toBe('T1');
  });

  it('건너뛴 것을 숨기지 않고 개수로 돌려준다', () => {
    // 멤버십 잡음 1건(channel_join)과 대응 채널 없는 DM 폴더 1개.
    expect(stats.skippedNoiseMessageCount).toBe(1);
    expect(stats.skippedDirectoryCount).toBe(1);
    expect(stats.dayFileCount).toBe(2);
    expect(stats.inflatedBytes).toBeGreaterThan(0);
  });

  it('변환 결과가 기존 parseSlackExport를 그대로 통과한다', () => {
    const parsed = parseSlackExport(bundle);
    expect(parsed.channels).toHaveLength(2);
    expect(parsed.users).toHaveLength(3);
    expect(parsed.messages).toHaveLength(3);
    // eng-backend의 두 건이 한 스레드로 묶인다(root + reply 1).
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].replyCount).toBe(1);
    expect(parsed.messages[0].occurredAt.toISOString()).toBe(
      new Date(1785000000 * 1000).toISOString(),
    );
  });
});

describe('convertSlackExportZip — 최상위 디렉터리로 감싼 Export', () => {
  it('channels.json이 있는 위치를 루트로 삼는다', () => {
    const { bundle, stats } = convertSlackExportZip(
      buildNormalSlackExportZip({ prefix: 'My Team Slack export/' }),
    );
    expect(bundle.channels).toHaveLength(2);
    expect(bundle.messages).toHaveLength(3);
    expect(stats.dayFileCount).toBe(2);
  });
});

describe('convertSlackExportZip — 구조가 없으면 실패한다', () => {
  it('channels.json이 없으면 거부한다', () => {
    const zip = buildZip([{ name: 'users.json', content: '[]' }]);
    expect(codeOf(() => convertSlackExportZip(zip))).toBe('zip_missing_channels');
  });

  it('users.json이 없으면 거부한다', () => {
    const zip = buildZip([{ name: 'channels.json', content: '[]' }]);
    expect(codeOf(() => convertSlackExportZip(zip))).toBe('zip_missing_users');
  });

  it('목록 파일이 배열이 아니면 거부한다', () => {
    const zip = buildZip([
      { name: 'channels.json', content: '{"not":"an array"}' },
      { name: 'users.json', content: '[]' },
    ]);
    expect(codeOf(() => convertSlackExportZip(zip))).toBe(
      'zip_malformed_metadata',
    );
    expect(() => convertSlackExportZip(zip)).toThrowError(SlackZipError);
  });

  it('목록 파일이 JSON이 아니면 거부한다', () => {
    const zip = buildZip([
      { name: 'channels.json', content: 'not json at all' },
      { name: 'users.json', content: '[]' },
    ]);
    expect(codeOf(() => convertSlackExportZip(zip))).toBe(
      'zip_malformed_metadata',
    );
  });

  it('경로 탈출 엔트리가 섞이면 변환 자체가 실패한다', () => {
    const zip = buildZip([
      { name: 'channels.json', content: '[]' },
      { name: 'users.json', content: '[]' },
      { name: '../../etc/passwd', content: 'root:x:0:0' },
    ]);
    expect(codeOf(() => convertSlackExportZip(zip))).toBe('zip_unsafe_entry');
  });
});

describe('convertSlackExportZip — 빈 Export', () => {
  it('메시지가 없어도 성공한다 (빈 import는 실패가 아니다)', () => {
    const zip = buildZip([
      { name: 'channels.json', content: '[]' },
      { name: 'users.json', content: '[]' },
    ]);
    const { bundle, stats } = convertSlackExportZip(zip);
    expect(bundle.messages).toEqual([]);
    expect(stats.dayFileCount).toBe(0);
    expect(() => parseSlackExport(bundle)).not.toThrow();
  });

  it('채널 디렉터리는 있는데 날짜 파일이 없으면 메시지 0건', () => {
    const zip = buildZip([
      { name: 'channels.json', content: JSON.stringify([{ id: 'C1', name: 'x' }]) },
      { name: 'users.json', content: '[]' },
      { name: 'x/README.txt', content: 'not a day file' },
    ]);
    const { bundle } = convertSlackExportZip(zip);
    expect(bundle.messages).toEqual([]);
  });
});

describe('convertSlackExportZip — 비공개 채널(groups.json) 병합', () => {
  it('groups.json의 채널도 함께 읽는다', () => {
    const zip = buildZip([
      { name: 'channels.json', content: JSON.stringify([{ id: 'C1', name: 'pub' }]) },
      { name: 'groups.json', content: JSON.stringify([{ id: 'G1', name: 'sec' }]) },
      { name: 'users.json', content: '[]' },
      {
        name: 'sec/2026-08-01.json',
        content: JSON.stringify([
          { type: 'message', user: 'U1', text: '비공개', ts: '1785000000.000100' },
        ]),
      },
    ]);
    const { bundle } = convertSlackExportZip(zip);
    expect(bundle.channels).toEqual([
      { id: 'C1', name: 'pub' },
      { id: 'G1', name: 'sec' },
    ]);
    expect(bundle.messages).toEqual([
      { channel: 'G1', ts: '1785000000.000100', user: 'U1', text: '비공개' },
    ]);
  });
});
