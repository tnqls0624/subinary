"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import { PageBackHeader } from "@/components/widgets";
import { BackyardGame } from "@/components/miniapp/backyard-game";
import Link from "next/link";
import { MiniappHost } from "@/components/miniapp/miniapp-host";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { findMiniapp } from "@/lib/miniapp-registry";
import { createMiniappStateHandlers } from "@/lib/miniapp-host";
import { createBackyardStorage } from "@/lib/backyard-storage";

/**
 * `useSearchParams`는 Suspense 경계를 요구한다(정적 export 포함) — 이 저장소의
 * 다른 화면과 같은 형태로 맞춘다.
 */
export default function MiniappPage() {
  return (
    <Suspense fallback={null}>
      <MiniappView />
    </Suspense>
  );
}

function MiniappView() {
  // 동적 라우트(`/play/app/[key]`)를 쓰지 않는 이유: 정적 export가 그것을 만들려면
  // `generateStaticParams()`가 필요하고, 그러면 미니앱을 추가할 때마다 라우트를
  // 다시 생성해야 한다 — "번들만 올리면 된다"는 이 구조의 목적과 어긋난다.
  // 쿼리 파라미터는 이 저장소가 이미 쓰는 방식이다(`?month=`, `?txn=`).
  const key = useSearchParams().get("key") ?? "";
  const manifest = findMiniapp(key);
  const { householdId } = useHousehold();
  const { authedFetch, status } = useAuth();

  const handlers = useMemo(() => {
    if (!householdId || !manifest || manifest.execution === "backyard") return {};
    return createMiniappStateHandlers(householdId, manifest.key, manifest.permissions, {
      list: (hid, appKey) => authedFetch((token) => api.play.list(token, hid, appKey)),
      save: (hid, appKey, key, state) => authedFetch((token) => api.play.save(token, appKey, key, { householdId: hid, state })),
      remove: (hid, appKey, key) => authedFetch((token) => api.play.remove(token, hid, appKey, key)),
    });
  }, [householdId, manifest, authedFetch]);

  // 가구·앱을 캡처한 직접 저장 어댑터. 가구가 바뀌면 새로 만들고 이전 것을 버린다 —
  // 이미 시작한 요청은 캡처한 가구로만 끝난다(설계서 §3).
  const backyardStorage = useMemo(() => {
    if (!householdId || !manifest || manifest.execution !== "backyard") return null;
    return createBackyardStorage({
      householdId, appKey: manifest.key,
      isReady: () => status === "authenticated",
      store: {
        list: (hid, appKey) => authedFetch((token) => api.play.list(token, hid, appKey)),
        save: (hid, appKey, key, state) => authedFetch((token) => api.play.save(token, appKey, key, { householdId: hid, state })),
      },
    });
  }, [householdId, manifest, authedFetch, status]);

  if (!manifest) return <main className="min-h-dvh p-6"><p>없는 미니앱이에요</p><Link className="inline-flex min-h-11 items-center" href="/play">미니앱 목록으로</Link></main>;
  if (manifest.execution === "backyard") return <BackyardGame key={householdId} storage={backyardStorage}/>;
  return <main className="min-h-dvh p-4">
    <PageBackHeader title={manifest.name}/>
    {householdId && status === "authenticated" && <MiniappHost appKey={manifest.key} src={manifest.entry} permissions={manifest.permissions} handlers={handlers} height={manifest.height} title={manifest.name}/>}
  </main>;
}
