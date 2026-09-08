/// <reference path="../../../public/miniapps/backyard/rpg-rules.js" />
/// <reference path="../../../public/miniapps/backyard/rpg3d-models.js" />
/// <reference path="../../../public/miniapps/backyard/rpg3d-scene.js" />
/// <reference path="../../../public/miniapps/backyard/rpg3d-controller.js" />
/// <reference path="../../../public/miniapps/backyard/rpg3d-world.js" />
/// <reference path="../../../public/miniapps/backyard/rpg-input.js" />
/// <reference path="../../../public/miniapps/backyard/rpg-session.js" />
/// <reference path="../../../public/miniapps/backyard/rpg-codec.js" />
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { canGoBackInApp } from "@/lib/nav-history";
import { registerGameBack } from "@/lib/game-navigation";
import type { BackyardStorageBridge } from "@/lib/backyard-storage";
import styles from "./backyard-game.module.css";

type RpgSessionState = ReturnType<ReturnType<typeof BackyardRpgSession.createSession>["getState"]>;
type RpgSessionHandle = ReturnType<typeof BackyardRpgSession.createSession>;
type RpgWorldHandle = ReturnType<typeof BackyardRpg3dWorld.create>;
type RpgControllerHandle = ReturnType<typeof BackyardRpg3dController.create>;
type RpgSnapshot = ReturnType<RpgWorldHandle["snapshot"]>;
/** 프레임마다 다시 그릴 수 없는 HUD 값만 뽑아낸다. 나머지는 장면이 직접 그린다. */
type RpgHud = Pick<RpgSnapshot, "hud" | "dialogue" | "card" | "editing" | "chosen"> & { fishing: string; gathering: boolean };

let loading: Promise<void> | null=null;
/**
 * 동봉 파일만 순서대로 한 번 로드한다. 실패한 파일은 재시도한다.
 *
 * 세션·codec도 여기서 로드한다 — 슬라이스 4는 `BackyardRpgSession`을 쓰면서 목록에
 * 넣지 않아 실제 라우트에서 참조 오류가 났다. codec의 garden 이주 경로가 옛
 * `BackyardCodec`을 호출하므로 balance·rules·codec도 함께 필요하다.
 */
function loadEngine(): Promise<void> {
  if(loading)return loading;
  loading=(async()=>{
    for(const name of ["vendor/three-r128.min.js","backyard/balance.js","backyard/rules.js","backyard/codec.js",
      "backyard/rpg-rules.js","backyard/rpg-codec.js","backyard/rpg-session.js","backyard/rpg3d-terrain.js",
      "backyard/rpg3d-controller.js","backyard/rpg3d-models.js","backyard/rpg3d-world.js","backyard/rpg-input.js","backyard/rpg3d-scene.js"]){
      if(document.querySelector(`script[data-backyard-src="${name}"]`))continue;
      await new Promise<void>((resolve,reject)=>{
        const script=document.createElement("script");script.src=`/miniapps/${name}`;
        script.onload=()=>{script.dataset.backyardSrc=name;resolve();};
        script.onerror=()=>{script.remove();reject(Error("마당 화면을 불러오지 못했어요. 다시 시도해 주세요."));};
        document.head.append(script);
      });
    }
  })().catch((error: unknown)=>{loading=null;throw error;});
  return loading;
}
const ALBUM_TABS=["바닥·열매","벌레","물고기"];
/** 도감 탭이 담는 종 범위. 규칙의 species 순서를 그대로 나눈 것이다. */
const inTab=(tab: number,index: number)=>tab===0?index<4:tab===1?index>=4&&index<8:index>=8;

/**
 * 전체 화면 뒷마당.
 *
 * 저장은 세션이, 게임 진행은 `BackyardRpg3dWorld`가, 표현은 `BackyardRpg3dScene`이
 * 소유한다. 이 컴포넌트는 셋을 잇고 HUD·패널만 그린다 — **규칙·대사·종·재생성
 * 시각을 여기서 다시 정하지 않는다.**
 *
 * **`playable`이 아니면 게임을 그리지 않는다** — 로드 실패에서 빈 마당이 보이면
 * 그것을 저장하고 싶어지는 경로가 생긴다.
 */
