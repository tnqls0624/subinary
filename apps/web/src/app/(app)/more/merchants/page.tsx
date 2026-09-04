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
 *
 * ## 제안 블록 (2026-08-21)
 *
 * 도구는 잘 동작했는데 거의 쓰이지 않았다 — 실측 별칭 4행 vs 사람이 확정한 카테고리
 * 규칙 85행. 원인은 도구가 아니라 **발견**이었다: 85개 이름이 목록으로 늘어서 있으면
 * `세븐일레븐중구E`와 `세븐일레븐중구ENA센터`가 같은 가게라는 걸 사람이 못 본다.
 *
 * 그래서 카드사가 잘라 보낸 이름(엄격한 접두 관계)을 화면이 찾아 위에 올린다.
 * **묶지는 않는다** — 이 저장소의 규약은 "묶음은 사용자 확정의 결과"이고, 제안은
 * 기존 대표 선택 다이얼로그를 그대로 열 뿐이다.
 *
 * ## 브랜드 제안 + 브랜드 축 (2026-09-04)
 *
 * 절단 제안은 실측에서 한계에 닿았다: 102개 이름에 후보가 **1묶음**뿐이다(사용자가
 * 별칭 10건으로 이미 정리했다). 남은 문제는 음차(`GS25`↔`지에스25`)와 브랜드·지점
 * 병합인데, 이 둘은 `findTruncationCandidates`가 "제품 결정이라 규칙이 답하지 않는다"며
 * 일부러 비워 둔 자리였다.
 *
 * 그 제품 결정이 내려졌다: **별칭은 매장 단위, 브랜드는 별도 집계 축.** 그래서
 * 화면이 두 가지를 더 한다.
 *
 *   1. 브랜드가 같고 지점도 같은 이름을 병합 후보로 올린다(`brand_notation`).
 *      브랜드가 다르면 지명이 같아도 올리지 않는다 — `씨유영등포도림`(CU)과
 *      `GS25영등포도림`은 경쟁 브랜드다.
 *   2. 브랜드별 합계를 **파생 축**으로 보여준다. 이름은 하나도 바뀌지 않으므로
 *      되돌릴 것이 없고, 지점별 소비도 그대로 남는다.
 *
 * 제안에는 **판정 근거**(어떤 토큰을 브랜드로 읽었고 지점이 무엇인지)를 함께 띄운다.
 * 근거 없이 "묶으세요"만 내보내면 사용자가 검증할 수 없고, 한 번 틀린 제안이 도구
 * 신뢰를 깎는다.
 * ------------------------------------------------------------------------- */
