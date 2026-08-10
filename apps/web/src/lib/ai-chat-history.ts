/* ---------------------------------------------------------------------------
 * `/ai` 대화 로컬 보존 (P3)
 *
 * 화면을 벗어나면 대화가 사라져서, 방금 물어본 것을 다시 볼 수 없었다. 서버 저장은
 * 만들지 않는다 — 지금 필요한 건 "아까 뭐라고 답했지?"이고, 그건 이 기기 안에서
 * 끝나는 문제다(계정 간 동기화·검색은 만들지 않은 기능이다).
 *
 * ⚠️ **여기 담기는 것은 금융 질문과 답변이다.** 그래서 세 가지를 강제한다.
 *  1) 로그아웃·세션 종료 시 전부 지운다(`clearAiChatHistory`, auth-context의
 *     `clearSession`이 `queryClient.clear()`와 같은 자리에서 부른다).
 *  2) 보존 기간 상한({@link AI_CHAT_TTL_MS}) — 오래된 대화는 스스로 사라진다.
 *  3) 건수 상한({@link AI_CHAT_MAX_TURNS}) — 무한히 쌓이면 그것대로 문제다.
 *
 * 저장 단위는 `(가족, 범위)`다. 금융과 업무 기억은 **근거가 다른 답변**이라 한 줄에
 * 섞이면 오해가 되고(화면이 범위 전환 때 대화를 비우는 이유), 가족을 옮기면 다른
 * 가계부다. `sessionStorage`가 아니라 `localStorage`인 이유: 네이티브 셸은 앱을
 * 내렸다 올리는 것이 화면 전환만큼 잦아서, 세션 저장으로는 이 기능이 거의 동작하지
 * 않는다. 대신 TTL과 로그아웃 삭제로 수명을 좁힌다.
 * ------------------------------------------------------------------------- */

/** 한 범위에 보존하는 최대 문답 수(오래된 것부터 버린다). */
export const AI_CHAT_MAX_TURNS = 30;

/** 보존 기간(ms). 7일이 지난 문답은 읽는 시점에 버린다. */
export const AI_CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage 키 접두 — 로그아웃 시 이 접두로 싹 지운다. */
export const AI_CHAT_KEY_PREFIX = "fma.ai-chat.";

/** 저장 포맷 버전. 형태가 바뀌면 올리고, 다른 값은 읽지 않고 버린다. */
const STORED_VERSION = 1;

/**
 * 저장되는 문답이 갖춰야 하는 최소 형태. 나머지 필드(질문·답·출처…)는 화면이
 * 정의하고 여기서는 그대로 실어 나른다 — 말풍선 모양이 바뀔 때마다 이 모듈을
 * 고칠 이유가 없다.
 */
export interface StoredTurn {
  id: number;
  /** 저장 시각(ms). TTL 판정에 쓴다. */
  at: number;
}

interface StoredBundle {
  v: number;
  turns: unknown[];
}

/** `(가족, 범위)`별 저장 키. */
export function aiChatStorageKey(householdId: string, scope: string): string {
  return `${AI_CHAT_KEY_PREFIX}${householdId}.${scope}`;
}

/**
 * TTL 밖을 버리고 최신 {@link AI_CHAT_MAX_TURNS}건만 남긴다(순서 유지).
 *
 * 자르는 쪽이 **앞**인 이유: 대화는 아래로 자라고, 사용자가 다시 보고 싶은 것은
 * 방금 물어본 쪽이다.
 */
export function pruneTurns<T extends StoredTurn>(
  turns: ReadonlyArray<T>,
  now: number,
): T[] {
  const alive = turns.filter((t) => {
    const age = now - t.at;
    // 미래 시각(기기 시계 조정)은 버리지 않는다 — 방금 쓴 것일 가능성이 높다.
    return age <= AI_CHAT_TTL_MS;
  });
  return alive.length > AI_CHAT_MAX_TURNS
    ? alive.slice(alive.length - AI_CHAT_MAX_TURNS)
    : alive;
}

/**
 * 저장된 대화를 읽는다. 형태가 다르거나 저장소를 못 쓰면 빈 배열.
 *
 * 반환 타입 `T[]`는 호출부의 선언을 믿는 것이다 — 저장한 것도 같은 화면이므로
 * 실제로 어긋나는 경로가 없고, 버전(`v`)이 다르면 통째로 버린다. `id`·`at`만
 * 이 모듈이 실제로 읽는다.
 */
export function loadAiChat<T extends StoredTurn>(key: string, now: number): T[] {
  const raw = readRaw(key);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isBundle(parsed) || parsed.v !== STORED_VERSION) return [];
  const turns = parsed.turns.filter(hasTurnShape) as T[];
  const pruned = pruneTurns(turns, now);
  // 읽으면서 정리분을 되쓴다 — 안 그러면 만료분이 자리만 차지한 채 남는다.
  if (pruned.length !== parsed.turns.length) saveAiChat(key, pruned, now);
  return pruned;
}

/** 대화를 저장한다(상한·TTL 적용). 비면 키를 지운다. */
export function saveAiChat<T extends StoredTurn>(
  key: string,
  turns: ReadonlyArray<T>,
  now: number,
): void {
  const pruned = pruneTurns(turns, now);
  try {
    if (pruned.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const bundle: StoredBundle = { v: STORED_VERSION, turns: pruned };
    window.localStorage.setItem(key, JSON.stringify(bundle));
  } catch {
    // 저장 실패(프라이빗 모드·쿼터 초과)는 무시한다 — 대화는 화면 상태로 살아 있고,
    // 다음 진입에 못 복원될 뿐이다. 금융 데이터를 못 쓰는 것은 위험이 아니다.
  }
}

/**
 * 모든 가족·범위의 대화를 지운다. **로그아웃·세션 종료 경로에서 반드시 호출한다** —
 * 같은 기기의 다음 사용자에게 앞 사용자의 금융 질문이 보이면 안 된다.
 */
export function clearAiChatHistory(): void {
  try {
    const storage = window.localStorage;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(AI_CHAT_KEY_PREFIX)) doomed.push(key);
    }
    // 순회 중 지우면 인덱스가 밀린다 — 모아서 지운다.
    for (const key of doomed) storage.removeItem(key);
  } catch {
    // 저장소를 못 쓰면 애초에 저장된 것도 없다.
  }
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function isBundle(value: unknown): value is StoredBundle {
  if (typeof value !== "object" || value === null) return false;
  const bundle = value as Partial<StoredBundle>;
  return typeof bundle.v === "number" && Array.isArray(bundle.turns);
}

/** 이 모듈이 실제로 읽는 두 필드만 확인한다(나머지는 화면의 계약). */
function hasTurnShape(value: unknown): value is StoredTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Partial<StoredTurn>;
  return typeof turn.id === "number" && typeof turn.at === "number";
}