export function BackyardGame({ storage }: { storage: BackyardStorageBridge | null }) {
  const router=useRouter();
  const [session,setSession]=useState<RpgSessionHandle|null>(null);
  const [save,setSave]=useState<RpgSessionState>({status:"waiting_host"});
  const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),pad=useRef<HTMLDivElement>(null);
  const help=useRef<HTMLDialogElement>(null),helpButton=useRef<HTMLButtonElement>(null);
  const album=useRef<HTMLDialogElement>(null),albumButton=useRef<HTMLButtonElement>(null),albumScroll=useRef<HTMLDivElement>(null);
  const talk=useRef<HTMLDialogElement>(null),finale=useRef<HTMLDialogElement>(null),action=useRef<HTMLButtonElement>(null);
  const reset=useRef<()=>void>(()=>{});
  const world=useRef<RpgWorldHandle|null>(null);
  const walker=useRef<RpgControllerHandle|null>(null);
  const scene=useRef<ReturnType<typeof BackyardRpg3dScene.create>>(null);
  /**
   * 패널이 열려 있으면 세계 렌더와 진행을 멈춘다. 렌더 루프가 매 프레임 읽는다.
   * 같은 신호로 세계 HUD를 CSS에서 숨긴다 — 도감 패널은 투명해서(표본을 canvas가
   * 그린다) HUD를 그대로 두면 도감 글자 위에 겹쳐 보인다. React 상태가 아니라 속성으로
   * 처리해 **닫는 즉시 같은 이벤트 안에서 초점을 원래 버튼으로 돌릴 수 있다.**
   */
  const panels=useRef(false);
  const [error,setError]=useState(""),[generation,setGeneration]=useState(0),[ready,setReady]=useState(false);
  const [hud,setHud]=useState<RpgHud|null>(null);
  const [albumTab,setAlbumTab]=useState(0),[detail,setDetail]=useState<number|null>(null);
  const [today,setToday]=useState("");
  const exit=useRef(()=>{});
  const playable=save.status==="playable"?save:null;
  // writer 하나가 세션 한 세대다. 세션은 ACK마다 새 상태 객체를 알리므로
  // **상태 객체를 의존성으로 쓰면 저장마다 3D를 다시 만든다.**
  const writer=playable?.writer??null;
  const latest=useRef(playable);latest.current=playable;
  exit.current=()=>{reset.current();if(canGoBackInApp())router.back();else router.replace("/play");};
  /** 행동은 누르는 순간 발 위치에서 다시 판정한다(설계서 §7). */
  const foot=()=>walker.current?.state()??null;
  /**
   * 패널 수명 하나로 두 가지를 켠다.
   * @param open 세계 렌더·진행을 멈출 것인가(도감·완료·도움말 전부)
   * @param hide 세계 HUD를 감출 것인가 — **투명한 전체 화면 도감만** 필요하다.
   *   작은 대화창 뒤에서는 저장 상태 표시를 계속 보여야 한다(설계서 §7).
   */
  const setPanel=(open: boolean,hide: boolean)=>{panels.current=open;host.current?.toggleAttribute("data-panel",open&&hide);};

  /** 보이는 도감 카드의 표본만 같은 renderer의 scissor로 다시 그린다. */
  const drawSpecimens=useCallback(()=>{
    const root=host.current,view=scene.current,panel=albumScroll.current;
    if(!root||!view||!panel||!album.current?.open)return;
    const base=root.getBoundingClientRect(),box=panel.getBoundingClientRect();
    const cards=Array.from(panel.querySelectorAll<HTMLElement>("[data-specimen]")).map(element=>{
      const rect=element.getBoundingClientRect();
      return {index:Number(element.dataset.specimen),found:element.dataset.found==="true",
        left:rect.left-base.left,top:rect.top-base.top,width:rect.width,height:rect.height};
    });
    view.specimens(cards,{left:box.left-base.left,top:box.top-base.top,width:box.width,height:box.height});
  },[]);

  // 저장 세션. storage가 바뀌면(가구 변경·재진입) 이전 세대를 버린다 —
  // 이전 가구 응답이 새 가구에 적용되지 않아야 한다.
  useEffect(()=>{
    if(!storage){setSession(null);setSave({status:"waiting_host"});return;}
    void loadEngine().then(()=>{
      const handle=BackyardRpgSession.createSession({
        bridge:storage,
        setTimer:(fn,ms)=>window.setTimeout(fn,ms),
        clearTimer:id=>{window.clearTimeout(id);},
        onChange:next=>setSave(next),
      });
      setSession(handle);
      void handle.load();
    }).catch((e: unknown)=>{setSave({status:"load_error",message:e instanceof Error?e.message:"마당을 불러오지 못했어요"});});
  },[storage]);
  useEffect(()=>()=>{session?.destroy();},[session]);
  useEffect(()=>registerGameBack(()=>{
    reset.current();
    for(const panel of [talk,album,finale,help])if(panel.current?.open){panel.current.close();return true;}
    exit.current();return true;
  }),[]);
  useEffect(()=>{
    const root=host.current,screen=canvas.current,control=pad.current;
    // playable이 아니면 3D를 만들지 않는다. 로드 실패에서 빈 마당을 보여 주면
    // 그것을 저장하고 싶어지는 경로가 생긴다(설계서 §3).
    if(!root||!screen||!control||!writer)return;
    let disposed=false,frame=0,last: number | null=null,previous=0,digest="",listing="";
    let cleanup=()=>{};
    const originalOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const abort=new AbortController();
    const viewport=()=>{
      const v=window.visualViewport;
      root.style.width=v?`${v.width}px`:"100vw";root.style.height=v?`${v.height}px`:"100dvh";
      root.style.left=v?`${v.offsetLeft}px`:"0";root.style.top=v?`${v.offsetTop}px`:"0";
      reset.current();
    };
    viewport();window.visualViewport?.addEventListener("resize",viewport,{signal:abort.signal});window.visualViewport?.addEventListener("scroll",viewport,{signal:abort.signal});
    setReady(false);setError("");
    void loadEngine().then(()=>{
      if(disposed)return;
      const initial=latest.current;if(!initial)return;
      // 저장 좌표를 논리 평면으로 복원한다. create가 안에서 safePosition을 부르므로
      // 막힌 위치는 가장 가까운 통행 타일로 보정되고, **로드만으로 저장하지 않는다**.
      const saved=initial.data.rpg_player;
      const controller=BackyardRpg3dController.create(BackyardRpg3dController.fromSaved(saved),saved.direction);
      const stage=BackyardRpg3dScene.create(root,screen,{walking:true,outfit:saved.outfit,
        onError:e=>{setReady(false);setError(e instanceof Error?e.message:"3D 화면을 준비하지 못했어요");}});
      if(!stage)return;
      walker.current=controller;scene.current=stage;
      const content=BackyardRpg3dWorld.create({
        now:()=>Math.floor(Date.now()/1000),
        random:()=>Math.random(),
        commit:(key,value)=>latest.current?.writer.commit(key,value)??false,
        locked:()=>latest.current?.writer.getSaveState().locked!==false,
        suspended:()=>document.hidden||panels.current,
      });
      world.current=content;
      content.sync(initial.data,true);setToday(content.visit().description);
      previous=controller.state().distance;
      const input=BackyardRpgInput.create(control,value=>controller.input(value),
        ()=>!panels.current&&!talk.current?.open&&!content.busy()&&!document.hidden,
        ()=>{const state=controller.state();content.act(state,state.direction);});
      reset.current=()=>{input.reset();controller.reset();last=null;};
      const resize=()=>{
        reset.current();stage.resize();
        const state=controller.state();stage.update(state.world,state.direction,0,true);
        if(album.current?.open)drawSpecimens();
      };
      const pause=()=>{reset.current();cancelAnimationFrame(frame);if(!document.hidden)frame=requestAnimationFrame(tick);};
      const keydown=(event: KeyboardEvent)=>{
        if(event.key!=="Escape")return;
        if(talk.current?.open||album.current?.open||finale.current?.open||help.current?.open)return;
        event.preventDefault();exit.current();
      };
      document.addEventListener("visibilitychange",pause,{signal:abort.signal});window.addEventListener("blur",()=>reset.current(),{signal:abort.signal});
      window.addEventListener("resize",resize,{signal:abort.signal});window.visualViewport?.addEventListener("resize",resize,{signal:abort.signal});
      window.addEventListener("keydown",keydown,{signal:abort.signal});
      screen.addEventListener("webglcontextlost",()=>{reset.current();cancelAnimationFrame(frame);},{signal:abort.signal});
      screen.addEventListener("webglcontextrestored",()=>{setError("");setReady(true);resize();frame=requestAnimationFrame(tick);},{signal:abort.signal});
      function tick(now: number) {
        if(disposed||document.hidden)return;
        // 도감·완료·도움말이 열려 있으면 세계를 그리지 않는다. 표본만 scissor로 남는다.
        if(panels.current){last=now;frame=requestAnimationFrame(tick);return;}
        // 대화·낚시·채집 중에는 같은 프레임에서 이동 입력을 0으로 만든다(설계서 §7).
        if(content.busy()||talk.current?.open)controller.input({x:0,y:0});
        controller.frame(now);const state=controller.state();
        const delta=last===null?0:now-last;
        const snapshot=content.frame(delta,state,state.direction);
        const moving=state.distance>previous;
        stage?.update(state.world,state.direction,delta,last===null,{distance:state.distance,moving,
          sitting:snapshot.actors.some(actor=>actor.sitting),reaching:!!snapshot.gathering||snapshot.fishing.phase!=="idle"});
        stage?.content(snapshot,delta);stage?.render();
        previous=state.distance;last=now;
        root!.dataset.player=JSON.stringify(state);root!.dataset.target=snapshot.target?.id??"";
        root!.dataset.actors=JSON.stringify(snapshot.actors.map(actor=>({id:actor.id,x:Math.round(actor.x),y:Math.round(actor.y),direction:actor.direction})));
        // 검증이 규칙을 복제하지 않고 실제 활성 채집점을 읽을 수 있게 노출한다.
        const nodes=JSON.stringify(snapshot.nodes);
        if(nodes!==listing){listing=nodes;root!.dataset.nodes=nodes;}
        const next: RpgHud={hud:snapshot.hud,dialogue:snapshot.dialogue,card:snapshot.card,editing:snapshot.editing,
          chosen:snapshot.chosen,fishing:snapshot.fishing.phase,gathering:!!snapshot.gathering};
        const serialized=JSON.stringify(next);
        if(serialized!==digest){digest=serialized;setHud(next);}
        if(snapshot.completion&&!finale.current?.open){setPanel(true,false);finale.current?.showModal();}
        // 정지 1초·걷기 10초·숨김 flush는 writer가 소유한다. 프레임마다 저장하지 않는다.
        // `t`는 **벽시계 초**다. 슬라이스 4가 RAF 타임스탬프를 넣어 두었는데 규칙이 이 값을
        // 시계 역행 차단의 하한으로 쓰므로(2D도 Date.now를 저장했다) 의미를 되돌린다.
        const point=BackyardRpg3dController.toSaved(state);
        latest.current?.writer.observePlayer({v:2,mapVersion:1,x:point.x,y:point.y,direction:state.direction,outfit:saved.outfit,t:Math.floor(Date.now()/1000)},moving);
        frame=requestAnimationFrame(tick);
      }
      resize();setReady(true);frame=requestAnimationFrame(tick);
      cleanup=()=>{input.destroy();stage.dispose();scene.current=null;world.current=null;walker.current=null;};
    }).catch((e: unknown)=>{if(!disposed)setError(e instanceof Error?e.message:"마당을 불러오지 못했어요");});
    return ()=>{disposed=true;cancelAnimationFrame(frame);abort.abort();cleanup();reset.current=()=>{};document.body.style.overflow=originalOverflow;};
  },[generation,writer,drawSpecimens]);
  // **모든 emit에서** 세계를 맞춘다. `data` 신원만 보면 ACK만 알리는 emit을 놓치고,
  // 그러면 완료 표시처럼 "잠금이 풀린 뒤에 저장해야 하는" 것이 영영 저장되지 않는다.
  useEffect(()=>{
    if(save.status!=="playable"||!world.current)return;
    world.current.sync(save.data,false);setToday(world.current.visit().description);
  },[save]);
  // 대화는 규칙이 만든 문장을 그대로 띄운다. 열리는 순간 이동 입력을 버린다.
  const dialogue=hud?.dialogue??null;
  useEffect(()=>{
    if(dialogue&&!talk.current?.open){reset.current();talk.current?.showModal();}
    if(!dialogue&&talk.current?.open)talk.current.close();
  },[dialogue]);
  useEffect(()=>{if(album.current?.open)drawSpecimens();},[albumTab,detail,drawSpecimens]);

  const collection=playable?.data.rpg_collection;
  /** 저장된 표본 기록 하나를 읽는다. @param index 규칙의 species 인덱스 */
  const record=(index: number)=>{
    const tuple=collection?.species.find(t=>t.split(":")[0]==="s"+index);
    return {tuple,count:Number(tuple?.split(":")[1]??0)};
  };
  const openAlbum=()=>{
    if(!ready)return;
    reset.current();setPanel(true,true);setDetail(null);album.current?.showModal();
    // 도감이 열리면 세계 렌더를 멈추고 표본만 정적으로 그린다(설계서 §6).
    requestAnimationFrame(()=>drawSpecimens());
  };
  /** 패널을 닫으면 HUD가 돌아오고 세계 렌더가 다시 살아난다. */
  const closePanel=()=>{setPanel(false,false);scene.current?.render();};

  return <div ref={host} className={styles.game} data-backyard-game>
    <canvas ref={canvas} aria-label="뒷마당 3D 산책"/>
    <button className={styles.exit} data-exit onClick={()=>exit.current()}>마당 나가기</button>
    <button ref={albumButton} className={styles.albumButton} data-open-album onClick={openAlbum} aria-disabled={!ready}>도감</button>
    <button ref={helpButton} className={styles.help} onClick={()=>{reset.current();setPanel(true,false);help.current?.showModal();}}>도움말</button>
    {playable&&<div className={styles.fixture}>
      <span role="status" data-save>{playable.writer.getSaveState().message||(playable.writer.getSaveState().dirty?"저장 중…":"저장됨")}</span>
      {Object.values(playable.writer.getSaveState().keys).some(key=>!!key.error)&&<button data-retry-save onClick={()=>playable.writer.flush()}>저장 다시</button>}
    </div>}
    {hud&&<p className={styles.place} role="status" data-place>{hud.hud.place}</p>}
    <div ref={pad} className={styles.pad} data-pad tabIndex={0} role="group" aria-label="이동 패드. 방향키 또는 WASD로 걸어요" aria-disabled={!ready}><span/></div>
    {hud&&<div className={styles.actions}>
      <button ref={action} className={styles.action} data-action aria-disabled={hud.hud.disabled}
        onClick={()=>{const state=foot();if(state)world.current?.act(state,state.direction);}}>{hud.hud.action}</button>
      {(hud.fishing!=="idle"||hud.gathering)&&<button className={styles.cancel} data-cancel-fishing
        onClick={()=>{world.current?.cancelFishing();action.current?.focus();}}>취소하고 걷기</button>}
    </div>}
    {hud?.editing&&<section className={styles.editor} aria-label="꾸미기" data-editor>
      <div className={styles.row}>
        {([["pot","화분"],["well","우물"],["chair","의자"]] as const).map(([kind,label])=>
          <button key={kind} data-kind={kind} aria-pressed={hud.chosen===kind} onClick={()=>world.current?.choose(kind)}>{label}</button>)}
        <button data-move onClick={()=>{const state=foot();if(state)world.current?.move(state,state.direction);}}>이동</button>
        <button data-store onClick={()=>{const state=foot();if(state)world.current?.store(state,state.direction);}}>보관</button>
        <button onClick={()=>{world.current?.closeEditor();action.current?.focus();}}>닫기</button>
      </div>
      <p role="status" data-placement>{hud.hud.placement}</p>
    </section>}
    {hud&&<p className={styles.feedback} role="status" aria-live="polite" data-feedback>{hud.hud.feedback}</p>}
    {hud?.card&&<section className={styles.card} aria-label="획득 결과" data-card>
      <p role="status" data-card-text>{hud.card.name} · {playable&&(()=>{const slot=playable.writer.getSaveState().keys.rpg_collection;
        return slot.localSequence>slot.ackedSequence?(slot.error?"저장 후 계속할 수 있어요 · 다시":"저장 중"):"도감에 남겼어요";})()}</p>
      <button data-close-card onClick={()=>{world.current?.closeCard();action.current?.focus();}}>닫기</button>
    </section>}
    {save.status!=="playable"&&!error&&<div className={styles.message} role={"message" in save?"alert":"status"}>
      <p>{"message" in save?save.message:save.status==="waiting_host"?"가족 정보를 준비하고 있어요":"마당을 불러오는 중…"}</p>
      {/* 알 수 없는 버전은 재시도가 아니라 앱 업데이트다. 덮어쓰기 버튼을 두지 않는다. */}
      {save.status==="unsupported_version"?<p>앱을 업데이트해 주세요.</p>
        :"message" in save&&<button onClick={()=>{void session?.load();}}>다시</button>}
    </div>}
    {playable&&!ready&&!error&&<p className={styles.message} role="status">마당을 불러오는 중…</p>}
    {error&&<div className={styles.message} role="alert"><p>{error}</p><button onClick={()=>setGeneration(v=>v+1)}>다시 시도</button></div>}
    <dialog ref={talk} className={styles.dialog} data-dialogue
      onClose={()=>{world.current?.closeDialogue();action.current?.focus();}} onCancel={()=>reset.current()}>
      <strong>{dialogue?.title}</strong>
      <p aria-live="polite" data-dialogue-text>{dialogue?.text}</p>
      <div className={styles.row}>
        <button data-talk-next onClick={()=>{const state=foot();if(state)world.current?.converse("talk",state);}}>이야기</button>
        <button data-show-sample onClick={()=>{const state=foot();if(state)world.current?.converse("sample",state);}}>표본 보여주기</button>
        <button data-sit-together onClick={()=>{const state=foot();if(state)world.current?.converse("sit",state);}}>함께 앉기</button>
        <button data-close-dialogue onClick={()=>talk.current?.close()}>닫기</button>
      </div>
    </dialog>
    {/* 도감 표본은 같은 canvas가 그린다. 창은 투명하게 두고 텍스트·초점·스크롤만 HTML이 맡는다. */}
    <dialog ref={album} className={styles.albumPanel} aria-label="우리 마당 도감" data-album
      onClose={()=>{closePanel();albumButton.current?.focus();}}>
      <div className={styles.albumHead}><strong>우리 마당 도감</strong><button data-close-album onClick={()=>album.current?.close()}>닫기</button></div>
      <div ref={albumScroll} className={styles.albumScroll} onScroll={drawSpecimens}>
        <p>{today} · 벌레와 주민도 다른 자리를 둘러봐요</p>
        <p data-album-count>만난 생명 {collection?.species.filter(t=>Number(t.split(":")[1])>0).length??0}/16</p>
        <div className={styles.tabs} role="tablist" aria-label="도감 종류">
          {ALBUM_TABS.map((label,tab)=><button key={label} role="tab" aria-selected={albumTab===tab}
            onClick={()=>{setAlbumTab(tab);setDetail(null);}}>{label}</button>)}
        </div>
        <div className={styles.grid} role="tabpanel">
          {ready&&BackyardRpgLife.species.filter(item=>inTab(albumTab,item.index)).map(item=>{
            const kept=record(item.index);
            return <button key={item.id} className={styles.item} data-species={item.id} onClick={()=>setDetail(item.index)}>
              <span className={styles.window} data-specimen={item.index} data-found={kept.count>0} aria-hidden="true"/>
              <strong>{kept.count>0?item.name:"아직 만나지 못했어요"}</strong>
              <small>{kept.count>0?`표본 ${kept.count}개`:BackyardRpgLife.hints[item.index].trim()}</small>
            </button>;
          })}
        </div>
        {detail!==null&&ready&&<section aria-live="polite" className={styles.detail} data-album-detail>
          {(()=>{
            const kept=record(detail),item=BackyardRpgLife.species[detail];
            if(!kept.count)return <p>이곳에서 찾아봐요 · {BackyardRpgLife.hints[detail].trim()}</p>;
            const seconds=Number(kept.tuple?.split(":")[2]),when=new Date(seconds*1000);
            return <><h3>{item.name}</h3>
              <p>처음 기록한 날짜 · {Number.isNaN(when.getTime())?"날짜 범위 밖의 이전 기록":when.toLocaleDateString("ko-KR",{timeZone:"UTC"})}</p>
              <p>획득 장소 · {BackyardRpgLife.recordPlace(kept.tuple,detail)}</p>
              <p>{BackyardRpgLife.notes[detail]}</p></>;
          })()}
        </section>}
      </div>
    </dialog>
    <dialog ref={finale} className={styles.dialog} data-completion
      onClose={()=>{closePanel();world.current?.closeCompletion();action.current?.focus();}}>
      <h1>우리 마당의 작은 생명을 모두 만났어요</h1>
      <p>낚시하고, 이야기를 나누고, 마당을 꾸미며 계속 산책해요.</p>
      <button data-close-completion onClick={()=>finale.current?.close()}>계속 산책하기</button>
    </dialog>
    <dialog ref={help} className={styles.dialog} onClose={()=>{closePanel();reset.current();helpButton.current?.focus();}} onCancel={()=>reset.current()}>
      <h1>마당 산책</h1><p>왼쪽 패드나 방향키·WASD로 걸어요. 위쪽은 항상 북쪽이에요.</p>
      <p>가까이 다가가 바라보면 오른쪽 버튼으로 채집·낚시·이야기를 해요. 입질은 누를 때까지 기다려 줘요.</p>
      <p>지출 정보와 연결되지 않아요. 같은 가족의 마당은 공동 저장되며, 동시에 바꾸면 마지막 저장이 남아요.</p>
      <p>걸음을 멈추면 위치가 저장돼요. 저장이 안 되면 화면 아래에 계속 표시돼요.</p>
      <button onClick={()=>help.current?.close()}>닫기</button>
    </dialog>
  </div>;
}
