/**
 * Slack Export ZIP → `SlackExportBundle` 변환기.
 *
 * ## 왜 새 파서를 만들지 않는가
 *
 * `parseSlackExport(bundle)`는 이미 검증된 자산이다(구조 검증·정규화·스레드 그룹핑·
 * secret 경고). ZIP은 **그 파서가 받는 입력 형태로 바꿔 주기만** 한다. 정규화 규칙이
 * 두 벌이 되면 JSON 업로드와 ZIP 업로드가 서로 다른 결과를 낳는다.
 *
 * ## 실제 Export 구조 (2026-08 기준 · 아래 §확인 필요 참조)
 *
 * ```
 * channels.json                 채널 목록  [{ id, name, ... }]
 * users.json                    사용자 목록 [{ id, team_id, name, real_name, profile, ... }]
 * groups.json / mpims.json      (있으면) 비공개 채널 · 멀티 DM — channels.json과 같은 모양
 * dms.json                      (있으면) 1:1 DM 메타 — 이름이 없어 이번 범위 밖
 * <채널이름>/YYYY-MM-DD.json     그 채널의 그 날짜 메시지 배열
 * ```
 *
 * 핵심 두 가지가 단일 JSON 번들과 다르다.
 *  1) **날짜 파일의 메시지에는 `channel` 필드가 없다.** 소속 채널은 **디렉터리 이름**이고,
 *     그 이름을 `channels.json`의 `name`으로 찾아 채널 **id**로 바꿔야 한다.
 *  2) **편집 시각이 `edited: { user, ts }` 객체다.** 번들 계약의 `edited_ts` 문자열로 편다.
 *
 * ## ⚠️ 확인 필요
 *
 * 이 저장소에는 **실제 Slack Export 샘플이 없다.** 위 구조는 Slack 공개 문서와 export
 * 포맷 지식에 근거하며 실물 대조를 하지 못했다. 그래서 변환기는 **모르면 실패하도록**
 * 만들었다: `channels.json`/`users.json`이 없으면 명확한 코드로 거절하고, 알 수 없는
 * 디렉터리·건너뛴 메시지는 **개수를 세어 돌려준다**(조용히 버리지 않는다). 실물로
 * 검증되면 이 주석과 리포트의 "확인 필요"를 지우면 된다.
 *
 * ## 메모리
 *
 * 엔트리를 **한 번에 하나씩** 풀어 JSON으로 바꾸고 텍스트는 즉시 버린다. 아카이브를
 * 통째로 이어붙이지 않는다 — 그게 zip-bomb의 표적이다. 누적되는 것은 정규화 전
 * 메시지 객체이며 그 총량은 `ZipLimits.maxTotalBytes`가 상한이다.
 */
import type { RawChannel, RawMessage, RawUser, SlackExportBundle } from './types.js';
import {
  DEFAULT_ZIP_LIMITS,
  ZipError,
  ZipReader,
  readZipDirectory,
  type ZipEntry,
  type ZipLimits,
} from './zip.js';

/** 채널 목록이 들어 있는 파일들. `channels.json`만 필수다. */
const CHANNEL_FILES = ['channels.json', 'groups.json', 'mpims.json'] as const;
const USERS_FILE = 'users.json';

/** 채널 디렉터리 안의 하루치 파일 이름(`2026-08-12.json`). */
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * 건너뛰는 메시지 subtype — 사람이 쓴 내용이 아니라 멤버십 잡음이다
 * ("<@U1> has joined the channel"). **조용히 버리지 않고 개수를 돌려준다.**
 */
const NOISE_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
]);

/** ZIP 변환 실패 코드. {@link ZipError}의 코드에 Slack 구조 관련 코드를 더한다. */
export type SlackZipErrorCode =
  /** 아카이브 루트에서 `channels.json`을 찾지 못했다. */
  | 'zip_missing_channels'
  /** 아카이브 루트에서 `users.json`을 찾지 못했다. */
  | 'zip_missing_users'
  /** 목록 파일이 JSON 배열이 아니다. */
  | 'zip_malformed_metadata';

/** Slack Export 구조 오류. ZIP 형식 자체의 오류는 {@link ZipError}가 담당한다. */
export class SlackZipError extends Error {
  readonly code: SlackZipErrorCode;

