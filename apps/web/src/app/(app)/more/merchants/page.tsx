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
 * 장보기 1 / 식비 5로 갈려 있었다). 묶기·풀기·"다른 가게예요"는 서버가 가족 관리자에게만
 * 허용하므로(merchant.service `ADMIN_ROLES`) 다른 구성원에게는 목록만 보여 준다.
 *
 * ## 제안 (2026-08-21 · 2026-09-04 · 2026-11-05)
 *
 * 도구는 잘 동작했는데 거의 쓰이지 않았다 — 실측 별칭 4행 vs 사람이 확정한 카테고리
 * 규칙 85행. 원인은 도구가 아니라 **발견**이었다: 85개 이름이 목록으로 늘어서 있으면
 * `세븐일레븐중구E`와 `세븐일레븐중구ENA센터`가 같은 가게라는 걸 사람이 못 본다.
 *
 * 그래서 두 종류의 후보를 **한 섹션**에 올린다(예전에는 두 블록이었다).
 *   1. 카드사가 잘라 보낸 이름(엄격한 접두 관계, `findTruncationCandidates`).
 *   2. 브랜드와 지점이 같은 이름(`brand_notation`·`brand_branch_prefix`). 브랜드가
 *      다르면 지명이 같아도 올리지 않는다 — `씨유영등포도림`(CU)과 `GS25영등포도림`은
 *      경쟁 브랜드다. 판정 근거(어떤 토큰을 브랜드로 읽었고 지점이 무엇인지)는 ⋯ 메뉴의
 *      "왜 같은 가게인가요?"로 연다 — 근거 없는 제안은 사용자가 검증할 수 없다.
 *
 * **묶지는 않는다** — 이 저장소의 규약은 "묶음은 사용자 확정의 결과"이고, 제안은 대표
 * 선택 다이얼로그를 열 뿐이다. 둘 다 "다른 가게예요"로 거절할 수 있고, 서버가 거절한
 * 묶음을 걸러 내려준다(거절 신원이 해시라 화면이 거를 수 없다).
 *
 * 브랜드별 합계를 보여 주던 "브랜드로 묶어 보기"는 2026-11-05에 뺐다(소유자 승인) —
 * 이름 정리라는 이 화면의 일과 무관한 부가 집계였다.
 *
 * 화면 글자에는 '잘린 이름' 같은 판정 이름을 쓰지 않는다 — 사용자가 보는 사실('앞부분이 같은
 * 이름')로 말한다(2026-11-05 HIG 검수). 선택 바의 '같은 가게로 묶기'가 이 화면의 주 행동이라
 * 기본 높이(44px) 채움 버튼이다.
 * ------------------------------------------------------------------------- */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Search, Store, X } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  BottomSheet,
  EmptyState,
  ErrorState,
  ListLoading,
  ListRow,
  OverflowMenu,
  PageBackHeader,
  SectionHeader,
  StatusChip,
  type OverflowAction,
} from "@/components/widgets";
import { FilterChip } from "@/components/widgets/filter-chip";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { formatWon } from "@/lib/format";
import { useHousehold } from "@/lib/household-context";
import {
  recomputeRecurringAfterMerchantChange,
  rejectTruncationSuggestion,
} from "@/lib/merchant-cleanup-client";
import {
  queryKeys,
  useCreateMerchantAliases,
  useDeleteMerchantAlias,
  useMerchantList,
  useRejectMerchantIdentity,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import type {
  MerchantIdentityCandidate,
  MerchantSummary,
} from "@family/contracts";
import { findTruncationCandidates } from "@family/shared";

/** 서버가 다른 구성원의 요약 공개 결제를 접어 보내는 이름(packages/database REDACTED_MERCHANT_LABEL). */
const REDACTED_MERCHANT = "(비공개)";

/** 제안 한 묶음 — 잘린 이름(앞부분이 같은 이름) 제안이면 `identity`가 null이다. */
interface Suggestion {
  key: string;
  canonical: string;
  aliases: string[];
  transactionCount: number;
  netTotal: number;
  identity: MerchantIdentityCandidate | null;
}

/** 제안 화면에서 연 확정이면 서버 label에 남길 경로 표시(거절과 같은 키). */
type ProposalPath = {
  brand?: string;
  reason: "brand_notation" | "brand_branch_prefix" | "truncation";
};

/** 대표 선택 다이얼로그에 올린 이름들. 선택 바에서 열었는지 제안에서 열었는지 기억한다. */
interface PickerState {
  names: string[];
  fromSelection: boolean;
  /** 제안에서 열었을 때만 채운다. 수동 병합은 비운다. */
  proposal?: ProposalPath;
}

export default function MerchantsPage() {
  const { data, isLoading, isError, isFetching, refetch } = useMerchantList();
  const { householdId, activeMembership } = useHousehold();
  const { authedFetch } = useAuth();
  const queryClient = useQueryClient();
  const createAliases = useCreateMerchantAliases();
  const deleteAlias = useDeleteMerchantAlias();
  const rejectIdentity = useRejectMerchantIdentity();
  const rejectTruncation = useMutation({
    mutationFn: (names: string[]) =>
      authedFetch((token) =>
        rejectTruncationSuggestion(token, {
          householdId: householdId as string,
          names,
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.merchants(householdId) }),
  });

  // 묶기·풀기·거절은 서버가 관리자에게만 허용한다 — 다른 구성원에게 버튼을 보여 주면
  // 누르는 순간 403이다(예산 화면과 같은 판정).
  const canManage =
    activeMembership?.role === "owner" || activeMembership?.role === "admin";

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [canonical, setCanonical] = useState<string | null>(null);
  const [resolveCategoryId, setResolveCategoryId] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<MerchantSummary | null>(null);
  const [evidenceFor, setEvidenceFor] = useState<MerchantIdentityCandidate | null>(null);

  const items = useMemo(() => data?.items ?? [], [data]);
  // 별칭 행은 이미 묶인 것이라 선택 대상이 아니다(대표를 바꾸려면 먼저 해제). '(비공개)'는 다른
  // 구성원의 요약 공개 결제를 접은 표시라 가맹점이 아니다 — 대표로 묶으면 거래 이름이 덮어써진다.
  const selectable = items.filter((m) => m.aliasOf === null && m.name !== REDACTED_MERCHANT);
  const aliasRows = items.filter((m) => m.aliasOf !== null);

  /** 불러온 목록 안에서만 찾는다 — 대표 이름·묶인 이름 어느 쪽으로 찾아도 걸린다. */
  const needle = search.trim().toLowerCase();
  const matches = (m: MerchantSummary): boolean =>
    needle === "" ||
    m.name.toLowerCase().includes(needle) ||
    (m.aliasOf?.toLowerCase().includes(needle) ?? false) ||
    m.aliases.some((a) => a.toLowerCase().includes(needle));
  const visibleSelectable = selectable.filter(matches);
  const visibleAliasRows = aliasRows.filter(matches);

  /**
   * 제안 — 잘린 이름 + 브랜드/지점 후보를 지출 큰 순으로 한 목록에 둔다. 둘 다 서버가
   * 거절한 묶음을 걸러 내려준다. 잘린 이름 후보를 보내지 않는 옛 서버에서만 목록으로 직접
   * 계산한다(그때는 거절을 거를 수 없으므로 "다른 가게예요"를 숨긴다).
   */
  const truncationFromServer = data?.truncationCandidates;
  const suggestions = useMemo<Suggestion[]>(() => {
    const truncation = truncationFromServer ?? findTruncationCandidates(items);
    const merged: Suggestion[] = [
      ...truncation.map((g) => ({
        key: `truncation-${g.canonical}`,
        canonical: g.canonical,
        aliases: g.aliases,
        transactionCount: g.transactionCount,
        netTotal: g.netTotal,
        identity: null,
      })),
      ...(data?.identityCandidates ?? []).map((g) => ({
        key: `${g.reason}-${g.canonical}`,
        canonical: g.canonical,
        aliases: g.aliases,
        transactionCount: g.transactionCount,
        netTotal: g.netTotal,
        identity: g,
      })),
    ];
    return merged
      .filter((s) => ![s.canonical, ...s.aliases].includes(REDACTED_MERCHANT))
      .sort((a, b) => b.netTotal - a.netTotal);
  }, [data?.identityCandidates, items, truncationFromServer]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /** 정기 지출 후보는 가맹점 신원으로 묶인다 — 묶거나 푼 뒤 다시 찾아야 맞는다. */
  const refreshRecurring = () => {
    if (!householdId) return;
    authedFetch((token) => recomputeRecurringAfterMerchantChange(token, householdId))
      .then(() =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: ["recurring-series"] }),
          queryClient.invalidateQueries({ queryKey: ["recurring-upcoming"] }),
        ]),
      )
      // 실패해도 묶기 결과는 그대로다 — 서버의 주기 재계산이 뒤따라 맞춘다.
      .catch(() => undefined);
  };

  /**
   * "같은 가게가 아니에요" — 상태를 바꾸지 않고 판단만 남긴다.
   *
   * 확인 다이얼로그를 두지 않는다. 되돌릴 상태가 없고(별칭도 거래도 그대로),
   * 잘못 눌러도 잃는 것은 그 제안 하나다. 확정 쪽에는 다이얼로그가 있는데
   * 그쪽은 과거 거래를 백필하기 때문이다 — 위험이 다르면 절차도 다르다.
   */
  const rejectSuggestion = (s: Suggestion) => {
    const names = [s.canonical, ...s.aliases];
    const callbacks = {
      onSuccess: () =>
        toast.success("다른 가게로 남겨 둘게요", {
          description: "이 묶음은 다시 제안하지 않아요.",
        }),
      onError: (error: unknown) =>
        toast.error(
          error instanceof ApiError
            ? error.message
            : "저장하지 못했어요. 잠시 후 다시 시도해 주세요",
        ),
    };
    if (s.identity) {
      rejectIdentity.mutate(
        { names, brand: s.identity.brand, reason: s.identity.reason },
        callbacks,
      );
    } else {
      rejectTruncation.mutate(names, callbacks);
    }
  };

  /**
   * 대표 선택 다이얼로그를 연다(바로 저장하지 않는다). 사용자가 대표를 바꿀 수도 있고,
   * 무엇보다 확정은 사람이 해야 한다. 제안에서 열어도 **손으로 고른 선택은 그대로 둔다** —
   * 예전에는 제안의 "묶기"가 고르던 이름들을 지워 버렸다.
   */
  const openPicker = (
    names: string[],
    fromSelection: boolean,
    preferred?: string,
    proposal?: ProposalPath,
  ) => {
    // 기본 대표는 제안이 고른 이름, 아니면 지출이 가장 큰 이름 — 대개 가장 온전한 표기다.
    const byTotal = items
      .filter((m) => names.includes(m.name))
      .sort((a, b) => b.netTotal - a.netTotal);
    setCanonical(preferred ?? byTotal[0]?.name ?? names[0] ?? null);
    setResolveCategoryId(null);
    setPicker({ names, fromSelection, proposal });
  };

  /** 다이얼로그를 닫으면 고르던 대표·카테고리도 버린다 — 다음에 열 때 남아 있으면 안 된다. */
  const closePicker = () => {
    setPicker(null);
    setCanonical(null);
    setResolveCategoryId(null);
  };

  /**
   * 고른 이름들의 **카테고리가 갈렸는가**(규칙 출처 무관).
   *
   * 목록이 이미 각 이름의 카테고리를 들고 있으므로 **묶기 전에** 알 수 있고, 그러면
   * 거부당한 뒤 "먼저 정리하세요"를 듣는 대신 여기서 한 번에 고를 수 있다. 서버는 고른
   * 답이 이 후보 중 하나면 출처와 무관하게 따른다(merchant-rule-merge 규칙 6).
   *
   * 실측 2026-09-05: 화면이 제안한 병합 3건이 **전부** 이 충돌이었다.
   */
  const pickNames = picker?.names;
  const categoryChoices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const name of pickNames ?? []) {
      const row = items.find((m) => m.name === name);
      if (row?.categoryId && row.categoryName) {
        seen.set(row.categoryId, row.categoryName);
      }
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [pickNames, items]);
  const needsCategoryChoice = categoryChoices.length > 1;
  const chosenCategoryId =
    resolveCategoryId && categoryChoices.some((c) => c.id === resolveCategoryId)
      ? resolveCategoryId
      : null;

  const submit = () => {
    if (!picker || !canonical) return;
    const aliases = picker.names.filter((n) => n !== canonical);
    if (aliases.length === 0) return;
    if (needsCategoryChoice && !chosenCategoryId) return;
    const merged = picker.names;
    const fromSelection = picker.fromSelection;
    const proposal = picker.proposal;
    createAliases.mutate(
      {
        canonical,
        aliases,
        ...(needsCategoryChoice && chosenCategoryId
          ? { categoryId: chosenCategoryId }
          : {}),
        // 제안 화면 확정만 brand·reason을 실어 보낸다. 수동 병합은 비운다.
        ...(proposal
          ? {
              reason: proposal.reason,
              ...(proposal.brand ? { brand: proposal.brand } : {}),
            }
          : {}),
      },
      {
        onSuccess: (res) => {
          closePicker();
          setSelected((prev) => {
            if (fromSelection) return new Set();
            const next = new Set(prev);
            for (const name of merged) next.delete(name);
            return next;
          });
          toast.success("같은 가게로 묶었어요", {
            description: `거래 ${res.transactionsUpdated}건을 ‘${res.canonical}’ 이름으로 모았어요`,
          });
          refreshRecurring();
        },
        // 서버 메시지를 그대로 띄운다. "잠시 후 다시 시도"는 카테고리 충돌처럼
        // 다시 시도해도 같은 결과인 실패에 대해 거짓말이 된다.
        onError: (error) =>
          toast.error(
            error instanceof ApiError
              ? error.message
              : "묶는 데 실패했어요. 잠시 후 다시 시도해 주세요",
          ),
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
        refreshRecurring();
      },
      onError: (error) => {
        setUnlinkTarget(null);
        toast.error(
          error instanceof ApiError ? error.message : "묶음을 푸는 데 실패했어요",
        );
      },
    });
  };

  const rejecting = rejectIdentity.isPending || rejectTruncation.isPending;
  const suggestionActions = (s: Suggestion): OverflowAction[] => [
    ...(s.identity
      ? [
          {
            label: "왜 같은 가게인가요?",
            onSelect: () => setEvidenceFor(s.identity),
          },
        ]
      : []),
    ...(s.identity || truncationFromServer
      ? [
          {
            label: "다른 가게예요",
            disabled: rejecting,
            onSelect: () => rejectSuggestion(s),
          },
        ]
      : []),
  ];

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-6">
      <PageBackHeader title="가맹점 정리" />

      {isLoading ? (
        <ListLoading rows={5} label="가맹점을 불러오는 중이에요." />
      ) : isError ? (
        <ErrorState
          message="가맹점을 불러오지 못했어요"
          retrying={isFetching}
          onRetry={() => void refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Store />}
          title="아직 가맹점이 없어요"
          description="카드 문자가 쌓이면 여기에 나타나요."
        />
      ) : (
        <>
          {canManage && suggestions.length > 0 ? (
            <section className="finance-panel min-w-0 overflow-hidden pt-3 pb-1">
              <SectionHeader
                className="px-5"
                title="같은 가게로 보이는 이름"
                trailing={
                  <span className="text-caption text-muted-foreground tabular-nums">
                    {suggestions.length}묶음
                  </span>
                }
              />
              <p className="text-caption text-muted-foreground px-5">
                묶으면 지난 거래가 대표 이름 하나로 모여요.
              </p>
              <ul className="divide-border/60 divide-y px-4">
                {suggestions.map((s) => {
                  const actions = suggestionActions(s);
                  return (
                    <li key={s.key} className="flex min-w-0 items-center gap-1">
                      <ListRow
                        className="flex-1"
                        title={s.canonical}
                        subtitle={`${s.identity ? `${s.identity.brand} · ` : "앞부분이 같은 이름 · "}${s.aliases.join(" · ")} · 합치면 ${s.transactionCount}건 ${formatWon(s.netTotal)}`}
                        value={
                          <Button
                            size="sm"
                            variant="weak"
                            onClick={() =>
                              openPicker(
                                [s.canonical, ...s.aliases],
                                false,
                                s.canonical,
                                s.identity
                                  ? {
                                      brand: s.identity.brand,
                                      reason: s.identity.reason,
                                    }
                                  : { reason: "truncation" },
                              )
                            }
                          >
                            묶기
                          </Button>
                        }
                      />
                      {actions.length > 0 ? (
                        <OverflowMenu
                          label={`${s.canonical} 제안 메뉴`}
                          className="-mr-2 shrink-0"
                          actions={actions}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section className="finance-panel min-w-0 overflow-hidden pt-3 pb-1">
            <SectionHeader
              className="px-5"
              title="가맹점"
              trailing={
                <span className="text-caption text-muted-foreground tabular-nums">
                  {selectable.length}곳
                </span>
              }
            />
            <p className="text-caption text-muted-foreground px-5">
              {canManage
                ? "같은 가게인 이름을 2개 이상 골라 묶어요."
                : "가맹점 묶기와 풀기는 가족 관리자만 할 수 있어요."}
            </p>
            <div className="px-5 pt-3 pb-1">
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  aria-label="가맹점 이름으로 찾기"
                  placeholder="가맹점 이름으로 찾기"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            {visibleSelectable.length === 0 ? (
              <EmptyState
                title="찾는 가맹점이 없어요"
                description="다른 이름으로 찾아보세요."
              />
            ) : (
              <ul className="divide-border/60 divide-y px-4">
                {visibleSelectable.map((m) => {
                  const isSelected = selected.has(m.name);
                  return (
                    <li key={m.name}>
                      <ListRow
                        icon={
                          canManage ? (
                            isSelected ? <Check /> : <span aria-hidden="true" />
                          ) : undefined
                        }
                        // 선택 표시는 아이콘 자리의 작은 원 — 체크박스 프리미티브가 없어 행 토글로 쓴다.
                        iconClassName={cn(
                          "size-6 sm:size-6 [&_svg]:size-4 sm:[&_svg]:size-4",
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : "border-border border-2 bg-transparent",
                        )}
                        onClick={canManage ? () => toggle(m.name) : undefined}
                        ariaLabel={
                          canManage
                            ? `${m.name} ${isSelected ? "선택 해제" : "선택"}`
                            : undefined
                        }
                        title={m.name}
                        subtitle={`${m.transactionCount}건${
                          m.aliases.length > 0
                            ? ` · 다른 이름 ${m.aliases.length}개 묶음`
                            : ""
                        }`}
                        value={formatWon(m.netTotal)}
                        valueSub={
                          m.categoryName ? <StatusChip>{m.categoryName}</StatusChip> : undefined
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {visibleAliasRows.length > 0 ? (
            <section className="finance-panel min-w-0 overflow-hidden pt-3 pb-1">
              <SectionHeader
                className="px-5"
                title="묶인 이름"
                trailing={
                  <span className="text-caption text-muted-foreground tabular-nums">
                    {aliasRows.length}개
                  </span>
                }
              />
              <ul className="divide-border/60 divide-y px-4">
                {visibleAliasRows.map((m) => (
                  <li key={m.name} className="flex min-w-0 items-center gap-1">
                    <ListRow
                      className="flex-1"
                      title={m.name}
                      titleClassName="text-muted-foreground font-medium"
                      subtitle={`→ ${m.aliasOf}`}
                    />
                    {canManage && m.aliasId ? (
                      <OverflowMenu
                        label={`${m.name} 메뉴`}
                        className="-mr-2 shrink-0"
                        actions={[
                          {
                            label: "묶음 풀기",
                            destructive: true,
                            disabled: deleteAlias.isPending,
                            onSelect: () => setUnlinkTarget(m),
                          },
                        ]}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      {/* 선택 액션 바 — 하나라도 고르면 뜬다(하단 탭 위로 띄움). `data-fab`이 있으면
          globals.css가 본문 아래를 비워 마지막 줄이 이 바에 가리지 않는다.
          높이는 `--app-tabbar-h`(globals.css)에서 가져온다. 하드코딩 `bottom-20`
          (=5rem)은 safe-area를 빼먹어 iPhone(inset 34px)에서 탭바가 이 바를 덮었고,
          탭 구성이 바뀔 때마다 다시 어긋난다. 토큰이 단일 출처다. */}
      {canManage && selected.size > 0 ? (
        <div
          data-fab
          className="fixed inset-x-0 bottom-[calc(var(--app-tabbar-h)+0.5rem)] z-30 px-4"
        >
          {/* 선택 모드 막대: [× 선택 해제] 상태 · 주 행동. 주 행동을 44px로 키운 만큼 해제는 아이콘으로
              줄여 폰 폭(360px)에서도 상태 글자가 두 줄 안에 들어오게 한다(잘라 버리지 않는다). */}
          <div className="bg-background/95 mx-auto flex w-full max-w-2xl items-center gap-2 rounded-card py-2 pr-2 pl-1 shadow-lg backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              aria-label="선택 해제"
              onClick={() => setSelected(new Set())}
            >
              <X />
            </Button>
            <span className="text-body min-w-0 flex-1">
              {selected.size < 2
                ? "하나 더 고르면 묶을 수 있어요"
                : `${selected.size}개를 골랐어요`}
            </span>
            {/* 이 화면의 주 행동 — 채움 버튼은 이것 하나이고, 작은 버튼(36px)이 아니라 기본 높이 44px다. */}
            <Button
              disabled={selected.size < 2}
              onClick={() => openPicker([...selected], true)}
            >
              같은 가게로 묶기
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) closePicker();
        }}
      >
        <DialogContent>
          <DialogHeader className="text-left">
            <DialogTitle>어떤 이름을 대표로 할까요?</DialogTitle>
            <DialogDescription>
              고른 이름들의 지난 거래가 대표 이름 하나로 모여요.
            </DialogDescription>
          </DialogHeader>
          <div
            className="divide-border/60 flex max-h-72 flex-col divide-y overflow-y-auto"
            role="radiogroup"
            aria-label="대표 이름"
          >
            {(picker?.names ?? []).map((name) => {
              const active = canonical === name;
              return (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setCanonical(name)}
                  className="hover:bg-muted/70 flex min-h-12 w-full items-center gap-3 rounded-control px-1 py-2 text-left transition-colors active:bg-muted"
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "border-border border-2",
                    )}
                  >
                    {active ? <Check className="size-4" /> : null}
                  </span>
                  <span className="text-body min-w-0 flex-1 truncate">{name}</span>
                </button>
              );
            })}
          </div>
          {needsCategoryChoice ? (
            <div className="flex flex-col gap-2">
              <p className="text-body font-semibold">
                카테고리가 서로 달라요. 어느 쪽으로 합칠까요?
              </p>
              <p className="text-caption text-muted-foreground">
                고른 카테고리가 앞으로의 거래에 붙고, 지난 거래 분류는 그대로예요.
              </p>
              {/* 칩은 보이는 알약 36px·누르는 칸 44px(FilterChip). 고른 것은 색과 체크 아이콘이 함께 말한다. */}
              <div className="flex flex-wrap gap-x-1.5" role="radiogroup" aria-label="합칠 카테고리">
                {categoryChoices.map((c) => {
                  const active = chosenCategoryId === c.id;
                  return (
                    <FilterChip
                      key={c.id}
                      role="radio"
                      aria-checked={active}
                      active={active}
                      onClick={() => setResolveCategoryId(c.id)}
                    >
                      {active ? (
                        <Check aria-hidden="true" className="-ml-0.5 mr-0.5 inline size-3.5 align-[-2px]" />
                      ) : null}
                      {c.name}
                    </FilterChip>
                  );
                })}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={closePicker}>
              닫기
            </Button>
            <Button
              onClick={submit}
              disabled={
                !canonical ||
                createAliases.isPending ||
                (needsCategoryChoice && !chosenCategoryId)
              }
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
              ‘{unlinkTarget?.name}’이 원래 이름으로 돌아가고, 해당 거래도 다시 분리돼요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>닫기</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteAlias.isPending}
              onClick={(event) => {
                event.preventDefault();
                unlink();
              }}
            >
              {deleteAlias.isPending ? "푸는 중…" : "묶음 풀기"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 판정 근거 — 대개 맞으므로 목록에 펼쳐 두지 않고, 의심될 때만 연다. 근거 없는
          제안은 사용자가 검증할 수 없고, 한 번 틀린 제안이 도구 신뢰를 깎는다. */}
      <BottomSheet
        open={evidenceFor !== null}
        onOpenChange={(open) => {
          if (!open) setEvidenceFor(null);
        }}
        title="왜 같은 가게로 봤나요"
      >
        {evidenceFor ? (
          <div className="flex flex-col gap-2 pb-2">
            <p className="text-body">
              {evidenceFor.reason === "brand_notation"
                ? "브랜드와 지점이 같고 표기만 달라요."
                : "브랜드가 같고, 한쪽은 지점 이름이 줄여 적힌 것으로 보여요."}
            </p>
            <ul className="flex flex-col gap-1">
              {evidenceFor.evidence.map((e) => (
                <li key={e.name} className="text-caption text-muted-foreground break-all">
                  <span className="text-foreground font-medium">{e.name}</span> → 브랜드 “
                  {e.matchedToken}” · 지점 “{e.branch || "없음"}”
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </BottomSheet>
    </div>
  );
}
