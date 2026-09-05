/* ---------------------------------------------------------------------------
 * 미니앱 등록부 — 어떤 미니앱이 있고 무엇을 할 수 있는가
 *
 * ## 왜 코드에 두는가 (지금은)
 *
 * 미니앱을 만드는 사람이 우리뿐이라 DB 등록 화면이 아직 값을 하지 않는다. 대신
 * **manifest 모양은 처음부터 갖춰 둔다** — 나중에 이 배열이 DB 테이블이 되어도
 * 소비하는 쪽(`/play` 목록, 호스트 화면)은 바뀌지 않는다.
 *
 * ## 권한은 여기서 정해진다
 *
 * 미니앱이 스스로 권한을 주장할 수 없다(미니앱 번들은 미니앱이 만든다). 호스트가
 * 등록부에 적힌 것만 허용하고, 브릿지가 그것으로 검증한다.
 *
 * 권한을 늘릴 때는 **그 미니앱이 실제로 그 데이터를 필요로 하는지** 확인한다.
 * "혹시 쓸까 봐" 넣은 권한은 나중에 회수할 수 없다 — 이미 그것을 쓰는 코드가 생긴다.
 * ------------------------------------------------------------------------- */
import type { MiniappPermission } from "@family/shared";

export interface MiniappManifest {
  /** 식별자. 상태 저장 키(`play_states.app_key`)이자 번들 경로다. */
  key: string;
  name: string;
  description: string;
  /**
   * 번들 진입 URL.
   *
   * `apps/web/public/` 아래에 두면 정적 export에 포함돼 **OTA로 함께 배포**된다 —
   * 게임을 추가할 때 네이티브 재빌드가 없다는 뜻이고, 그것이 이 구조의 목적이다.
   */
  entry: string;
  /** 이 미니앱에 허용된 권한. 선언하지 않은 메서드는 브릿지가 막는다. */
  permissions: readonly MiniappPermission[];
  /** iframe 높이(px). 미니앱이 스스로 크기를 바꿀 수 없어 호스트가 정한다. */
  height: number;
}

export const MINIAPPS: readonly MiniappManifest[] = [
  {
    // **권한 0개.** 지출을 전혀 보지 않고 자기 점수만 저장한다(`state.*`는 권한
    // 불필요). 권한 모델을 이렇게 쓰라고 만든 것이다 — 순수 게임은 아무것도 못
    // 보게 두고, 데이터가 필요한 것만 선언하게 한다.
    key: "2048",
    name: "2048",
    description: "같은 숫자를 밀어서 합쳐요",
    entry: "/miniapps/2048/index.html",
    permissions: [],
    height: 470,
  },
  {
    key: "snake",
    name: "스네이크",
    description: "먹이를 먹고 길어져요",
    entry: "/miniapps/snake/index.html",
    permissions: [],
    height: 480,
  },
  {
    key: "memory",
    name: "기억력 카드",
    description: "같은 그림 두 장을 찾아요",
    entry: "/miniapps/memory/index.html",
    permissions: [],
    height: 470,
  },
  {
    key: "spend-quiz",
    name: "얼마 썼을까",
    description: "자주 가는 곳에서 얼마 썼는지 맞혀 봐요",
    entry: "/miniapps/spend-quiz/index.html",
    // 가맹점 집계만 있으면 된다. 개별 거래는 필요 없고, 그래서 주지 않는다.
    permissions: ["merchant.list"],
    height: 460,
  },
];

export function findMiniapp(key: string): MiniappManifest | null {
  return MINIAPPS.find((m) => m.key === key) ?? null;
}
