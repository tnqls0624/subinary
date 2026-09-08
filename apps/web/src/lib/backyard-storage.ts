/* ---------------------------------------------------------------------------
 * 뒷마당 전체 화면 저장 어댑터
 *
 * 게임이 iframe을 벗어나 앱과 같은 문서에서 돌게 되면서 postMessage 브릿지가
 * 사라졌다. 그런데 **저장 계약은 그대로 지켜야 한다** — 5키, 실패 분기, 키별 직렬
 * 큐, ACK 순번이 전부 `rpg-session.js`의 요구다.
 *
 * 그래서 이 파일은 세션이 기대하는 `{ready, state:{get,set}}` 인터페이스를 그대로
 * 제공하고, 안에서 api-client를 호출한다. 세션 코드는 한 줄도 고치지 않는다.
 *
 * ## `usePlayStates` 훅을 그대로 쓰지 않는 이유
 *
 * 설계서(redesign-backyard-3d.md §3)가 짚은 것이다. 훅의 캐시 초기값과 전역
 * invalidation을 세션에 연결하면 **stale 읽기를 부팅 성공으로 보거나 dirty 상태를
 * 원격 값으로 교체**할 수 있다. 세션은 자기 세대 안에서 방금 읽은 것만 신뢰해야 한다.
 *
 * ## list를 세대마다 한 번만 부른다
 *
 * `createMiniappStateHandlers`의 `state.get`은 키마다 list를 호출해서 5키를 읽으면
 * 5~6회가 된다. 여기서는 세대 시작에 한 번 받아 스냅샷으로 답한다.
 * **다만 이것이 서버 트랜잭션 보장은 아니다** — 다른 기기의 동시 저장에 대한
 * snapshot/CAS가 생긴 것이 아니라 왕복 횟수만 줄인 것이다.
 * ------------------------------------------------------------------------- */

export interface BackyardStore {
  list(householdId: string, appKey: string): Promise<{ items: { stateKey: string; state: unknown }[] }>;
  save(householdId: string, appKey: string, key: string, state: Record<string, unknown>): Promise<unknown>;
}

/** 세션이 기대하는 브릿지 모양. 이름은 브릿지지만 postMessage는 없다. */
export interface BackyardStorageBridge {
  ready(): Promise<void>;
  state: {
    /**
     * 저장된 값 자체를 준다. **`{state: …}` 봉투가 아니다.**
     *
     * 브릿지 클라이언트가 응답 봉투를 벗겨서 세션에 값을 넘겼고, 세션은
     * `raw.rpg_meta === null`로 신규를 판정한다. 봉투를 그대로 넘기면 그 비교가
     * 항상 거짓이 되어 신규를 신규로 못 보고 `invalid_state`가 된다.
     */
    get(key: string): Promise<unknown>;
    set(key: string, value: Record<string, unknown>): Promise<void>;
  };
}

export interface BackyardStorageOptions {
  householdId: string;
  appKey: string;
  store: BackyardStore;
  /** 인증·가구가 준비됐는가. postMessage handshake가 아니라 이 뜻이다. */
  isReady: () => boolean;
}

/**
 * 가구·앱을 캡처한 저장 어댑터를 만든다.
 *
 * 캡처가 중요하다 — 가구가 바뀌면 호출자가 이 어댑터를 버리고 새로 만든다.
 * 이미 시작한 요청은 캡처한 가구로만 끝나므로 이전 가구 응답이 새 가구에 적용되지 않는다.
 */
export function createBackyardStorage(options: BackyardStorageOptions): BackyardStorageBridge {
  const { householdId, appKey, store, isReady } = options;
  if (!householdId || !appKey) throw new Error('가족과 미니앱이 준비되지 않았어요');

  /** 키별 직렬 큐. 같은 키의 PUT이 서로 앞지르지 않게 한다. */
  const queues = new Map<string, Promise<unknown>>();
  /** 이 세대의 list 스냅샷. ready()가 채우고 get()이 읽는다. */
  let snapshot: Map<string, unknown> | null = null;

  return {
    async ready(): Promise<void> {
      if (!isReady()) throw new Error('가족 정보를 준비하고 있어요');
      const result = await store.list(householdId, appKey);
      // 손상 응답을 빈 목록으로 바꾸지 않는다. 그러면 로드 실패가 신규로 흐른다.
      if (!result || !Array.isArray(result.items)) throw new Error('저장 목록을 읽지 못했어요');
      const next = new Map<string, unknown>();
      for (const item of result.items) {
        if (!item || typeof item.stateKey !== 'string' || !item.stateKey) throw new Error('저장 목록이 손상됐어요');
        if (!Object.prototype.hasOwnProperty.call(item, 'state') || item.state === undefined) throw new Error('저장 응답에 state가 없어요');
        if (next.has(item.stateKey)) throw new Error('저장 목록에 중복 키가 있어요');
        next.set(item.stateKey, item.state);
      }
      snapshot = next;
    },

    state: {
      async get(key: string): Promise<unknown> {
        if (!key) throw new Error('key가 필요해요');
        // ready() 없이 부르면 오류다. 없는 키와 안 읽은 상태를 섞지 않는다 —
        // 그 혼동이 "로드 실패를 신규로 착각해 빈 마당을 저장"하는 입구다.
        if (!snapshot) throw new Error('저장 목록을 먼저 읽어야 해요');
        // 성공한 목록에 키가 없을 때만 null이다.
        return snapshot.has(key) ? snapshot.get(key) : null;
      },

      async set(key: string, value: Record<string, unknown>): Promise<void> {
        if (!key) throw new Error('key가 필요해요');
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('state는 객체여야 해요');
        const operation = (queues.get(key) ?? Promise.resolve()).catch(() => undefined)
          .then(() => store.save(householdId, appKey, key, value));
        queues.set(key, operation);
        try {
          await operation;
          // 저장에 성공했으면 이 세대의 스냅샷도 따라간다. 그러지 않으면 같은
          // 세대에서 다시 읽을 때 옛 값이 나온다.
          if (snapshot) snapshot.set(key, value);
        } finally {
          if (queues.get(key) === operation) queues.delete(key);
        }
      },
    },
  };
}
