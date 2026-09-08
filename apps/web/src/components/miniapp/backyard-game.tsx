/// <reference path="../../../public/miniapps/backyard/rpg3d-scene.js" />
/// <reference path="../../../public/miniapps/backyard/rpg3d-controller.js" />
/// <reference path="../../../public/miniapps/backyard/rpg-input.js" />
/// <reference path="../../../public/miniapps/backyard/rpg-session.js" />
/// <reference path="../../../public/miniapps/backyard/rpg-codec.js" />
"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { canGoBackInApp } from "@/lib/nav-history";
import { registerGameBack } from "@/lib/game-navigation";
import type { BackyardStorageBridge } from "@/lib/backyard-storage";
import styles from "./backyard-game.module.css";

type RpgSessionState = ReturnType<ReturnType<typeof BackyardRpgSession.createSession>["getState"]>;
type RpgSessionHandle = ReturnType<typeof BackyardRpgSession.createSession>;

let loading: Promise<void> | null=null;
/** 동봉 파일만 순서대로 한 번 로드한다. 실패한 파일은 재시도한다. */
function loadEngine(): Promise<void> {
  if(loading)return loading;
  loading=(async()=>{
    for(const name of ["vendor/three-r128.min.js","backyard/rpg-rules.js","backyard/rpg3d-terrain.js","backyard/rpg3d-controller.js","backyard/rpg-input.js","backyard/rpg3d-scene.js"]){
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
/**
 * 전체 화면 뒷마당.
 *
 * 저장은 세션이 소유한다. 이 컴포넌트는 세션 상태에 따라 화면을 가르고, 걷는 동안
 * `observePlayer`로 위치를 흘려보낼 뿐이다. **`playable`이 아니면 게임을 그리지 않는다** —
 * 로드 실패에서 빈 마당이 보이면 그것을 저장하고 싶어지는 경로가 생긴다.
 */
export function BackyardGame({ storage }: { storage: BackyardStorageBridge | null }) {
  const router=useRouter();
  const [session,setSession]=useState<RpgSessionHandle|null>(null);
  const [save,setSave]=useState<RpgSessionState>({status:"waiting_host"});
  const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),pad=useRef<HTMLDivElement>(null);
  const help=useRef<HTMLDialogElement>(null),helpButton=useRef<HTMLButtonElement>(null);
  const reset=useRef<()=>void>(()=>{});
  const [error,setError]=useState(""),[generation,setGeneration]=useState(0),[ready,setReady]=useState(false);
  const exit=useRef(()=>{});
  exit.current=()=>{reset.current();if(canGoBackInApp())router.back();else router.replace("/play");};
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
    if(help.current?.open){help.current.close();helpButton.current?.focus();return true;}
    exit.current();return true;
  }),[]);
  const playable=save.status==="playable"?save:null;
  useEffect(()=>{
    const root=host.current,screen=canvas.current,control=pad.current;
    // playable이 아니면 3D를 만들지 않는다. 로드 실패에서 빈 마당을 보여 주면
    // 그것을 저장하고 싶어지는 경로가 생긴다(설계서 §3).
    if(!root||!screen||!control||!playable)return;
    let disposed=false,frame=0,last: number | null=null;
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
      // 저장 좌표를 논리 평면으로 복원한다. 막힌 위치는 가장 가까운 통행 타일로
      // 보정하되 **로드만으로 그 보정을 저장하지 않는다**(설계서 §5).
      // 저장 좌표를 논리 평면으로 복원한다. create가 안에서 safePosition을 부르므로
      // 막힌 위치는 가장 가까운 통행 타일로 보정되고, **로드만으로 저장하지 않는다**.
      // 방향 복원은 controller.create가 받지 않는다 — 저장은 되고 복원은 fixture
      // 방향으로 시작한다. 알려진 한계이며 슬라이스 5 이후에 넓힐 수 있다.
      const saved=playable.data.rpg_player;
      const controller=BackyardRpg3dController.create(BackyardRpg3dController.fromSaved(saved));
      const scene=BackyardRpg3dScene.create(root,screen,{walking:true,onError:e=>{setReady(false);setError(e instanceof Error?e.message:"3D 화면을 준비하지 못했어요");}});
      if(!scene)return;
      const input=BackyardRpgInput.create(control,value=>controller.input(value),()=>!help.current?.open&&!document.hidden,()=>controller.target());
      reset.current=()=>{input.reset();controller.reset();last=null;};
      const resize=()=>{reset.current();scene.resize();scene.update(controller.state().world,controller.state().direction,0,true);};
      const pause=()=>{reset.current();cancelAnimationFrame(frame);if(!document.hidden)frame=requestAnimationFrame(tick);};
      const keydown=(event: KeyboardEvent)=>{if(event.key==="Escape"&&!help.current?.open){event.preventDefault();exit.current();}};
      document.addEventListener("visibilitychange",pause,{signal:abort.signal});window.addEventListener("blur",()=>reset.current(),{signal:abort.signal});
      window.addEventListener("resize",resize,{signal:abort.signal});window.visualViewport?.addEventListener("resize",resize,{signal:abort.signal});
      window.addEventListener("keydown",keydown,{signal:abort.signal});
      screen.addEventListener("webglcontextlost",()=>{reset.current();cancelAnimationFrame(frame);},{signal:abort.signal});
      screen.addEventListener("webglcontextrestored",()=>{setError("");setReady(true);resize();frame=requestAnimationFrame(tick);},{signal:abort.signal});
      function tick(now: number) {
        if(disposed||document.hidden)return;
        controller.frame(now);const state=controller.state();
        scene?.update(state.world,state.direction,last===null?0:now-last,last===null);scene?.render();last=now;
        root!.dataset.player=JSON.stringify(state);root!.dataset.target=controller.target()?.id??"";
        // 정지 1초·걷기 10초·숨김 flush는 writer가 소유한다. 프레임마다 저장하지 않는다.
        const point=BackyardRpg3dController.toSaved(state);
        playable!.writer.observePlayer({v:2,mapVersion:1,x:point.x,y:point.y,direction:state.direction,outfit:saved.outfit,t:Math.floor(now/1000)},state.distance>0);
        frame=requestAnimationFrame(tick);
      }
      resize();setReady(true);frame=requestAnimationFrame(tick);
      cleanup=()=>{input.destroy();scene.dispose();};
    }).catch((e: unknown)=>{if(!disposed)setError(e instanceof Error?e.message:"마당을 불러오지 못했어요");});
    return ()=>{disposed=true;cancelAnimationFrame(frame);abort.abort();cleanup();reset.current=()=>{};document.body.style.overflow=originalOverflow;};
  },[generation,playable]);
  return <div ref={host} className={styles.game} data-backyard-game>
    <canvas ref={canvas} aria-label="뒷마당 3D 산책"/>
    <button className={styles.exit} onClick={()=>exit.current()}>마당 나가기</button>
    <button ref={helpButton} className={styles.help} onClick={()=>{reset.current();help.current?.showModal();}}>도움말</button>
    {playable&&<div className={styles.fixture}>{playable.writer.getSaveState().message||(playable.writer.getSaveState().dirty?"저장 중…":"저장됨")}</div>}
    <div ref={pad} className={styles.pad} tabIndex={0} role="group" aria-label="이동 패드. 방향키 또는 WASD로 걸어요" aria-disabled={!ready}><span/></div>
    {save.status!=="playable"&&!error&&<div className={styles.message} role={"message" in save?"alert":"status"}>
      <p>{"message" in save?save.message:save.status==="waiting_host"?"가족 정보를 준비하고 있어요":"마당을 불러오는 중…"}</p>
      {/* 알 수 없는 버전은 재시도가 아니라 앱 업데이트다. 덮어쓰기 버튼을 두지 않는다. */}
      {save.status==="unsupported_version"?<p>앱을 업데이트해 주세요.</p>
        :"message" in save&&<button onClick={()=>{void session?.load();}}>다시</button>}
    </div>}
    {playable&&!ready&&!error&&<p className={styles.message} role="status">마당을 불러오는 중…</p>}
    {error&&<div className={styles.message} role="alert"><p>{error}</p><button onClick={()=>setGeneration(v=>v+1)}>다시 시도</button></div>}
    <dialog ref={help} className={styles.dialog} onClose={()=>{reset.current();helpButton.current?.focus();}} onCancel={()=>reset.current()}>
      <h1>마당 산책</h1><p>왼쪽 패드나 방향키·WASD로 걸어요. 위쪽은 항상 북쪽이에요.</p>
      <p>지출 정보와 연결되지 않아요. 같은 가족의 마당은 공동 저장되며, 동시에 바꾸면 마지막 저장이 남아요.</p>
      <p>걸음을 멈추면 위치가 저장돼요. 저장이 안 되면 화면 아래에 계속 표시돼요.</p>
      <button onClick={()=>help.current?.close()}>닫기</button>
    </dialog>
  </div>;
}
