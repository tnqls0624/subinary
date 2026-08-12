/**
 * 최소·강경(hardened) ZIP 리더 — Slack Export ZIP 수용을 위한 신뢰 경계.
 *
 * ## 왜 라이브러리를 쓰지 않는가
 *
 * 업로드 ZIP은 **사용자가 준 것이고 악의적일 수 있다.** 여기서 필요한 방어는
 * "풀 수 있는가"가 아니라 **"부풀기 전에 멈출 수 있는가"**다. 대부분의 zip 라이브러리는
 * 압축 해제 도중 출력 상한을 걸 지점을 노출하지 않아, bomb을 막으려면 결국 라이브러리
 * 밖에서 감시해야 한다. Node 내장 `zlib.inflateRawSync({ maxOutputLength })`는 그 상한을
 * **inflate 루프 안에서** 강제하므로 이 파일은 그 위에 얇게 얹는다. 새 의존성(=락파일
 * 변경)도 만들지 않는다.
 *
 * ## 두 겹 방어
 *
 * 1) **central directory 선검사(무압축·저비용)** — 엔트리 이름·개수·선언된 크기·선언된
 *    압축비를 먼저 본다. 여기서 걸리면 CPU를 한 바이트도 쓰지 않고 거절한다.
 * 2) **inflate 중 실제 상한** — 선언 크기는 **공격자가 쓴 값**이라 믿을 수 없다. 실제
 *    출력 바이트에 `maxOutputLength`로 하드 캡을 걸고, 총 예산에서 차감한다.
 *
 * 1만 하면 거짓말한 헤더에 뚫리고, 2만 하면 뚫리진 않지만 매번 CPU를 쓴다. 둘 다 한다.
 *
 * ## 명시적으로 거절하는 것
 *
 * - 경로 탈출(zip-slip): `..` 세그먼트·절대경로·드라이브 문자·역슬래시·NUL
 * - 심볼릭 링크 엔트리(Unix mode `S_IFLNK`)
 * - 암호화 엔트리(general purpose bit 0/6)
 * - deflate/stored 이외의 압축 방식
 * - Zip64 · 멀티디스크(우리 상한은 Zip64 영역 한참 아래라 지원할 이유가 없다)
 *
 * **거절은 조용히 건너뛰지 않고 전체를 실패시킨다.** 일부만 처리하면 사용자는 전부
 * 들어온 줄 안다.
 *
 * 로깅 규약: 이 모듈이 만드는 오류 메시지에는 엔트리 **이름·내용을 넣지 않는다**.
 * 코드와 숫자만 남긴다(원문·PII 비노출).
 */
import { inflateRawSync } from 'node:zlib';

/* -------------------------------------------------------------------------- */
/* 상한값                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * ZIP 처리 상한. **전부 `[가설]`이다** — 저장소에 운영 Slack Export 크기 분포가 없다
 * (PO 판정 Q3의 "모름"). 아래는 형식 구조에서 유도한 값이고, 실제 사용자가 막히면
 * 이 상수를 근거와 함께 올려야 한다.
 */
export interface ZipLimits {
  /** 엔트리 개수 상한. */
  maxEntries: number;
  /** 엔트리 1개의 해제 후 크기 상한(bytes). */
  maxEntryBytes: number;
  /** 아카이브 전체의 해제 후 누적 크기 상한(bytes). */
  maxTotalBytes: number;
  /**
   * 엔트리 1개의 압축비 상한(해제 후 ÷ 압축). 텍스트 JSON은 보통 5~20배다.
   * 200배를 넘는 것은 정상 Export가 아니라 폭탄이다.
   */
  maxEntryRatio: number;
  /**
   * 압축비를 따지기 시작하는 최소 압축 크기(bytes). 수십 바이트짜리 파일은
   * 헤더 오버헤드 때문에 비율이 의미 없다 — 정상 파일을 막지 않기 위한 하한이다.
   */
  ratioFloorBytes: number;
}

