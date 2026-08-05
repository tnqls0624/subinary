"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 가맹점 정리 (/more/merchants)
 *
 * 같은 가게가 여러 이름으로 쪼개진 것을 사용자가 하나로 묶는 화면이다.
 * `normalizeMerchant`가 괄호·법인격·지점 접미사는 정리하지만, 로마자↔한글 음차
 * (`GS25` vs `지에스25`)와 카드사가 **잘라 보낸 이름**(`주식회사우아한형` vs
 * `우아한형제들`)은 규칙으로 합칠 수 없다 — 사람만 아는 판단이라 여기서 받는다.
 *
 * 묶으면 서버가 과거 거래와 카테고리 규칙까지 대표 이름으로 백필하므로, 그동안
 * 파편마다 따로 학습됐던 카테고리가 하나로 모인다(실측: GS25가 6개 키로 쪼개져
 * 장보기 1 / 식비 5로 갈려 있었다).
 *
 * 체크박스 프리미티브가 없어 선택은 행 토글(테두리 강조 + 체크 아이콘)로 표현한다.
 * ------------------------------------------------------------------------- */
import { Check, Link2Off, Store } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { PageBackHeader } from "@/components/widgets";
import { formatWon } from "@/lib/format";
import {
  useCreateMerchantAliases,
  useDeleteMerchantAlias,
  useMerchantList,
} from "@/lib/queries";
import type { MerchantSummary } from "@family/contracts";

