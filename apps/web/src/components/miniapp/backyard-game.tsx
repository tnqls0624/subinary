/// <reference path="../../../public/miniapps/backyard/rpg3d-scene.js" />
/// <reference path="../../../public/miniapps/backyard/rpg3d-controller.js" />
/// <reference path="../../../public/miniapps/backyard/rpg-input.js" />
"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { canGoBackInApp } from "@/lib/nav-history";
import { registerGameBack } from "@/lib/game-navigation";
import styles from "./backyard-game.module.css";

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
/** 전체 화면 걷기 fixture. 저장 writer는 후속 슬라이스에서 연결한다. */
export function BackyardGame() {
  const router=useRouter();
  const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),pad=useRef<HTMLDivElement>(null);
  const help=useRef<HTMLDialogElement>(null),helpButton=useRef<HTMLButtonElement>(null);
  const reset=useRef<()=>void>(()=>{});
  const [error,setError]=useState(""),[generation,setGeneration]=useState(0),[ready,setReady]=useState(false);
  const exit=useRef(()=>{});
  exit.current=()=>{reset.current();if(canGoBackInApp())router.back();else router.replace("/play");};
  useEffect(()=>registerGameBack(()=>{
    reset.current();
    if(help.current?.open){help.current.close();helpButton.current?.focus();return true;}
    exit.current();return true;
  }),[]);
  useEffect(()=>{
    const root=host.current,screen=canvas.current,control=pad.current;
    if(!root||!screen||!control)return;
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
      const controller=BackyardRpg3dController.create();
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
        frame=requestAnimationFrame(tick);
      }
      resize();setReady(true);frame=requestAnimationFrame(tick);
      cleanup=()=>{input.destroy();scene.dispose();};
    }).catch((e: unknown)=>{if(!disposed)setError(e instanceof Error?e.message:"마당을 불러오지 못했어요");});
    return ()=>{disposed=true;cancelAnimationFrame(frame);abort.abort();cleanup();reset.current=()=>{};document.body.style.overflow=originalOverflow;};
  },[generation]);
  return <div ref={host} className={styles.game} data-backyard-game>
    <canvas ref={canvas} aria-label="뒷마당 3D 산책"/>
    <button className={styles.exit} onClick={()=>exit.current()}>마당 나가기</button>
    <button ref={helpButton} className={styles.help} onClick={()=>{reset.current();help.current?.showModal();}}>도움말</button>
    <div className={styles.fixture}>산책 미리보기 · 위치는 저장되지 않아요</div>
    <div ref={pad} className={styles.pad} tabIndex={0} role="group" aria-label="이동 패드. 방향키 또는 WASD로 걸어요" aria-disabled={!ready}><span/></div>
    {!ready&&!error&&<p className={styles.message} role="status">마당을 불러오는 중…</p>}
    {error&&<div className={styles.message} role="alert"><p>{error}</p><button onClick={()=>setGeneration(v=>v+1)}>다시 시도</button></div>}
    <dialog ref={help} className={styles.dialog} onClose={()=>{reset.current();helpButton.current?.focus();}} onCancel={()=>reset.current()}>
      <h1>마당 산책</h1><p>왼쪽 패드나 방향키·WASD로 걸어요. 위쪽은 항상 북쪽이에요.</p>
      <p>지출 정보와 연결되지 않아요. 같은 가족의 마당은 공동 저장되며, 동시에 바꾸면 마지막 저장이 남아요.</p>
      <p>지금은 산책 미리보기예요. 위치 변경은 저장되지 않아요.</p>
      <button onClick={()=>help.current?.close()}>닫기</button>
    </dialog>
  </div>;
}