/**
 * 기본 상한.
 *
 * - `maxEntries` 20,000: Slack Export는 `channels.json`·`users.json` +
 *   **채널당 활동한 날짜마다 파일 1개**다. 20,000이면 55채널 × 365일, 또는
 *   20채널 × 2.7년에 해당한다. 이 앱 규모(개인·가족)에는 넉넉하다. `[가설]`
 * - `maxEntryBytes` 32MiB: 단일 파일 중 가장 큰 것은 `users.json`이고 대형
 *   워크스페이스도 한 자릿수 MB다. 하루치 채널 파일은 KB 단위다. `[가설]`
 * - `maxTotalBytes` 128MiB: **워커 메모리 예산**이다. 해제 텍스트를 JSON.parse하면
 *   JS 객체가 2~5배로 부푸므로, 128MiB 텍스트 ≈ 최대 수백 MB 힙이다. 이 값을 올리려면
 *   워커 컨테이너 메모리를 함께 재검토해야 한다. `[가설]`
 * - `maxEntryRatio` 200 / `ratioFloorBytes` 4KiB: 위 설명 참조.
 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntryRatio: 200,
  ratioFloorBytes: 4 * 1024,
};

/* -------------------------------------------------------------------------- */
/* 오류                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 안전한 실패 코드. **사용자에게 그대로 저장·노출되는 값이므로 원문·경로·PII를 담지
 * 않는다.** 화면 문구는 이 코드로 갈라 쓴다.
 */
export type ZipErrorCode =
  /** ZIP 구조가 아니거나 손상됨(EOCD 없음, 헤더 불일치, CRC 불일치). */
  | 'zip_invalid'
  /** 엔트리 이름이 아카이브 루트를 벗어남(zip-slip) 또는 심볼릭 링크. */
  | 'zip_unsafe_entry'
  /** 엔트리 개수 상한 초과. */
  | 'zip_too_many_entries'
  /** 엔트리 1개의 해제 후 크기 상한 초과. */
  | 'zip_entry_too_large'
  /** 해제 후 누적 크기 상한 초과. */
  | 'zip_total_too_large'
  /** 압축비 상한 초과(zip bomb). */
  | 'zip_ratio_exceeded'
  /** 암호화된 아카이브 — 우리는 열 수 없다. */
  | 'zip_encrypted'
  /** Zip64·멀티디스크·미지원 압축 방식. */
  | 'zip_unsupported';

/** ZIP 처리 실패. `code`만 저장·노출하고 `message`는 개발자 로그용이다. */
export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* 시그니처 / 상수                                                             */
/* -------------------------------------------------------------------------- */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const EOCD_MIN_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

/** 32비트 sentinel — 이 값이 보이면 Zip64다. */
const ZIP64_U32 = 0xffffffff;
const ZIP64_U16 = 0xffff;

/** general purpose bit flags. */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Unix `S_IFMT` 마스크와 `S_IFLNK`(심볼릭 링크). external attrs 상위 16비트에 있다. */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
/** version-made-by 상위 바이트가 3이면 Unix 호스트 → external attrs가 mode다. */
const HOST_UNIX = 3;

/* -------------------------------------------------------------------------- */
/* 엔트리                                                                      */
/* -------------------------------------------------------------------------- */

/** central directory에서 읽은 파일 엔트리 1건(디렉터리 엔트리는 제외된다). */
export interface ZipEntry {
  /** 정규화된 엔트리 경로(슬래시 구분, 루트 상대). */
  name: string;
  /** 압축 방식(0=stored, 8=deflate). */
  method: number;
  /** central directory가 **선언한** 압축 크기. 신뢰하지 않고 참고만 한다. */
  compressedSize: number;
  /** central directory가 **선언한** 해제 후 크기. 신뢰하지 않고 참고만 한다. */
  uncompressedSize: number;
  /** 선언된 CRC-32(해제 후 검증에 쓴다). */
  crc32: number;
  /** local file header의 아카이브 내 offset. */
  localHeaderOffset: number;
}

