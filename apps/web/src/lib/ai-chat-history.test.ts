import { beforeEach, describe, expect, it } from "vitest";

import {
  AI_CHAT_KEY_PREFIX,
  AI_CHAT_MAX_TURNS,
  AI_CHAT_TTL_MS,
  aiChatStorageKey,
  clearAiChatHistory,
  loadAiChat,
  pruneTurns,
  saveAiChat,
  type StoredTurn,
} from "./ai-chat-history";

/** 최소한의 localStorage 대역(vitest 기본 환경은 node라 window가 없다). */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

/** 화면이 얹는 필드(질문·답)까지 그대로 실려 가는지 함께 본다. */
interface TestTurn extends StoredTurn {
  question: string;
  answer: string;
}

const NOW = 1_800_000_000_000;
const turn = (id: number, at = NOW): TestTurn => ({
  id,
  at,
  question: `질문 ${id}`,
  answer: `답 ${id}`,
});

beforeEach(() => {
  const storage = new MemoryStorage();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = { localStorage: storage };
});

describe("aiChatStorageKey — 가족·범위별로 나눈다", () => {
  it("가족이나 범위가 다르면 다른 키", () => {
    expect(aiChatStorageKey("h1", "finance")).not.toBe(
      aiChatStorageKey("h1", "work"),
    );
    expect(aiChatStorageKey("h1", "finance")).not.toBe(
      aiChatStorageKey("h2", "finance"),
    );
  });

  it("로그아웃 삭제가 찾을 수 있도록 공통 접두를 쓴다", () => {
    expect(aiChatStorageKey("h1", "finance").startsWith(AI_CHAT_KEY_PREFIX)).toBe(
      true,
    );
  });
});

describe("pruneTurns — 보존 기간·건수 상한", () => {
  it("TTL이 지난 문답은 버린다", () => {
    const old = turn(1, NOW - AI_CHAT_TTL_MS - 1);
    const fresh = turn(2, NOW);
    expect(pruneTurns([old, fresh], NOW).map((t) => t.id)).toEqual([2]);
  });

  it("정확히 TTL 경계면 남긴다", () => {
    expect(pruneTurns([turn(1, NOW - AI_CHAT_TTL_MS)], NOW)).toHaveLength(1);
  });

  it("상한을 넘으면 오래된 앞쪽부터 버린다", () => {
    const many = Array.from({ length: AI_CHAT_MAX_TURNS + 5 }, (_, i) =>
      turn(i + 1),
    );
    const pruned = pruneTurns(many, NOW);
    expect(pruned).toHaveLength(AI_CHAT_MAX_TURNS);
    expect(pruned[0].id).toBe(6);
    expect(pruned.at(-1)?.id).toBe(AI_CHAT_MAX_TURNS + 5);
  });

  it("순서를 뒤집지 않는다", () => {
    const ids = pruneTurns([turn(1), turn(2), turn(3)], NOW).map((t) => t.id);
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe("save/load — 왕복", () => {
  const key = aiChatStorageKey("h1", "finance");

  it("저장한 대화를 그대로 읽는다(화면이 얹은 필드까지)", () => {
    saveAiChat(key, [turn(1), turn(2)], NOW);
    const loaded = loadAiChat<TestTurn>(key, NOW);
    expect(loaded.map((t) => t.id)).toEqual([1, 2]);
    expect(loaded[0].question).toBe("질문 1");
    expect(loaded[1].answer).toBe("답 2");
  });

  it("id·at이 없는 이물질은 걸러낸다", () => {
    window.localStorage.setItem(
      key,
      JSON.stringify({ v: 1, turns: [{ nope: true }, turn(7)] }),
    );
    expect(loadAiChat<TestTurn>(key, NOW).map((t) => t.id)).toEqual([7]);
  });

  it("빈 대화를 저장하면 키를 남기지 않는다", () => {
    saveAiChat(key, [turn(1)], NOW);
    saveAiChat(key, [], NOW);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("읽는 시점에 만료분을 걷어내고 되쓴다", () => {
    saveAiChat(key, [turn(1, NOW), turn(2, NOW)], NOW);
    const later = NOW + AI_CHAT_TTL_MS + 1;
    expect(loadAiChat(key, later)).toEqual([]);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("망가진 값·다른 버전은 조용히 버린다(화면을 깨뜨리지 않는다)", () => {
    window.localStorage.setItem(key, "{not json");
    expect(loadAiChat(key, NOW)).toEqual([]);
    window.localStorage.setItem(key, JSON.stringify({ v: 99, turns: [turn(1)] }));
    expect(loadAiChat(key, NOW)).toEqual([]);
    window.localStorage.setItem(key, JSON.stringify({ v: 1, turns: "nope" }));
    expect(loadAiChat(key, NOW)).toEqual([]);
  });

  it("저장한 적 없는 키는 빈 배열", () => {
    expect(loadAiChat(aiChatStorageKey("nope", "finance"), NOW)).toEqual([]);
  });
});

describe("clearAiChatHistory — 로그아웃 시 금융 대화가 남지 않는다", () => {
  it("모든 가족·범위의 대화를 지운다", () => {
    saveAiChat(aiChatStorageKey("h1", "finance"), [turn(1)], NOW);
    saveAiChat(aiChatStorageKey("h1", "work"), [turn(2)], NOW);
    saveAiChat(aiChatStorageKey("h2", "finance"), [turn(3)], NOW);

    clearAiChatHistory();

    expect(window.localStorage.length).toBe(0);
  });

  it("다른 앱 데이터는 건드리지 않는다", () => {
    window.localStorage.setItem("fma.activity-cursor.h1", "keep-me");
    saveAiChat(aiChatStorageKey("h1", "finance"), [turn(1)], NOW);

    clearAiChatHistory();

    expect(window.localStorage.getItem("fma.activity-cursor.h1")).toBe("keep-me");
  });
});
