let activeBack: (() => boolean) | null = null;
/** 단일 네이티브 뒤로 콜백이 활성 게임에 먼저 위임한다. */
export function consumeGameBack(): boolean { return activeBack?.() ?? false; }
/** 게임 수명에 묶인 뒤로 처리기를 등록한다. */
export function registerGameBack(handler: () => boolean): () => void {
  activeBack=handler;
  return ()=>{if(activeBack===handler)activeBack=null;};
}
