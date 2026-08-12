/**
 * 테스트용 ZIP 조립기.
 *
 * 공격 아카이브(경로 탈출·zip bomb·심볼릭 링크·암호화 플래그)는 정상 도구로 만들 수
 * 없다 — 그래서 바이트를 직접 쓴다. 방어 테스트의 입력을 손으로 만들 수 있어야
 * "막았다"를 증명할 수 있다.
 *
 * 프로덕션 경로에서는 쓰지 않는다(테스트 전용이지만, `src` 밖에 두면 vitest의
 * `include: src/**` 관습과 tsconfig rootDir에서 벗어나 빌드가 꼬인다).
 */
import { deflateRawSync } from 'node:zlib';

import { crc32 } from './zip.js';

/** 조립할 엔트리 1건. */
export interface FixtureEntry {
  name: string;
  /** 파일 내용. 디렉터리 엔트리는 비운다. */
  content?: Buffer | string;
  /** 압축 없이 저장할지(기본 deflate). */
  stored?: boolean;
  /** general purpose flag 덮어쓰기(암호화 플래그 시험용). */
  flags?: number;
  /** version-made-by 상위 바이트(3 = Unix). 심볼릭 링크 시험에 쓴다. */
  hostSystem?: number;
  /** external attributes 상위 16비트에 들어갈 Unix mode. */
  unixMode?: number;
  /** central directory의 "해제 후 크기"를 거짓으로 선언한다(선검사 우회 시험). */
  lieUncompressedSize?: number;
  /** central directory의 "압축 크기"를 거짓으로 선언한다. */
  lieCompressedSize?: number;
}

interface Built {
  name: string;
  data: Buffer;
  crc: number;
  method: number;
  declaredCompressed: number;
  declaredUncompressed: number;
  flags: number;
  hostSystem: number;
  unixMode: number;
  isDirectory: boolean;
  localOffset: number;
}

/** {@link FixtureEntry} 목록을 실제 ZIP 바이트로 만든다. */
export function buildZip(entries: readonly FixtureEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const built: Built[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDirectory = entry.content === undefined;
    const raw = isDirectory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(String(entry.content), 'utf8');
    const stored = entry.stored === true || isDirectory;
    const data = stored ? raw : deflateRawSync(raw, { level: 9 });
    const nameBuf = Buffer.from(
      isDirectory ? `${entry.name}/` : entry.name,
      'utf8',
    );

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    built.push({
      name: nameBuf.toString('utf8'),
      data,
      crc: crc32(raw),
      method: stored ? 0 : 8,
      declaredCompressed: entry.lieCompressedSize ?? data.length,
      declaredUncompressed: entry.lieUncompressedSize ?? raw.length,
      flags: entry.flags ?? 0,
      hostSystem: entry.hostSystem ?? 0,
      unixMode: entry.unixMode ?? 0,
      isDirectory,
      localOffset: offset,
    });

    chunks.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  for (const item of built) {
    const nameBuf = Buffer.from(item.name, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((item.hostSystem << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.flags, 8);
    central.writeUInt16LE(item.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(item.crc, 16);
    central.writeUInt32LE(item.declaredCompressed, 20);
    central.writeUInt32LE(item.declaredUncompressed, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((item.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(item.localOffset, 42);
    chunks.push(central, nameBuf);
    offset += central.length + nameBuf.length;
  }
  const centralSize = offset - centralStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(built.length, 8);
  eocd.writeUInt16LE(built.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/**
 * 정상적인 최소 Slack Export ZIP.
 * 방어 테스트가 "정상은 통과한다"를 함께 증명하기 위한 기준 아카이브다.
 */
export function buildNormalSlackExportZip(
  options: { prefix?: string } = {},
): Buffer {
  const prefix = options.prefix ?? '';
  return buildZip([
    {
      name: `${prefix}channels.json`,
      content: JSON.stringify([
        { id: 'C1', name: 'eng-backend', is_archived: false },
        { id: 'C2', name: 'general', is_archived: false },
      ]),
    },
    {
      name: `${prefix}users.json`,
      content: JSON.stringify([
        {
          id: 'U1',
          team_id: 'T1',
          name: 'soobeen',
          real_name: '수빈',
          profile: { real_name: '수빈' },
        },
        { id: 'U2', team_id: 'T1', name: 'alex', profile: { real_name: 'Alex' } },
        // handle 없는 계정 — id로 대체돼야 한다.
        { id: 'UBOT', team_id: 'T1', profile: { display_name: 'notifier' } },
      ]),
    },
    {
      name: `${prefix}eng-backend/2026-08-01.json`,
      content: JSON.stringify([
        {
          type: 'message',
          user: 'U1',
          text: '배포 스레드 시작합니다',
          ts: '1785000000.000100',
          thread_ts: '1785000000.000100',
        },
        {
          type: 'message',
          user: 'U2',
          text: '확인했습니다',
          ts: '1785000060.000200',
          thread_ts: '1785000000.000100',
          edited: { user: 'U2', ts: '1785000090.000000' },
        },
        { type: 'message', subtype: 'channel_join', user: 'U2', text: 'joined', ts: '1785000100.000300' },
      ]),
    },
    {
      name: `${prefix}general/2026-08-02.json`,
      content: JSON.stringify([
        { type: 'message', user: 'U1', text: '점심 뭐 먹을까요', ts: '1785100000.000100' },
      ]),
    },
    // 대응 채널이 없는 DM 폴더 — 건너뛰되 개수로 보고돼야 한다.
    {
      name: `${prefix}D0ABCDEF/2026-08-02.json`,
      content: JSON.stringify([
        { type: 'message', user: 'U1', text: 'private dm', ts: '1785100500.000100' },
      ]),
    },
  ]);
}