import { Check, ChevronDown, Layers, Link2Off, Sparkles, Store } from "lucide-react";
import { useMemo, useState } from "react";
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
import {
  findMerchantIdentityCandidates,
  findTruncationCandidates,
  rollupByMerchantBrand,
  type MerchantIdentityCandidateGroup,
} from "@family/shared";

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

  /**
   * 카드사 절단으로 보이는 이름 묶음. 목록 데이터만으로 계산하므로 새 API가 없다.
   * 이미 묶인 별칭 행은 함수가 걸러낸다.
   */
  const suggestions = useMemo(() => findTruncationCandidates(items), [items]);

  /**
   * 브랜드/지점 구조로 찾은 병합 후보.
   *
   * 절단 제안이 다루는 이름은 **제외한다**(`excludeNames`). 실측에서 겹치는 쌍이
   * 있고(`씨유영등포` ⊂ `씨유영등포도림`은 양쪽에서 잡힌다), 같은 묶음이 두 블록에
   * 나오면 사용자가 같은 가게를 두 번 처리한다.
   */
  const identitySuggestions = useMemo(
    () =>
      findMerchantIdentityCandidates(items, {
        excludeNames: new Set(
          suggestions.flatMap((g) => [g.canonical, ...g.aliases]),
        ),
      }),
    [items, suggestions],
  );

  /**
   * 브랜드 축 — **파생 데이터**다. 이름을 바꾸지 않으므로 되돌릴 것이 없다.
   * 이름이 2개 이상 묶이는 브랜드만 보여준다. 하나짜리는 목록에 이미 그대로 있어
   * 같은 줄을 두 번 읽히는 것이 된다.
   */
  const brandRollups = useMemo(
    () => rollupByMerchantBrand(items).filter((r) => r.storeCount >= 2),
    [items],
  );
  const [brandOpen, setBrandOpen] = useState(false);

  /**
   * 제안을 그대로 받아 **대표 선택 다이얼로그를 연다**(바로 저장하지 않는다).
   * 사용자가 대표를 바꿀 수도 있고, 무엇보다 확정은 사람이 해야 한다.
   */
  const applySuggestion = (group: {
    canonical: string;
    aliases: string[];
  }) => {
    setSelected(new Set([group.canonical, ...group.aliases]));
    setCanonical(group.canonical);
    setPickOpen(true);
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
          {suggestions.length > 0 ? (
            <Card className="border-primary/30 bg-primary/5 space-y-3 p-4">
              <div className="flex items-start gap-2">
                <Sparkles className="text-primary mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    잘려서 들어온 이름이 {suggestions.length}묶음 있어요
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    카드 문자가 가맹점 이름을 길이 제한에서 자른 것으로 보여요.
                    묶으면 지출 순위와 카테고리가 하나로 모여요.
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                {suggestions.map((g) => (
                  <div
                    key={g.canonical}
                    className="bg-card flex items-center gap-3 rounded-xl px-3 py-2.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {g.canonical}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                        {g.aliases.join(" · ")} → 합치면 {g.transactionCount}건{" "}
                        {formatWon(g.netTotal)}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="tint"
                      className="shrink-0"
                      onClick={() => applySuggestion(g)}
                    >
                      묶기
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {identitySuggestions.length > 0 ? (
            <Card className="border-primary/30 bg-primary/5 space-y-3 p-4">
              <div className="flex items-start gap-2">
                <Sparkles className="text-primary mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    같은 가게로 보이는 이름이 {identitySuggestions.length}묶음
                    있어요
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    브랜드와 지점이 같은 이름이에요. 표기만 다른 경우가 많아요.
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                {identitySuggestions.map((g) => (
                  <IdentitySuggestionRow
                    key={`${g.reason}-${g.canonical}`}
                    group={g}
                    onApply={() => applySuggestion(g)}
                  />
                ))}
              </div>
            </Card>
          ) : null}

          {brandRollups.length > 0 ? (
            <Card className="overflow-hidden p-0">
              {/* 브랜드 축은 **파생 집계**다. 이름을 바꾸지 않으므로 되돌릴 것이
                  없고, 지점별 소비도 목록에 그대로 남는다. 기본은 접어 둔다 —
                  주 작업(이름 정리)보다 부가 정보다. */}
              <button
                type="button"
                onClick={() => setBrandOpen((v) => !v)}
                className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
              >
                <Layers className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    브랜드로 묶어 보기
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    이름 2개 이상인 브랜드 {brandRollups.length}개 · 이름은
                    바뀌지 않아요
                  </span>
                </span>
                <ChevronDown
                  className={`text-muted-foreground size-4 shrink-0 transition-transform ${
                    brandOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
              {brandOpen ? (
                <div className="divide-border border-t divide-y">
                  {brandRollups.map((r) => (
                    <div key={r.brand} className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {r.brand}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {r.transactionCount}건
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {formatWon(r.netTotal)}
                        </span>
                      </div>
                      {/* 무엇이 합산됐는지 반드시 펼쳐 보인다. 이름 수는 매장 수의
                          하한일 뿐이라(표기가 갈린 같은 매장이 둘로 세어진다)
                          "매장 N곳"이라 단정하면 관측하지 않은 사실이 된다. */}
                      <p className="text-muted-foreground mt-1 text-xs">
                        {r.names.join(" · ")}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </Card>
          ) : null}

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

      {/* 선택 액션 바 — 2개 이상 골랐을 때만 뜬다(하단 탭 위로 띄움).
          높이는 `--app-tabbar-h`(globals.css)에서 가져온다. 하드코딩 `bottom-20`
          (=5rem)은 safe-area를 빼먹어 iPhone(inset 34px)에서 탭바가 이 바를 덮었고,
          탭 구성이 바뀔 때마다 다시 어긋난다. 토큰이 단일 출처다. */}
      {selected.size >= 2 ? (
        <div className="fixed inset-x-0 bottom-[calc(var(--app-tabbar-h)+0.5rem)] z-30 px-4">
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

/**
 * 브랜드 병합 후보 한 줄 — **판정 근거를 함께 띄운다.**
 *
 * 근거가 왜 필요한가: 이 제안은 절단 제안보다 판단이 한 겹 더 들어간다(브랜드
 * 사전을 거친다). 사용자가 "지에스25를 GS25로 읽었다"를 볼 수 있어야 제안을
 * 검증하고, 틀렸을 때 무엇이 틀렸는지 말할 수 있다. 근거 없는 제안 하나가
 * 도구 신뢰를 깎는다는 것은 이 화면이 이미 배운 것이다.
 *
 * 근거는 접어 둔다 — 대개 맞으므로 매번 펼쳐 보일 필요는 없고, 의심될 때만 열면 된다.
 */
function IdentitySuggestionRow({
  group,
  onApply,
}: {
  group: MerchantIdentityCandidateGroup;
  onApply: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-card rounded-xl px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {group.canonical}
            </span>
            <Badge variant="secondary" className="shrink-0">
              {group.brand}
            </Badge>
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {group.aliases.join(" · ")} → 합치면 {group.transactionCount}건{" "}
            {formatWon(group.netTotal)}
          </span>
        </span>
        <Button
          size="sm"
          variant="tint"
          className="shrink-0"
          onClick={onApply}
        >
          묶기
        </Button>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground mt-1.5 text-xs underline-offset-2 hover:underline"
      >
        {open ? "근거 접기" : "왜 같은 가게인가요?"}
      </button>
      {open ? (
        <div className="text-muted-foreground mt-1.5 space-y-1 text-xs">
          <p>
            {group.reason === "brand_notation"
              ? "브랜드와 지점이 같아요. 표기만 달라요."
              : "브랜드가 같고 지점 이름이 잘린 것으로 보여요."}
          </p>
          {group.evidence.map((e) => (
            <p key={e.name} className="truncate">
              <span className="font-medium">{e.name}</span> → 브랜드 “
              {e.matchedToken}” · 지점 “{e.branch || "없음"}”
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
