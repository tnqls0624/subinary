/* ---------------------------------------------------------------------------
 * 업무 기억 · Slack Export 가져오기 (C-6 본체)
 *
 * 규칙과 문구만 모아 둔 순수 모듈이다(테스트가 여기를 지킨다). 화면은 결과만 쓴다.
 *
 * ## 왜 진행 상태를 로컬에 남기는가
 *
 * Slack Export는 크고 처리가 비동기다. 업로드가 끝나 `importId`를 받은 뒤 사용자가
 * 다른 탭으로 가거나 앱을 내렸다 올리면, 그 id가 화면 상태에만 있었을 때는 **결과를
 * 다시 볼 방법이 없다.** 그래서 id를 로컬에 적어 두고 돌아오면 폴링을 이어 간다.
 *
 * 담기는 것은 **식별자(UUID)와 시각뿐**이다 — 메시지 원문·채널명·워크스페이스 이름은
 * 넣지 않는다. 키를 userId로 나누고 24시간 TTL을 둬서, 같은 기기의 다음 사용자에게
 * 남지 않게 한다(폴링이 403/404를 받으면 그 자리에서 지운다 — 로그아웃 훅에 기대지
 * 않는 자기 치유 경로다).
 * ------------------------------------------------------------------------- */

/** 서버가 돌려주는 import 상태(`packages/contracts/src/slack.ts`와 같은 어휘). */
export type SlackImportStatusValue =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

/* -------------------------------------------------------------------------- */
/* 폴링 정책                                                                   */
/* -------------------------------------------------------------------------- */

/** 업로드 직후의 조밀한 폴링 구간(ms). 대부분의 import는 이 안에서 끝난다. */
export const POLL_FAST_UNTIL_MS = 30_000;
/** 조밀 구간의 간격(ms). */
export const POLL_FAST_INTERVAL_MS = 2_000;
/** 그 뒤의 간격(ms). 오래 걸리는 대형 Export를 위해 느슨하게 본다. */
export const POLL_SLOW_INTERVAL_MS = 5_000;
/**
 * 자동 폴링을 멈추는 시점(ms).
 *
 * 처리 시간 SLO는 **모름**이다(PO 판정 Q3: 문서의 10초는 폴링 권장 상한이지 완료
 * 보장이 아니다). 그래서 "실패"로 단정하지 않고 **자동 갱신만 멈춘 뒤** 다시 확인
 * 버튼을 남긴다 — 아직 도는 작업을 실패라고 말하는 것이 더 나쁜 거짓말이다.
 */
export const POLL_GIVE_UP_MS = 10 * 60 * 1000;

/** 지금 폴링 간격(ms). 경과 시간에 따라 조밀 → 느슨으로 바뀐다. */
export function slackImportPollInterval(elapsedMs: number): number {
  return elapsedMs < POLL_FAST_UNTIL_MS
    ? POLL_FAST_INTERVAL_MS
    : POLL_SLOW_INTERVAL_MS;
}

/** 더 이상 바뀌지 않는 종료 상태인가. */
export function isTerminalImportStatus(status: SlackImportStatusValue): boolean {
  return status === "completed" || status === "failed";
}

/**
 * 지금 자동 폴링을 계속해야 하는가.
 *
 * 종료 상태면 멈추고, 종료 전이라도 {@link POLL_GIVE_UP_MS}를 넘으면 멈춘다
 * (실패로 바꾸지는 않는다 — 화면이 "다시 확인"을 제안한다).
 */
export function shouldKeepPolling(
  status: SlackImportStatusValue,
  elapsedMs: number,
): boolean {
  if (isTerminalImportStatus(status)) return false;
  return elapsedMs < POLL_GIVE_UP_MS;
}