  constructor(code: SlackZipErrorCode, message: string) {
    super(message);
    this.name = 'SlackZipError';
    this.code = code;
  }
}

/** 변환 통계. 무엇을 건너뛰었는지 숨기지 않기 위한 값이다(원문·이름 없음). */
export interface SlackZipConversionStats {
  /** 아카이브의 파일 엔트리 수. */
  entryCount: number;
  /** 실제로 해제한 바이트 수. */
  inflatedBytes: number;
  /** 읽은 하루치 메시지 파일 수. */
  dayFileCount: number;
  /** 대응 채널을 못 찾아 건너뛴 디렉터리 수(DM 폴더 등). */
  skippedDirectoryCount: number;
  /** 멤버십 잡음(subtype)으로 건너뛴 메시지 수. */
  skippedNoiseMessageCount: number;
  /** `ts`가 없어 건너뛴 메시지 수. */
  skippedInvalidMessageCount: number;
}

/** 변환 결과. */
export interface SlackZipConversion {
  bundle: SlackExportBundle;
  stats: SlackZipConversionStats;
}

/** 파일이 ZIP 매직 바이트로 시작하는가(`PK\x03\x04`). 빈 아카이브는 `PK\x05\x06`. */
export function looksLikeZip(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  return (
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) &&
    (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Export가 최상위 디렉터리 하나로 감싸여 있는 경우를 흡수한다.
 * `channels.json`이 있는 위치를 루트로 삼는다 — 이름을 추측하지 않는다.
 */
function resolvePrefix(entries: readonly ZipEntry[]): string {
  for (const entry of entries) {
    if (entry.name === 'channels.json') return '';
    if (entry.name.endsWith('/channels.json')) {
      return entry.name.slice(0, entry.name.length - 'channels.json'.length);
    }
  }
  throw new SlackZipError(
    'zip_missing_channels',
    'channels.json was not found in the archive',
  );
}

function parseJsonArray(buf: Buffer, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new SlackZipError(
      'zip_malformed_metadata',
      `${label} is not valid JSON`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new SlackZipError(
      'zip_malformed_metadata',
      `${label} is not a JSON array`,
    );
  }
  return parsed;
}

/**
 * Slack Export ZIP을 단일 JSON 번들 계약(`SlackExportBundle`)으로 바꾼다.
 *
 * 형식·상한 위반은 {@link ZipError}, Slack 구조 위반은 {@link SlackZipError}로 던진다.
 * 둘 다 **안전한 코드**만 담으므로 그대로 저장·노출해도 된다.
 */
export function convertSlackExportZip(
  buf: Buffer,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): SlackZipConversion {
  // 1) 압축을 풀기 전에 구조·상한을 먼저 본다(경로 탈출·개수·선언 크기·선언 압축비).
  const directory = readZipDirectory(buf, limits);
  const reader = new ZipReader(buf, limits);
  const prefix = resolvePrefix(directory.entries);

  const byName = new Map<string, ZipEntry>();
  for (const entry of directory.entries) {
    byName.set(entry.name, entry);
  }

  /* --- 채널 목록: name → id ------------------------------------------- */
  const channels: RawChannel[] = [];
  const channelIdByName = new Map<string, string>();
  for (const file of CHANNEL_FILES) {
    const entry = byName.get(`${prefix}${file}`);
    if (!entry) {
      if (file === 'channels.json') {
        throw new SlackZipError(
          'zip_missing_channels',
          'channels.json was not found in the archive',
        );
      }
      continue; // groups/mpims는 없을 수 있다(Export 옵션에 따라).
    }
    for (const item of parseJsonArray(reader.inflate(entry), file)) {
      if (!isRecord(item)) continue;
      if (!isNonEmptyString(item.id) || !isNonEmptyString(item.name)) continue;
      // 같은 id가 두 파일에 있으면 먼저 읽은 쪽을 유지한다(channels.json 우선).
      if (channelIdByName.has(item.name)) continue;
      channelIdByName.set(item.name, item.id);
      channels.push({ id: item.id, name: item.name });
    }
  }

  /* --- 사용자 목록 ------------------------------------------------------ */
  const usersEntry = byName.get(`${prefix}${USERS_FILE}`);
  if (!usersEntry) {
    throw new SlackZipError(
      'zip_missing_users',
      'users.json was not found in the archive',
    );
  }
  const users: RawUser[] = [];
  let slackTeamId: string | undefined;
  for (const item of parseJsonArray(reader.inflate(usersEntry), USERS_FILE)) {
    if (!isRecord(item)) continue;
    if (!isNonEmptyString(item.id)) continue;
    const profile = isRecord(item.profile) ? item.profile : {};
    // handle이 없는 계정(일부 봇·삭제 계정)은 id를 이름으로 쓴다. 지어내지 않고
    // "아는 값"으로 채우는 것이다 — 여기서 throw하면 import 전체가 죽는다.
    const name = isNonEmptyString(item.name)
      ? item.name
      : isNonEmptyString(profile.display_name)
        ? profile.display_name
        : item.id;
    const realName = isNonEmptyString(item.real_name)
      ? item.real_name
      : isNonEmptyString(profile.real_name)
        ? profile.real_name
        : undefined;
    if (slackTeamId === undefined && isNonEmptyString(item.team_id)) {
      slackTeamId = item.team_id;
    }
    users.push(
      realName === undefined
        ? { id: item.id, name }
        : { id: item.id, name, real_name: realName },
    );
  }

  /* --- 채널 디렉터리별 하루치 메시지 ------------------------------------ */
  const messages: RawMessage[] = [];
  const stats: SlackZipConversionStats = {
    entryCount: directory.entries.length,
    inflatedBytes: 0,
    dayFileCount: 0,
    skippedDirectoryCount: 0,
    skippedNoiseMessageCount: 0,
    skippedInvalidMessageCount: 0,
  };

  // 디렉터리별로 모아 두면 "대응 채널 없음"을 파일이 아니라 **디렉터리 1건**으로 셀 수 있다.
  const dayFilesByDirectory = new Map<string, ZipEntry[]>();
  for (const entry of directory.entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const relative = entry.name.slice(prefix.length);
    const slash = relative.indexOf('/');
    if (slash <= 0) continue; // 루트의 메타데이터 파일.
    const directoryName = relative.slice(0, slash);
    const fileName = relative.slice(slash + 1);
    if (!DAY_FILE_RE.test(fileName)) continue; // 중첩 디렉터리·부가 파일은 대상 아님.
    const bucket = dayFilesByDirectory.get(directoryName);
    if (bucket) bucket.push(entry);
    else dayFilesByDirectory.set(directoryName, [entry]);
  }

  for (const [directoryName, entries] of dayFilesByDirectory) {
    const channelId = channelIdByName.get(directoryName);
    if (channelId === undefined) {
      // DM 폴더(`D0...`)나 export에서 빠진 채널. 개수를 남겨 사용자가 알 수 있게 한다.
      stats.skippedDirectoryCount += 1;
      continue;
    }
    // 날짜 순서를 고정해 같은 아카이브가 항상 같은 결과를 내게 한다.
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const items = parseJsonArray(reader.inflate(entry), 'day file');
      stats.dayFileCount += 1;
      for (const item of items) {
        if (!isRecord(item)) {
          stats.skippedInvalidMessageCount += 1;
          continue;
        }
        if (isNonEmptyString(item.subtype) && NOISE_SUBTYPES.has(item.subtype)) {
          stats.skippedNoiseMessageCount += 1;
          continue;
        }
        if (!isNonEmptyString(item.ts)) {
          stats.skippedInvalidMessageCount += 1;
          continue;
        }
        // `edited`는 export에서 `{ user, ts }` 객체다 → 번들 계약의 문자열로 편다.
        const edited = isRecord(item.edited) ? item.edited : undefined;
        const message: RawMessage = { channel: channelId, ts: item.ts };
        if (isNonEmptyString(item.user)) message.user = item.user;
        if (typeof item.text === 'string') message.text = item.text;
        if (isNonEmptyString(item.thread_ts)) message.thread_ts = item.thread_ts;
        if (edited && isNonEmptyString(edited.ts)) message.edited_ts = edited.ts;
        messages.push(message);
      }
    }
  }

  stats.inflatedBytes = reader.inflatedBytes;

  return {
    bundle: {
      workspace: slackTeamId === undefined ? {} : { slackTeamId },
      channels,
      users,
      messages,
    },
    stats,
  };
}

export { ZipError, readZipDirectory, DEFAULT_ZIP_LIMITS };
export type { ZipLimits, ZipEntry };