/** 아카이브 선검사 결과. */
export interface ZipDirectory {
  entries: ZipEntry[];
  /** 선언된 해제 후 크기의 합(참고값). */
  declaredTotalBytes: number;
}

/* -------------------------------------------------------------------------- */
/* 엔트리 이름 안전성 (zip-slip)                                               */
/* -------------------------------------------------------------------------- */

/**
 * 엔트리 이름을 정규화하고 루트를 벗어나면 던진다.
 *
 * 우리는 디스크에 풀지 않으므로 직접적인 덮어쓰기 위험은 없다. 그래도 거절하는 이유:
 * **엔트리 이름을 경로로 쓰는 코드가 나중에 하나라도 생기면 그 순간 취약점이 된다.**
 * 이름을 신뢰하지 않는다는 계약을 리더 안에 두면 그 실수가 불가능해진다.
 *
 * 역슬래시를 구분자로 되돌리지 않고 **거절**하는 이유: `a\..\..\b` 같은 이름이 OS마다
 * 다르게 해석돼, 검사기와 사용처의 해석이 갈리는 순간이 정확히 zip-slip이 뚫리는 지점이다.
 */
export function assertSafeEntryName(name: string): string {
  if (name === '') {
    throw new ZipError('zip_unsafe_entry', 'entry name is empty');
  }
  if (name.includes('\u0000')) {
    throw new ZipError('zip_unsafe_entry', 'entry name contains NUL');
  }
  if (name.includes('\\')) {
    throw new ZipError('zip_unsafe_entry', 'entry name contains a backslash');
  }
  if (name.startsWith('/')) {
    throw new ZipError('zip_unsafe_entry', 'entry name is absolute');
  }
  // `C:/...` 같은 드라이브 지정.
  if (/^[a-zA-Z]:/.test(name)) {
    throw new ZipError('zip_unsafe_entry', 'entry name has a drive letter');
  }
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new ZipError('zip_unsafe_entry', 'entry name escapes the archive root');
    }
  }
  return name;
}

/* -------------------------------------------------------------------------- */
/* central directory 읽기 (선검사)                                             */
/* -------------------------------------------------------------------------- */

/** EOCD를 뒤에서부터 찾는다. 주석이 붙어 있을 수 있어 최대 64KiB를 훑는다. */
function findEocdOffset(buf: Buffer): number {
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - (EOCD_MIN_SIZE + maxComment));
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return i;
    }
  }
  throw new ZipError('zip_invalid', 'end of central directory not found');
}

/**
 * central directory를 읽고 **압축을 풀지 않은 채** 구조·상한을 검사한다.
 *
 * API가 업로드 즉시 이걸 돌려 명백한 폭탄·경로 탈출을 400으로 되돌려 준다 — 비동기
 * 실패로 미루면 사용자는 왜 실패했는지 한참 뒤에야 알게 된다.
 */
