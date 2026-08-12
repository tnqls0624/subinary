import { beforeEach, describe, expect, it } from "vitest";

import {
  POLL_FAST_INTERVAL_MS,
  POLL_FAST_UNTIL_MS,
  POLL_GIVE_UP_MS,
  POLL_SLOW_INTERVAL_MS,
  SLACK_IMPORT_KEY_PREFIX,
  SLACK_IMPORT_TTL_MS,
  clearPendingImport,
  isTerminalImportStatus,
  pendingImportKey,
  readPendingImport,
  shouldKeepPolling,
  slackImportErrorMessage,
  slackImportPollInterval,
  writePendingImport,
} from "./slack-import";

/** node 환경에는 window가 없다 — 최소 대역만 세운다. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  get size() {
    return this.map.size;
  }
}

const NOW = 1_800_000_000_000;

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = { localStorage: new MemoryStorage() };
});

describe("폴링 간격 — 조밀하게 시작해 느슨해진다", () => {
  it("초반에는 조밀하게 본다", () => {
    expect(slackImportPollInterval(0)).toBe(POLL_FAST_INTERVAL_MS);
    expect(slackImportPollInterval(POLL_FAST_UNTIL_MS - 1)).toBe(
      POLL_FAST_INTERVAL_MS,
    );
  });

  it("경계를 넘으면 느슨해진다", () => {
    expect(slackImportPollInterval(POLL_FAST_UNTIL_MS)).toBe(
      POLL_SLOW_INTERVAL_MS,
    );
    expect(slackImportPollInterval(POLL_FAST_UNTIL_MS * 10)).toBe(
      POLL_SLOW_INTERVAL_MS,
    );
  });
});

describe("shouldKeepPolling — 언제 멈추는가", () => {
  it("종료 상태면 즉시 멈춘다", () => {
    expect(shouldKeepPolling("completed", 0)).toBe(false);
    expect(shouldKeepPolling("failed", 0)).toBe(false);
  });

  it("진행 중이면 계속 본다", () => {
    expect(shouldKeepPolling("queued", 0)).toBe(true);
    expect(shouldKeepPolling("processing", POLL_GIVE_UP_MS - 1)).toBe(true);
  });

  it("포기 시점을 넘으면 자동 갱신만 멈춘다 (실패로 바꾸지 않는다)", () => {
    // 처리 시간 SLO는 모른다 — 아직 도는 작업을 실패라고 말하지 않는다.
    expect(shouldKeepPolling("processing", POLL_GIVE_UP_MS)).toBe(false);
    expect(isTerminalImportStatus("processing")).toBe(false);
  });
});

describe("실패 문구 — 다음에 할 일을 알려준다", () => {
  it.each([
    ["zip_too_many_entries", "20,000"],
    ["zip_total_too_large", "128MB"],
    ["zip_entry_too_large", "32MB"],
    ["zip_encrypted", "암호"],
    ["zip_missing_channels", "channels.json"],
    ["zip_missing_users", "users.json"],
  ])("%s 문구는 근거·행동을 담는다", (code, fragment) => {
    expect(slackImportErrorMessage(code)).toContain(fragment);
  });

  it("모든 계약 코드에 전용 문구가 있다", () => {
    // 코드가 늘면 이 목록도 늘려야 한다 — 빠지면 기본 문구로 조용히 뭉개진다.
    const codes = [
      "zip_invalid",
      "zip_unsafe_entry",
      "zip_too_many_entries",
      "zip_entry_too_large",
      "zip_total_too_large",
      "zip_ratio_exceeded",
      "zip_encrypted",
      "zip_unsupported",
      "zip_missing_channels",
      "zip_missing_users",
      "zip_malformed_metadata",
      "bundle_invalid_json",
      "bundle_invalid_structure",
      "storage_unavailable",
      "internal_error",
    ];
    const fallback = slackImportErrorMessage("internal_error");
    for (const code of codes) {
      const message = slackImportErrorMessage(code);
      expect(message).not.toBe("");
      if (code !== "internal_error") {
        expect(message).not.toBe(fallback);
      }
    }
  });

  it("알 수 없는 코드·null도 막다른 길로 두지 않는다", () => {
    expect(slackImportErrorMessage("something_new")).not.toBe("");
    expect(slackImportErrorMessage(null)).not.toBe("");
  });
});

describe("진행 중 import 기억 — 화면을 벗어나도 결과를 다시 본다", () => {
  const key = pendingImportKey("user-1");

  it("사용자별로 키가 갈린다", () => {
    expect(key).not.toBe(pendingImportKey("user-2"));
    expect(key.startsWith(SLACK_IMPORT_KEY_PREFIX)).toBe(true);
  });

  it("적어 두면 다시 읽는다", () => {
    writePendingImport(key, {
      importId: "i1",
      slackWorkspaceId: "w1",
      startedAt: NOW,
    });
    expect(readPendingImport(key, NOW + 5_000)).toEqual({
      importId: "i1",
      slackWorkspaceId: "w1",
      startedAt: NOW,
    });
  });

  it("TTL이 지나면 버린다", () => {
    writePendingImport(key, {
      importId: "i1",
      slackWorkspaceId: "w1",
      startedAt: NOW,
    });
    expect(readPendingImport(key, NOW + SLACK_IMPORT_TTL_MS + 1)).toBeNull();
    // 읽는 김에 지운다 — 남겨 두면 다음 사용자에게 유령 카드가 보인다.
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("망가진 값은 조용히 버린다 (화면을 깨뜨리지 않는다)", () => {
    window.localStorage.setItem(key, "{not json");
    expect(readPendingImport(key, NOW)).toBeNull();
    window.localStorage.setItem(key, JSON.stringify({ nope: true }));
    expect(readPendingImport(key, NOW)).toBeNull();
  });

  it("지우면 사라진다", () => {
    writePendingImport(key, {
      importId: "i1",
      slackWorkspaceId: "w1",
      startedAt: NOW,
    });
    clearPendingImport(key);
    expect(readPendingImport(key, NOW)).toBeNull();
  });

  it("식별자와 시각만 저장한다 (원문·이름 금지)", () => {
    writePendingImport(key, {
      importId: "i1",
      slackWorkspaceId: "w1",
      startedAt: NOW,
    });
    const stored = JSON.parse(window.localStorage.getItem(key) as string);
    expect(Object.keys(stored).sort()).toEqual([
      "importId",
      "slackWorkspaceId",
      "startedAt",
    ]);
  });
});
