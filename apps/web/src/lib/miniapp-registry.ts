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

interface MiniappBase {
  key: string;
  name: string;
  description: string;
  permissions: readonly MiniappPermission[];
}
export type MiniappManifest = MiniappBase & { execution: "iframe"; entry: string; height: number };

/*
 * 지금은 비어 있다 — 뒷마당(3D 산책)을 2026-09-09에 걷어냈다. 재미가 없다는 판정이었다.
 *
 * 배열만 비우고 **틀은 남긴다.** 호스트·브릿지·권한 검증·저장 API(`/v1/play/*`)가
 * 그대로라 다음 미니앱은 여기 한 줄을 더하는 것으로 붙는다. 전체 화면 실행 방식
 * (`execution: "backyard"`)은 그 게임 전용이었으므로 유니온에서 함께 뺐다 — 다시
 * 필요해지면 git에서 되살린다(`c820a43` 이전).
 */
export const MINIAPPS: readonly MiniappManifest[] = [];

/** 등록된 미니앱을 키로 찾는다. */
export function findMiniapp(key: string): MiniappManifest | null {
  return MINIAPPS.find((m) => m.key === key) ?? null;
}