export function readZipDirectory(
  buf: Buffer,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ZipDirectory {
  if (buf.length < EOCD_MIN_SIZE) {
    throw new ZipError('zip_invalid', 'file is too small to be a zip archive');
  }

  const eocd = findEocdOffset(buf);

  // Zip64 locator가 EOCD 바로 앞에 있으면 Zip64 아카이브다.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR) {
    throw new ZipError('zip_unsupported', 'zip64 archives are not supported');
  }

  const diskNumber = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  if (diskNumber !== 0 || cdDisk !== 0) {
    throw new ZipError('zip_unsupported', 'multi-disk archives are not supported');
  }

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (
    totalEntries === ZIP64_U16 ||
    cdSize === ZIP64_U32 ||
    cdOffset === ZIP64_U32
  ) {
    throw new ZipError('zip_unsupported', 'zip64 archives are not supported');
  }
  if (totalEntries > limits.maxEntries) {
    throw new ZipError(
      'zip_too_many_entries',
      `archive declares ${totalEntries} entries (max ${limits.maxEntries})`,
    );
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipError('zip_invalid', 'central directory is out of bounds');
  }

  const entries: ZipEntry[] = [];
  let declaredTotalBytes = 0;
  let cursor = cdOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > buf.length) {
      throw new ZipError('zip_invalid', 'truncated central directory');
    }
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new ZipError('zip_invalid', 'bad central directory signature');
    }

    const versionMadeBy = buf.readUInt16LE(cursor + 4);
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const crc32 = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const externalAttrs = buf.readUInt32LE(cursor + 38);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    const nameStart = cursor + CENTRAL_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buf.length) {
      throw new ZipError('zip_invalid', 'truncated entry name');
    }
    const rawName = buf.subarray(nameStart, nameEnd).toString('utf8');

    if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) {
      throw new ZipError('zip_encrypted', 'archive contains encrypted entries');
    }
    if (
      compressedSize === ZIP64_U32 ||
      uncompressedSize === ZIP64_U32 ||
      localHeaderOffset === ZIP64_U32
    ) {
      throw new ZipError('zip_unsupported', 'zip64 entry sizes are not supported');
    }

    const isDirectory = rawName.endsWith('/');
    // 이름 검사는 디렉터리 엔트리에도 적용한다 — 나중에 이름을 경로로 쓰는 코드가
    // 파일/디렉터리를 가리지 않을 것이기 때문이다.
    const name = assertSafeEntryName(isDirectory ? rawName.slice(0, -1) : rawName);

    if ((versionMadeBy >> 8) === HOST_UNIX) {
      const mode = (externalAttrs >>> 16) & 0xffff;
      if ((mode & S_IFMT) === S_IFLNK) {
        throw new ZipError('zip_unsafe_entry', 'archive contains a symbolic link');
      }
    }

    if (!isDirectory) {
      if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
        throw new ZipError(
          'zip_unsupported',
          `unsupported compression method ${method}`,
        );
      }
      if (uncompressedSize > limits.maxEntryBytes) {
        throw new ZipError(
          'zip_entry_too_large',
          `entry declares ${uncompressedSize} bytes (max ${limits.maxEntryBytes})`,
        );
      }
      // 선언 압축비 선검사. 실제 강제는 inflate 중에 다시 한다(선언값은 못 믿는다).
      if (
        compressedSize >= limits.ratioFloorBytes &&
        uncompressedSize > compressedSize * limits.maxEntryRatio
      ) {
        throw new ZipError(
          'zip_ratio_exceeded',
          `entry declares a ${Math.round(uncompressedSize / compressedSize)}x ratio`,
        );
      }
      declaredTotalBytes += uncompressedSize;
      if (declaredTotalBytes > limits.maxTotalBytes) {
        throw new ZipError(
          'zip_total_too_large',
          `archive declares more than ${limits.maxTotalBytes} uncompressed bytes`,
        );
      }
      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        crc32,
        localHeaderOffset,
      });
    }

    cursor = nameEnd + extraLength + commentLength;
  }

  if (entries.length > limits.maxEntries) {
    throw new ZipError(
      'zip_too_many_entries',
      `archive holds ${entries.length} file entries (max ${limits.maxEntries})`,
    );
  }

  return { entries, declaredTotalBytes };
}

/* -------------------------------------------------------------------------- */
/* CRC-32                                                                      */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/** 표준 CRC-32(ZIP). 해제 결과의 무결성 확인에 쓴다. */
export function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* 엔트리 해제                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 남은 총 예산을 들고 다니는 해제기.
 *
 * 엔트리를 **하나씩** 풀어 쓰고 버리게 만든 이유: 아카이브 전체를 한 덩어리로 합치면
 * 그 순간이 zip-bomb의 표적이다. 호출부는 파일 하나를 풀고 → JSON으로 바꾸고 →
 * 텍스트를 버리는 식으로 진행할 수 있다.
 */
export class ZipReader {
  private remainingTotal: number;

