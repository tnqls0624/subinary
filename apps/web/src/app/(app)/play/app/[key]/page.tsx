"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 미니앱 실행 화면 (/play/app/[key])
 *
 * 등록부의 미니앱 하나를 iframe으로 띄우고 **브릿지 요청을 실제 데이터에 연결한다.**
 *
 * ## 이 화면이 데이터 경계다
 *
 * 미니앱은 격리돼 있어 스스로 아무것도 못 하고, 여기 있는 핸들러가 주는 것만 받는다.
 * 그래서 핸들러는 **필요한 만큼만** 준다 — `merchant.list`가 이름·건수·합계만 주고
 * 개별 거래를 주지 않는 것이 그 예다. 브릿지 계약이 그렇게 좁혀져 있고, 여기서도
 * 그 이상을 만들지 않는다.
 *
 * ## 상태 저장은 미니앱 키로 격리된다
 *
 * `state.*`는 `play_states`에 `app_key = 미니앱 키`로 저장된다. 미니앱이 키를 지정할
 * 수 없으므로 다른 미니앱의 상태를 읽거나 덮을 수 없다. 권한을 요구하지 않는 이유다.
 * ------------------------------------------------------------------------- */
import { useParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { Card } from "@/components/ui/card";
import { PageBackHeader } from "@/components/widgets";
import { MiniappHost, type MiniappHandler } from "@/components/miniapp/miniapp-host";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { findMiniapp } from "@/lib/miniapp-registry";
import type { MiniappMethod } from "@family/shared";

export default function MiniappPage() {
  const params = useParams<{ key: string }>();
  const manifest = findMiniapp(params.key);
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();

  const handlers = useMemo<Partial<Record<MiniappMethod, MiniappHandler>>>(() => {
    if (!householdId) return {};
    const hid = householdId;
    const appKey = manifest?.key ?? "";

    return {
      "host.info": async () => ({ appKey, permissions: manifest?.permissions ?? [] }),

      /**
       * 가맹점 집계 — **이름·건수·합계만** 준다.
       *
       * 목록 API는 별칭·카테고리·마지막 방문까지 주지만 그것을 그대로 넘기지 않는다.
       * 미니앱이 필요로 하지 않는 값을 주면 나중에 그것을 쓰는 미니앱이 생기고,
       * 그때는 줄일 수 없다.
       *
       * 서버가 이미 공개범위를 적용하므로(`redactedMerchantLabel`) 타인의 private
       * 가맹점명은 여기 도달하지 않는다.
       */
      "merchant.list": async () => {
        const res = await authedFetch((token) => api.merchants.list(token, hid));
        return {
          items: res.items
            .filter((m) => m.transactionCount > 0)
            .map((m) => ({
              name: m.name,
              count: m.transactionCount,
              netTotal: m.netTotal,
            })),
        };
      },

      "state.get": async (p) => {
        const key = typeof p.key === "string" ? p.key : null;
        if (!key) throw new Error("key가 필요해요");
        const res = await authedFetch((token) =>
          api.play.list(token, hid, appKey),
        );
        const found = res.items.find((i) => i.stateKey === key);
        return { state: found?.state ?? null };
      },

      "state.set": async (p) => {
        const key = typeof p.key === "string" ? p.key : null;
        const state = p.state;
        if (!key) throw new Error("key가 필요해요");
        if (typeof state !== "object" || state === null || Array.isArray(state)) {
          throw new Error("state는 객체여야 해요");
        }
        await authedFetch((token) =>
          api.play.save(token, appKey, key, {
            householdId: hid,
            state: state as Record<string, unknown>,
          }),
        );
        return { ok: true };
      },

      "state.remove": async (p) => {
        const key = typeof p.key === "string" ? p.key : null;
        if (!key) throw new Error("key가 필요해요");
        const res = await authedFetch((token) =>
          api.play.remove(token, hid, appKey, key),
        );
        return res;
      },
    };
  }, [householdId, manifest, authedFetch]);

  const noop = useCallback(() => undefined, []);
  void noop;

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
      <PageBackHeader title={manifest.name} subtitle={manifest.description} />
      <MiniappHost
        appKey={manifest.key}
        src={manifest.entry}
        permissions={manifest.permissions}
        handlers={handlers}
        height={manifest.height}
        title={manifest.name}
      />
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
