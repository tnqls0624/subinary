/**
 * ZIP 신뢰 경계 테스트.
 *
 * 이 파일이 이 작업의 **핵심 증거**다. "막았다"는 주장은 공격 아카이브를 실제로 만들어
 * 거절되는 것을 보여야 성립한다. 그리고 **정상 Export가 통과하는 것**을 같은 파일에서
 * 함께 증명한다 — 정상 사용자를 막는 방어는 실패다.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';

import { buildNormalSlackExportZip, buildZip } from './zip-fixture.js';
import {
  DEFAULT_ZIP_LIMITS,
  ZipError,
  ZipReader,
  assertSafeEntryName,
  readZipDirectory,
  type ZipLimits,
} from './zip.js';

/** 테스트용 좁은 상한 — 실제 상한으로 폭탄을 만들면 테스트가 느려진다. */
const tight: ZipLimits = {
  maxEntries: 5,
  maxEntryBytes: 4096,
  maxTotalBytes: 8192,
  maxEntryRatio: 20,
  ratioFloorBytes: 16,
};

/** 던져진 오류의 `code`를 꺼낸다(assert 실패 메시지를 읽을 수 있게). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof ZipError) return error.code;
    return `unexpected:${(error as Error).name}: ${(error as Error).message}`;
  }
  return 'no-throw';
}

describe('assertSafeEntryName — zip-slip', () => {
  it.each([
    ['상위 디렉터리 탈출', '../etc/passwd'],
    ['중간 세그먼트 탈출', 'channels/../../etc/passwd'],
    ['깊은 탈출', 'a/b/../../../../tmp/x'],
    ['절대경로', '/etc/passwd'],
    ['드라이브 문자', 'C:/Windows/system32'],
    ['역슬래시 구분자', 'a\\..\\..\\b'],
    ['NUL 삽입', 'a\u0000.json'],
    ['빈 이름', ''],
  ])('%s 는 거부한다: %j', (_label, name) => {
    expect(() => assertSafeEntryName(name)).toThrowError(ZipError);
    expect(codeOf(() => assertSafeEntryName(name))).toBe('zip_unsafe_entry');
  });

  it.each([
    'channels.json',
    'users.json',
    'eng-backend/2026-08-01.json',
    'My Export/general/2026-08-02.json',
    // 점이 들어간 정상 이름은 막지 않는다 — `..` 세그먼트만 문제다.
    'a..b/c.json',
    'release-2.0/2026-08-02.json',
  ])('정상 이름은 통과한다: %j', (name) => {
    expect(assertSafeEntryName(name)).toBe(name);
  });
});

describe('readZipDirectory — 아카이브 단위 거부', () => {
  it('경로 탈출 엔트리가 하나라도 있으면 아카이브 전체를 실패시킨다', () => {
    // 나머지가 전부 정상이어도 통과시키지 않는다 — 일부만 처리하면 사용자는
    // 전부 들어온 줄 안다.
    const zip = buildZip([
      { name: 'channels.json', content: '[]' },
      { name: '../escape.json', content: '[]' },
      { name: 'users.json', content: '[]' },
    ]);
    expect(codeOf(() => readZipDirectory(zip, tight))).toBe('zip_unsafe_entry');
  });

  it('심볼릭 링크 엔트리를 거부한다', () => {
    const zip = buildZip([
      { name: 'channels.json', content: '[]' },
      {
        name: 'link',
        content: '/etc/passwd',
        hostSystem: 3,
        unixMode: 0xa1ff, // S_IFLNK | 0777
      },
    ]);
    expect(codeOf(() => readZipDirectory(zip, tight))).toBe('zip_unsafe_entry');
  });

  it('암호화 플래그가 켜진 아카이브를 거부한다', () => {
    const zip = buildZip([
      { name: 'channels.json', content: '[]', flags: 0x0001 },
    ]);
    expect(codeOf(() => readZipDirectory(zip, tight))).toBe('zip_encrypted');
  });

  it('엔트리 개수 상한을 넘으면 거부한다', () => {
    const zip = buildZip(
      Array.from({ length: tight.maxEntries + 1 }, (_, i) => ({
        name: `f${i}.json`,
        content: '[]',
      })),
    );
    expect(codeOf(() => readZipDirectory(zip, tight))).toBe(
      'zip_too_many_entries',
    );
  });

  it('엔트리 개별 크기 상한을 넘으면 거부한다', () => {
    const zip = buildZip([
      { name: 'big.json', content: Buffer.alloc(tight.maxEntryBytes + 1, 0x61) },
    ]);
    expect(codeOf(() => readZipDirectory(zip, tight))).toBe(
      'zip_entry_too_large',
    );
  });

  it('해제 후 총 크기 상한을 넘으면 거부한다', () => {
    // 개별로는 상한 안쪽이지만 합치면 넘는다. stored로 넣어 압축비 검사가 먼저
    // 걸리지 않게 한다 — 여기서 보려는 건 누적 크기 판정이다.
    const each = Buffer.alloc(tight.maxEntryBytes - 1, 0x62);
    const zip = buildZip([
      { name: 'a.json', content: each, stored: true },
      { name: 'b.json', content: each, stored: true },
      { name: 'c.json', content: each, stored: true },
    ]);
    expect(codeOf(() => readZipDirectory(zip, tight))).toBe(
      'zip_total_too_large',
    );
  });

  it('선언 압축비가 상한을 넘으면 풀기 전에 거부한다', () => {
    // 0으로 가득 찬 버퍼는 실제로도 극단적으로 압축된다(진짜 폭탄 모양).
    const bomb = Buffer.alloc(4000, 0);
    const zip = buildZip([{ name: 'bomb.json', content: bomb }]);
    expect(codeOf(() => readZipDirectory(zip, tight))).toBe(
      'zip_ratio_exceeded',
    );
  });

  it('작은 파일은 압축비로 막지 않는다 (정상 사용자 보호)', () => {
    // 16바이트 미만 압축본은 헤더 오버헤드 때문에 비율이 의미 없다.
    const zip = buildZip([{ name: 'tiny.json', content: Buffer.alloc(200, 0) }]);
    expect(() => readZipDirectory(zip, tight)).not.toThrow();
  });

  it('ZIP이 아니면 명확히 거부한다', () => {
    expect(codeOf(() => readZipDirectory(Buffer.from('{"a":1}'), tight))).toBe(
      'zip_invalid',
    );
    expect(codeOf(() => readZipDirectory(Buffer.alloc(3), tight))).toBe(
      'zip_invalid',
    );
  });

  it('디렉터리 엔트리는 파일 목록에 넣지 않는다', () => {
    const zip = buildZip([
      { name: 'eng-backend' }, // 디렉터리
      { name: 'eng-backend/2026-08-01.json', content: '[]' },
    ]);
    const directory = readZipDirectory(zip, tight);
    expect(directory.entries.map((e) => e.name)).toEqual([
      'eng-backend/2026-08-01.json',
    ]);
  });
});

describe('ZipReader.inflate — 선언값을 믿지 않는 실제 상한', () => {
  it('선언 크기를 거짓으로 줄인 폭탄도 해제 도중에 멈춘다', () => {
    // central directory는 "10 바이트"라고 말하지만 실제로는 상한을 넘게 부푼다.
    // 선검사만 있으면 이 아카이브는 통과한다 — inflate 중 하드 캡이 유일한 방어다.
    const payload = Buffer.alloc(tight.maxEntryBytes * 4, 0);
    const zip = buildZip([
      {
        name: 'lying.json',
        content: payload,
        lieUncompressedSize: 10,
        lieCompressedSize: deflateRawSync(payload, { level: 9 }).length,
      },
    ]);
    const directory = readZipDirectory(zip, tight); // 선검사는 통과한다(거짓말 때문에)
    expect(directory.entries).toHaveLength(1);

    const reader = new ZipReader(zip, tight);
    const code = codeOf(() => reader.inflate(directory.entries[0]));
    expect(['zip_entry_too_large', 'zip_total_too_large']).toContain(code);
  });

  it('총 예산은 엔트리를 가로질러 누적된다', () => {
    const chunk = Buffer.alloc(3000, 0x63); // 랜덤성 없는 텍스트지만 비율은 상한 안쪽
    const zip = buildZip([
      { name: 'a.json', content: chunk, stored: true },
      { name: 'b.json', content: chunk, stored: true },
      { name: 'c.json', content: chunk, stored: true },
    ]);
    const directory = readZipDirectory(zip, {
      ...tight,
      maxTotalBytes: 1_000_000, // 선검사는 통과시키고 런타임 예산만 좁힌다
    });
    const reader = new ZipReader(zip, { ...tight, maxTotalBytes: 7000 });
    expect(reader.inflate(directory.entries[0])).toHaveLength(3000);
    expect(reader.inflate(directory.entries[1])).toHaveLength(3000);
    expect(codeOf(() => reader.inflate(directory.entries[2]))).toBe(
      'zip_total_too_large',
    );
  });

  it('CRC가 맞지 않으면 손상으로 본다', () => {
    const zip = buildZip([{ name: 'a.json', content: 'hello', stored: true }]);
    // stored 엔트리의 데이터 1바이트를 뒤집는다 → CRC 불일치.
    const directory = readZipDirectory(zip, tight);
    const dataOffset =
      directory.entries[0].localHeaderOffset + 30 + 'a.json'.length;
    zip[dataOffset] ^= 0xff;
    const reader = new ZipReader(zip, tight);
    expect(codeOf(() => reader.inflate(directory.entries[0]))).toBe(
      'zip_invalid',
    );
  });

  it('정상 엔트리는 그대로 돌려준다', () => {
    const zip = buildZip([{ name: 'a.json', content: '{"ok":true}' }]);
    const directory = readZipDirectory(zip, tight);
    const reader = new ZipReader(zip, tight);
    expect(reader.inflate(directory.entries[0]).toString('utf8')).toBe(
      '{"ok":true}',
    );
    expect(reader.inflatedBytes).toBe(11);
  });
});

describe('기본 상한 — 정상 Slack Export는 통과한다', () => {
  it('실제 상한(DEFAULT_ZIP_LIMITS)으로 정상 Export를 읽는다', () => {
    const zip = buildNormalSlackExportZip();
    const directory = readZipDirectory(zip, DEFAULT_ZIP_LIMITS);
    expect(directory.entries.length).toBeGreaterThan(0);
    const reader = new ZipReader(zip, DEFAULT_ZIP_LIMITS);
    for (const entry of directory.entries) {
      expect(() => reader.inflate(entry)).not.toThrow();
    }
  });

  it('기본 상한이 문서화된 값에서 조용히 바뀌지 않는다', () => {
    // 이 값들이 바뀌면 리포트·ADR의 근거도 함께 고쳐야 한다.
    expect(DEFAULT_ZIP_LIMITS).toEqual({
      maxEntries: 20_000,
      maxEntryBytes: 32 * 1024 * 1024,
      maxTotalBytes: 128 * 1024 * 1024,
      maxEntryRatio: 200,
      ratioFloorBytes: 4 * 1024,
    });
  });
});