export default function MerchantsPage() {
  const { data, isLoading, isError } = useMerchantList();
  const createAliases = useCreateMerchantAliases();
  const deleteAlias = useDeleteMerchantAlias();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickOpen, setPickOpen] = useState(false);
  const [canonical, setCanonical] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<MerchantSummary | null>(null);

  const items = data?.items ?? [];
  // 별칭 행은 이미 묶인 것이라 선택 대상이 아니다(대표를 바꾸려면 먼저 해제).
  const selectable = items.filter((m) => m.aliasOf === null);
  const aliasRows = items.filter((m) => m.aliasOf !== null);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const openPicker = () => {
    const names = [...selected];
    if (names.length < 2) return;
    // 기본 대표는 지출이 가장 큰 이름 — 대개 가장 온전한 표기다.
    const byTotal = selectable
      .filter((m) => selected.has(m.name))
      .sort((a, b) => b.netTotal - a.netTotal);
    setCanonical(byTotal[0]?.name ?? names[0]);
    setPickOpen(true);
  };

  const submit = () => {
    if (!canonical) return;
    const aliases = [...selected].filter((n) => n !== canonical);
    if (aliases.length === 0) return;
    createAliases.mutate(
      { canonical, aliases },
      {
        onSuccess: (res) => {
          setPickOpen(false);
          setSelected(new Set());
          setCanonical(null);
          toast.success(
            `‘${res.canonical}’으로 묶었어요`,
            {
              description: `거래 ${res.transactionsUpdated}건을 옮기고 중복 카테고리 규칙 ${res.rulesMerged}개를 정리했어요`,
            },
          );
        },
        onError: () => toast.error("묶는 데 실패했어요. 잠시 후 다시 시도해 주세요"),
      },
    );
  };

  const unlink = () => {
    const target = unlinkTarget;
    if (!target?.aliasId) return;
    deleteAlias.mutate(target.aliasId, {
      onSuccess: (res) => {
        setUnlinkTarget(null);
        toast.success(`‘${res.alias}’ 묶음을 풀었어요`, {
          description:
            res.transactionsReverted > 0
              ? `거래 ${res.transactionsReverted}건이 원래 이름으로 돌아갔어요`
              : "되돌릴 거래는 없었어요",
        });
      },
      onError: () => toast.error("묶음을 푸는 데 실패했어요"),
    });
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PageBackHeader
        title="가맹점 정리"
        subtitle="같은 가게가 여러 이름으로 나뉘어 있으면 하나로 묶어요"
      />

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            가맹점을 불러오지 못했어요
          </p>
        </Card>
      ) : items.length === 0 ? (
        <Card className="p-8 text-center">
          <Store className="text-muted-foreground mx-auto mb-3 size-8" />
          <p className="text-sm font-medium">아직 가맹점이 없어요</p>
          <p className="text-muted-foreground mt-1 text-sm">
            카드 문자가 쌓이면 여기에 나타나요
          </p>
        </Card>
      ) : (
        <>
          <Card className="divide-border divide-y overflow-hidden p-0">
            {selectable.map((m) => {
              const isSelected = selected.has(m.name);
              return (
                <button
                  key={m.name}
                  type="button"
                  onClick={() => toggle(m.name)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                    isSelected ? "bg-accent/40" : "hover:bg-muted/50"
                  }`}
                >
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                      isSelected
                        ? "border-foreground bg-foreground text-background"
                        : "border-border"
                    }`}
                  >
                    {isSelected ? <Check className="size-4" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {m.name}
                      </span>
                      {m.categoryName ? (
                        <Badge variant="secondary" className="shrink-0">
                          {m.categoryName}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {m.transactionCount}건
                      {m.aliases.length > 0
                        ? ` · 다른 이름 ${m.aliases.length}개를 묶었어요`
                        : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {formatWon(m.netTotal)}
                  </span>
                </button>
              );
            })}
          </Card>

          {aliasRows.length > 0 ? (
            <div className="space-y-2">
              <p className="text-muted-foreground px-1 text-xs font-medium">
                묶인 이름 {aliasRows.length}개
              </p>
              <Card className="divide-border divide-y overflow-hidden p-0">
                {aliasRows.map((m) => (
                  <div
                    key={m.name}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <Link2Off className="text-muted-foreground size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="text-muted-foreground block truncate text-sm line-through">
                        {m.name}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-xs">
                        → {m.aliasOf}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setUnlinkTarget(m)}
                    >
                      풀기
                    </Button>
                  </div>
                ))}
              </Card>
            </div>
          ) : null}
        </>
      )}

      {/* 선택 액션 바 — 2개 이상 골랐을 때만 뜬다(하단 탭 위로 띄움). */}
      {selected.size >= 2 ? (
        <div className="fixed inset-x-0 bottom-20 z-30 px-4">
          <div className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-2xl border bg-background/95 p-3 shadow-lg backdrop-blur">
            <span className="flex-1 pl-1 text-sm">
              {selected.size}개를 골랐어요
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              취소
            </Button>
            <Button size="sm" onClick={openPicker}>
              같은 가게로 묶기
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>어떤 이름을 대표로 할까요?</DialogTitle>
            <DialogDescription>
              고른 이름의 지난 거래와 카테고리가 모두 대표 이름으로 모여요
            </DialogDescription>
          </DialogHeader>
          <div className="divide-border max-h-72 divide-y overflow-y-auto rounded-xl border">
            {[...selected].map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setCanonical(name)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                  canonical === name ? "bg-accent/40" : "hover:bg-muted/50"
                }`}
              >
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                    canonical === name
                      ? "border-foreground bg-foreground text-background"
                      : "border-border"
                  }`}
                >
                  {canonical === name ? <Check className="size-3" /> : null}
                </span>
                <span className="truncate text-sm">{name}</span>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPickOpen(false)}>
              그만두기
            </Button>
            <Button
              onClick={submit}
              disabled={!canonical || createAliases.isPending}
            >
              {createAliases.isPending ? "묶는 중…" : "이걸로 묶기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={unlinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>이 묶음을 풀까요?</AlertDialogTitle>
            <AlertDialogDescription>
              ‘{unlinkTarget?.name}’이 원래 이름으로 돌아가고, 해당 거래도 다시
              분리돼요
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>그만두기</AlertDialogCancel>
            <AlertDialogAction
              onClick={unlink}
              disabled={deleteAlias.isPending}
            >
              풀기
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
