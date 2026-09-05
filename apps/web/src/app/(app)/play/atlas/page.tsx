"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 가맹점 도감 (/play/atlas)
 *
 * 방문한 곳을 수집물로 본다. "여기에 갔다"는 관측된 사실이라 등급도 점수도 매기지
 * 않고 셀 수 있다 — 게임적 재미가 판정이 아니라 **수집**에서 나오는 구조다.
 *
 * ## 정리 작업이 게임 목표가 된다
 *
 * 카드사가 잘라 보낸 이름과 표기가 갈린 이름은 **미완성 카드**로 보인다. 사용자가
 * 병합하면 카드가 완성된다. 가맹점 정리 화면이 이미 만들어 둔 병합 제안
 * (`identityCandidates`)이 그대로 퀘스트가 된다.
 *
 * 이 연결이 이 화면의 값이다. 가맹점 정리는 유용하지만 지루한 작업이고 실측에서
 * 거의 쓰이지 않았다(별칭 10건 vs 사람이 확정한 카테고리 규칙 109건). 도구가 없어서가
 * 아니라 **할 이유가 약해서**였다. 수집물이 완성되는 형태로 보이면 이유가 생긴다.
 *
 * ## 기준을 이름표로 감추지 않는다
 *
 * 3회 이상 방문한 곳을 "골드 단골" 같은 이름으로 부르지 않는다. 3이라는 값은 임의
 * 기준이므로 **"3번 이상 간 곳"이라고 조건을 그대로 적는다** — 사용자가 기준을 알고
 * 읽어야 숫자를 자기 것으로 판단할 수 있다.
 * ------------------------------------------------------------------------- */
import { Sparkles, Store } from "lucide-react";
import { useMemo } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ListRow, PageBackHeader } from "@/components/widgets";
import { transactionsHref } from "@/lib/deep-link";
import { currentMonth, formatWon } from "@/lib/format";
import {
  atlasBrands,
  newlyDiscovered,
  regularMerchants,
  summarizeAtlas,
  REGULAR_MIN_VISITS,
} from "@/lib/atlas";
import { useMerchantList } from "@/lib/queries";

/** 목록이 길어지면 도감이 아니라 표가 된다 — 상위 몇 개만 보여주고 나머지는 정리 화면으로. */
const SHOW_N = 8;

export default function AtlasPage() {
  const { data, isLoading, isError } = useMerchantList();
  const items = useMemo(() => data?.items ?? [], [data]);
  const month = currentMonth();

  const summary = useMemo(() => summarizeAtlas(items), [items]);
  const fresh = useMemo(() => newlyDiscovered(items, month), [items, month]);
  const regulars = useMemo(() => regularMerchants(items), [items]);
  const brands = useMemo(() => atlasBrands(items), [items]);
  // 미완성 카드 = 가맹점 정리 화면이 이미 계산해 둔 병합 후보. 서버가 내려준다.
  const incomplete = data?.identityCandidates ?? [];

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <PageBackHeader title="가맹점 도감" />
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            가맹점을 불러오지 못했어요
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PageBackHeader
        title="가맹점 도감"
        subtitle="카드 문자로 발견한 곳들이에요"
      />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          <Card>
            <CardContent className="flex items-stretch justify-between gap-2 text-center">
              <Stat label="발견한 곳" value={`${summary.discovered}곳`} />
              <Stat
                label={`${REGULAR_MIN_VISITS}번 이상`}
                value={`${summary.regulars}곳`}
              />
              <Stat label="한 번만" value={`${summary.onceOnly}곳`} />
            </CardContent>
          </Card>

          {fresh.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-muted-foreground px-1 text-[13px] font-semibold">
                이번 달 새로 간 곳 {fresh.length}
              </h2>
              <Card className="divide-border divide-y overflow-hidden p-0">
                {fresh.slice(0, SHOW_N).map((mm) => (
                  <ListRow
                    key={mm.name}
                    href={transactionsHref({ month, q: mm.name })}
                    icon={<Sparkles />}
                    title={mm.name}
                    subtitle={
                      mm.firstTransactionAt
                        ? `${mm.firstTransactionAt.slice(5, 10).replace("-", "/")} 처음`
                        : undefined
                    }
                    value={formatWon(mm.netTotal)}
                    chevron
                  />
                ))}
              </Card>
            </section>
          ) : null}

          {incomplete.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-muted-foreground px-1 text-[13px] font-semibold">
                미완성 카드 {incomplete.length}장
              </h2>
              {/* 병합은 여기서 하지 않는다 — 확정은 가맹점 정리 화면이 소유한다.
                  같은 확정을 두 곳에서 할 수 있게 하면 근거 표시와 되돌리기가
                  갈린다. 여기는 "정리할 것이 있다"를 보여주고 보낸다. */}
              <Card className="space-y-3 p-4">
                <p className="text-sm">
                  같은 곳인데 이름이 나뉘어 있어요. 묶으면 카드가 하나로 합쳐져요.
                </p>
                <div className="space-y-1.5">
                  {incomplete.slice(0, SHOW_N).map((g) => (
                    <p
                      key={`${g.reason}-${g.canonical}`}
                      className="text-muted-foreground truncate text-xs"
                    >
                      <span className="text-foreground font-medium">
                        {g.canonical}
                      </span>
                      {" ← "}
                      {g.aliases.join(" · ")}
                    </p>
                  ))}
                </div>
                <Link
                  href="/more/merchants"
                  className="text-primary inline-block text-sm font-medium underline-offset-2 hover:underline"
                >
                  가맹점 정리에서 묶기
                </Link>
              </Card>
            </section>
          ) : null}

          {brands.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-muted-foreground px-1 text-[13px] font-semibold">
                브랜드 배지 {brands.length}
              </h2>
              <Card className="flex flex-wrap gap-2 p-4">
                {brands.map((b) => (
                  <Badge
                    key={b.brand}
                    variant="secondary"
                    className="gap-1.5 py-1"
                  >
                    {b.brand}
                    <span className="text-muted-foreground tabular-nums">
                      {b.visitCount}
                    </span>
                  </Badge>
                ))}
              </Card>
            </section>
          ) : null}

          <section className="space-y-2">
            <h2 className="text-muted-foreground px-1 text-[13px] font-semibold">
              {REGULAR_MIN_VISITS}번 이상 간 곳
            </h2>
            {regulars.length === 0 ? (
              <Card className="p-8 text-center">
                <Store className="text-muted-foreground mx-auto mb-3 size-8" />
                <p className="text-sm font-medium">아직 단골이 없어요</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  같은 곳을 {REGULAR_MIN_VISITS}번 가면 여기 모여요
                </p>
              </Card>
            ) : (
              <Card className="divide-border divide-y overflow-hidden p-0">
                {regulars.slice(0, SHOW_N).map((mm) => (
                  <ListRow
                    key={mm.name}
                    href={transactionsHref({ q: mm.name })}
                    icon={<Store />}
                    title={mm.name}
                    subtitle={`${mm.transactionCount}번 방문`}
                    value={formatWon(mm.netTotal)}
                    chevron
                  />
                ))}
              </Card>
            )}
            {regulars.length > SHOW_N ? (
              <p className="text-muted-foreground px-1 text-xs">
                외 {regulars.length - SHOW_N}곳 — 전체는 가맹점 정리에서 볼 수 있어요
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{label}</p>
    </div>
  );
}
