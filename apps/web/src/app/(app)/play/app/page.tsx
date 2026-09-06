"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 미니앱 실행 화면 (/play/app?key=backyard)
 *
 * 등록부의 미니앱 하나를 iframe으로 띄우고 **브릿지 요청을 실제 데이터에 연결한다.**
 *
 * ## 이 화면이 데이터 경계다
 *
 * 미니앱은 격리돼 있어 스스로 아무것도 못 하고, 여기 있는 핸들러가 주는 것만 받는다.
 * 핸들러는 호스트 정보와 자기 상태만 제공한다. 뒷마당은 지출 권한을 요구하지 않는다.
 *
 * ## 상태 저장은 미니앱 키로 격리된다
 *
 * `state.*`는 `play_states`에 `app_key = 미니앱 키`로 저장된다. 미니앱이 키를 지정할
 * 수 없으므로 다른 미니앱의 상태를 읽거나 덮을 수 없다. 권한을 요구하지 않는 이유다.
 * ------------------------------------------------------------------------- */
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import { Card } from "@/components/ui/card";
import { PageBackHeader } from "@/components/widgets";
import { BackyardViewport } from "@/components/miniapp/backyard-viewport";
import { MiniappHost } from "@/components/miniapp/miniapp-host";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { findMiniapp } from "@/lib/miniapp-registry";
import { createMiniappStateHandlers } from "@/lib/miniapp-host";

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
    if (!householdId || !manifest) return {};
    return createMiniappStateHandlers(householdId, manifest.key, manifest.permissions, {
      list: (hid, appKey) => authedFetch((token) => api.play.list(token, hid, appKey)),
      save: (hid, appKey, key, state) => authedFetch((token) => api.play.save(token, appKey, key, { householdId: hid, state })),
      remove: (hid, appKey, key) => authedFetch((token) => api.play.remove(token, hid, appKey, key)),
    });
  }, [householdId, manifest, authedFetch]);

  if (!manifest) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <PageBackHeader title="미니앱" />
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">없는 미니앱이에요</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      {manifest.key !== "backyard" && <PageBackHeader title={manifest.name} subtitle={manifest.description} />}
      {householdId && status === "authenticated" ? manifest.key === "backyard" ? <BackyardViewport
        key={`${householdId}:${manifest.key}`}
        appKey={manifest.key} src={manifest.entry} permissions={manifest.permissions}
        handlers={handlers} title={manifest.name} subtitle={manifest.description}
        height={manifest.height}
      /> : <MiniappHost
        key={`${householdId}:${manifest.key}`}
        appKey={manifest.key}
        src={manifest.entry}
        permissions={manifest.permissions}
        handlers={handlers}
        height={manifest.height}
        title={manifest.name}
      /> : <p className="text-muted-foreground text-sm">가족 정보를 준비하고 있어요</p>}
      {/* 미니앱이 무엇을 볼 수 있는지 사용자에게 알린다. 격리는 기술적 사실이지만,
          "이 게임이 내 지출을 본다"는 것은 사용자가 알아야 할 사실이다. */}
      <p className="text-muted-foreground px-1 text-xs">
        이 미니앱은 별도 화면에서 격리 실행되고,{" "}
        {manifest.permissions.length === 0
          ? "지출 정보를 보지 않아요."
          : `${manifest.permissions.join(" · ")} 만 볼 수 있어요.`}
      </p>
    </div>
  );
}