  constructor(
    private readonly buf: Buffer,
    private readonly limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  ) {
    this.remainingTotal = limits.maxTotalBytes;
  }

  /** 지금까지 실제로 해제한 바이트 수. */
  get inflatedBytes(): number {
    return this.limits.maxTotalBytes - this.remainingTotal;
  }

  /**
   * 엔트리 하나를 해제한다. 선언 크기가 아니라 **실제 출력 바이트**로 상한을 강제한다.
   *
   * `maxOutputLength`는 zlib의 inflate 루프 안에서 검사되므로, 수십 GB로 부푸는 입력도
   * 상한 바이트를 넘는 순간 멈춘다 — 메모리를 다 쓰고 나서 재는 게 아니다.
   */
  inflate(entry: ZipEntry): Buffer {
    const data = this.locateData(entry);

    const cap = Math.min(this.limits.maxEntryBytes, this.remainingTotal);
    if (cap <= 0) {
      throw new ZipError(
        'zip_total_too_large',
        `uncompressed budget exhausted (max ${this.limits.maxTotalBytes})`,
      );
    }

    let out: Buffer;
    if (entry.method === METHOD_STORED) {
      if (data.length > cap) {
        throw this.capError(data.length);
      }
      out = Buffer.from(data);
    } else {
      try {
        out = inflateRawSync(data, { maxOutputLength: cap });
      } catch (error: unknown) {
        // zlib은 상한 초과를 ERR_BUFFER_TOO_LARGE로 알린다. 그 밖은 손상된 데이터다.
        const code = (error as { code?: string } | null)?.code;
        if (code === 'ERR_BUFFER_TOO_LARGE') {
          throw this.capError(cap);
        }
        throw new ZipError('zip_invalid', 'entry could not be inflated');
      }
    }

    // 실제 압축비 재검사 — 선언값이 아니라 결과로 판정한다.
    if (
      data.length >= this.limits.ratioFloorBytes &&
      out.length > data.length * this.limits.maxEntryRatio
    ) {
      throw new ZipError(
        'zip_ratio_exceeded',
        `entry inflated at a ${Math.round(out.length / data.length)}x ratio`,
      );
    }
    if (crc32(out) !== entry.crc32) {
      throw new ZipError('zip_invalid', 'entry failed its CRC-32 check');
    }

    this.remainingTotal -= out.length;
    return out;
  }

  /** 상한 초과가 엔트리 단위인지 아카이브 단위인지 구분해 코드를 고른다. */
  private capError(observed: number): ZipError {
    if (this.remainingTotal < this.limits.maxEntryBytes) {
      return new ZipError(
        'zip_total_too_large',
        `archive exceeded ${this.limits.maxTotalBytes} uncompressed bytes`,
      );
    }
    return new ZipError(
      'zip_entry_too_large',
      `entry exceeded ${this.limits.maxEntryBytes} bytes (observed ${observed})`,
    );
  }

  /** local file header를 검증하고 압축 데이터 구간을 잘라낸다. */
  private locateData(entry: ZipEntry): Buffer {
    const offset = entry.localHeaderOffset;
    if (offset + LOCAL_HEADER_SIZE > this.buf.length) {
      throw new ZipError('zip_invalid', 'local header is out of bounds');
    }
    if (this.buf.readUInt32LE(offset) !== SIG_LOCAL) {
      throw new ZipError('zip_invalid', 'bad local header signature');
    }
    const nameLength = this.buf.readUInt16LE(offset + 26);
    const extraLength = this.buf.readUInt16LE(offset + 28);
    const start = offset + LOCAL_HEADER_SIZE + nameLength + extraLength;
    // 압축 크기는 central directory 값을 쓴다 — local header는 data descriptor
    // (flag bit 3)를 쓰는 아카이브에서 0으로 비어 있을 수 있다.
    const end = start + entry.compressedSize;
    if (end > this.buf.length) {
      throw new ZipError('zip_invalid', 'entry data is out of bounds');
    }
    return this.buf.subarray(start, end);
  }
}