/* -------------------------------------------------------------------------- */
/* 실패 문구                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 실패 코드 → 사용자가 **다음에 무엇을 할지 알 수 있는** 문구.
 *
 * "가져오지 못했어요"만으로는 다시 시도할 수가 없다. 상한에 걸린 것인지, 파일이
 * 잘못된 것인지, 서버 사정인지가 각각 다른 행동으로 이어진다.
 * 상한 숫자를 문구에 적는 이유: 사용자가 "기간을 나눠 다시 내보내기"를 스스로
 * 판단할 수 있어야 한다.
 */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  zip_invalid:
    "ZIP 파일이 손상된 것 같아요. Slack에서 다시 내려받아 올려주세요.",
  zip_unsafe_entry:
    "안전하지 않은 경로가 들어 있어 열지 않았어요. Slack이 만든 원본 ZIP이 맞는지 확인해 주세요.",
  zip_too_many_entries:
    "파일 개수가 너무 많아요(최대 20,000개). Slack에서 기간을 나눠 내보낸 뒤 올려주세요.",
  zip_entry_too_large:
    "안에 너무 큰 파일이 있어요(파일 하나당 최대 32MB).",
  zip_total_too_large:
    "압축을 풀면 너무 커져요(최대 128MB). Slack에서 기간을 나눠 내보낸 뒤 올려주세요.",
  zip_ratio_exceeded:
    "비정상적으로 압축된 파일이라 열지 않았어요. Slack이 만든 원본 ZIP이 맞는지 확인해 주세요.",
  zip_encrypted:
    "암호가 걸린 ZIP은 열 수 없어요. 암호 없이 다시 내보내 주세요.",
  zip_unsupported:
    "지원하지 않는 ZIP 형식이에요(zip64·분할 압축). Slack이 만든 원본 ZIP을 그대로 올려주세요.",
  zip_missing_channels:
    "ZIP 안에 channels.json이 없어요. 워크스페이스 Export ZIP이 맞는지 확인해 주세요.",
  zip_missing_users:
    "ZIP 안에 users.json이 없어요. 워크스페이스 Export ZIP이 맞는지 확인해 주세요.",
  zip_malformed_metadata:
    "ZIP 안의 목록 파일을 읽지 못했어요. Slack에서 다시 내려받아 올려주세요.",
  bundle_invalid_json: "JSON 파일을 읽지 못했어요. 파일이 온전한지 확인해 주세요.",
  bundle_invalid_structure:
    "JSON 번들의 구조가 예상과 달라요. Slack Export ZIP을 그대로 올리시면 저희가 변환해 드려요.",
  storage_unavailable:
    "원본을 읽지 못했어요. 잠시 후 다시 올려주세요.",
  internal_error: "알 수 없는 이유로 가져오지 못했어요. 잠시 후 다시 시도해 주세요.",
};

/** 알 수 없는 코드도 막다른 길로 두지 않는다. */
export function slackImportErrorMessage(code: string | null): string {
  if (!code) return ERROR_MESSAGES.internal_error;
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal_error;
}

/* -------------------------------------------------------------------------- */
/* 진행 중 import 기억                                                          */
/* -------------------------------------------------------------------------- */

/** localStorage 키 접두. */
export const SLACK_IMPORT_KEY_PREFIX = "fma.slack-import.";

/** 기억해 두는 기간(ms). 이보다 오래된 것은 읽는 시점에 버린다. */
export const SLACK_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** 저장되는 값 — **식별자와 시각뿐**이다(원문·이름 금지). */
export interface PendingSlackImport {
  importId: string;
  slackWorkspaceId: string;
  /** 업로드를 수락받은 시각(ms). 폴링 경과와 TTL 판정에 쓴다. */
  startedAt: number;
}

/** 사용자별 저장 키. 같은 기기의 다른 계정과 섞이지 않게 한다. */
export function pendingImportKey(userId: string): string {
  return `${SLACK_IMPORT_KEY_PREFIX}${userId}`;
}

function isPending(value: unknown): value is PendingSlackImport {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PendingSlackImport>;
  return (
    typeof item.importId === "string" &&
    typeof item.slackWorkspaceId === "string" &&
    typeof item.startedAt === "number"
  );
}

/** 진행 중 import를 읽는다. 없거나 TTL이 지났으면 `null`(그리고 지운다). */
export function readPendingImport(
  key: string,
  now: number,
): PendingSlackImport | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearPendingImport(key);
    return null;
  }
  if (!isPending(parsed) || now - parsed.startedAt > SLACK_IMPORT_TTL_MS) {
    clearPendingImport(key);
    return null;
  }
  return parsed;
}

/** 진행 중 import를 적어 둔다. 저장 실패는 무시한다(화면 상태로는 계속 동작한다). */
export function writePendingImport(
  key: string,
  value: PendingSlackImport,
): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 프라이빗 모드·쿼터 초과. 이번 세션에서는 화면 상태로 폴링이 계속된다.
  }
}

/** 진행 중 import 기록을 지운다. */
export function clearPendingImport(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 지울 수 없으면 TTL이 결국 정리한다.
  }
}
