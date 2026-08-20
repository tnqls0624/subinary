"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 카테고리 규칙 (/more/category-rules)
 *
 * 이 화면이 생긴 이유는 실측이다. 자동분류는 잘 돌고 있었는데(`etc` 10.7%·미분류 2건)
 * 사용자가 **93건(전체의 절반)을 손으로 110번** 고쳤다. 같은 가맹점을 네 번까지 고친
 * 기록도 있었다(쿠팡 4회/3거래).
 *
 * 원인은 규칙이 **미래 거래에만** 적용되기 때문이다. 쿠팡 거래가 이미 3건 쌓인 상태에서
 * 하나를 고치면 규칙은 생기지만 나머지 2건은 그대로라, 나머지도 하나씩 또 고치게 된다.
 * 그 `never retroactive`는 의도된 안전장치였다 — 규칙 하나가 과거를 조용히 재분류하면
 * 지난달 통계가 사용자 모르게 바뀐다. 문제는 그 안전장치에 **대안이 없었다**는 것이다.
 *
 * 그래서 이 화면은 세 가지를 한다.
 *   1. 무엇이 자동으로 붙는지 보여준다(규칙 목록 — 이전에는 볼 방법이 0개였다).
 *   2. "과거에도 적용"을 **미리보기와 함께** 제안한다(조용히 하지 않는다).
 *   3. 되돌린다(적용 단위 batch + 행별 이전 값).
 * ------------------------------------------------------------------------- */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Sparkles, Trash2, User } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type {
  CategoryRule,
  CategoryRuleList,
  RecategorizeBatchList,
  RecategorizePreview,
} from "@family/contracts";

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
import { Card, CardContent } from "@/components/ui/card";
import {
  EmptyState,
  Money,
  PageBackHeader,
  StatusBadge,
} from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import {
  applyRecategorize,
  categoryRulesKey,
  deleteCategoryRule,
  fetchCategoryRules,
  fetchRecategorizeBatches,
  fetchRecategorizePreview,
  recategorizeBatchesKey,
  revertRecategorize,
} from "./rules-api";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `YYYY-MM` → "8월". 연도는 올해가 아닐 때만 붙인다. */
function formatMonthLabel(month: string): string {
  const [year, mm] = month.split("-");
  const thisYear = String(new Date().getFullYear());
  return year === thisYear ? `${Number(mm)}월` : `${year}년 ${Number(mm)}월`;
}

export default function CategoryRulesPage() {
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();
  const queryClient = useQueryClient();

  /** 소급 적용을 확인 중인 규칙. null이면 다이얼로그가 닫혀 있다. */
  const [target, setTarget] = useState<CategoryRule | null>(null);

  const rulesQuery = useQuery<CategoryRuleList>({
    queryKey: categoryRulesKey(householdId),
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) => fetchCategoryRules(token, householdId as string)),
  });

  const batchesQuery = useQuery<RecategorizeBatchList>({
    queryKey: recategorizeBatchesKey(householdId),
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) =>
        fetchRecategorizeBatches(token, householdId as string),
      ),
  });

  /**
   * 미리보기는 다이얼로그가 열린 동안만 가져온다. 목록의 `staleTransactionCount`와 같은
   * 함수가 세지만, 여기서는 **금액·기간·영향 받는 달**까지 보여줘야 하므로 따로 묻는다.
   */
  const previewQuery = useQuery<RecategorizePreview>({
    queryKey: [
      "recategorize-preview",
      householdId,
      target?.merchantPattern ?? "",
      target?.categoryId ?? "",
    ],
    enabled: householdId != null && target != null,
    queryFn: () =>
      authedFetch((token) =>
        fetchRecategorizePreview(
          token,
          householdId as string,
          target!.merchantPattern,
          target!.categoryId,
        ),
      ),
  });

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: categoryRulesKey(householdId) }),
      queryClient.invalidateQueries({
        queryKey: recategorizeBatchesKey(householdId),
      }),
      // 거래·집계도 갈아엎는다 — 분류가 바뀌면 카테고리별 지출과 예산 사용률이 달라진다.
      queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      queryClient.invalidateQueries({ queryKey: ["analytics"] }),
      queryClient.invalidateQueries({ queryKey: ["budgets"] }),
    ]);
  };

  const apply = useMutation({
    mutationFn: (input: { merchant: string; categoryId: string; expectedCount: number }) =>
      authedFetch((token) =>
        applyRecategorize(token, { householdId: householdId as string, ...input }),
      ),
    onSuccess: async (result) => {
      setTarget(null);
      await invalidateAll();
      // 서버가 센 숫자를 그대로 보여준다 — 클라이언트가 계산한 건수와 갈리면
      // 사용자가 틀린 숫자를 믿게 된다.
      toast.success(`과거 ${result.appliedCount}건을 함께 바꿨어요.`, {
        description: "아래 '되돌리기'에서 되돌릴 수 있어요.",
      });
    },
    onError: () => {
      toast.error("바꾸지 못했어요. 잠시 후 다시 시도해 주세요.");
    },
  });

  const revert = useMutation({
    mutationFn: (batchId: string) =>
      authedFetch((token) => revertRecategorize(token, batchId)),
    onSuccess: async (result) => {
      await invalidateAll();
      toast.success(`${result.revertedCount}건을 되돌렸어요.`, {
        description:
          result.skippedCount > 0
            ? `${result.skippedCount}건은 그 뒤에 다시 분류해서 그대로 두었어요.`
            : undefined,
      });
    },
    onError: () => {
      toast.error("되돌리지 못했어요. 잠시 후 다시 시도해 주세요.");
    },
  });

  const removeRule = useMutation({
    mutationFn: (ruleId: string) =>
      authedFetch((token) => deleteCategoryRule(token, ruleId)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: categoryRulesKey(householdId),
      });
      toast.success("규칙을 지웠어요.", {
        description: "이미 분류된 거래는 그대로예요.",
      });
    },
    onError: () => {
      toast.error("규칙을 지우지 못했어요.");
    },
  });

  const rules = rulesQuery.data?.items ?? [];
  const batches = batchesQuery.data?.items ?? [];
  const preview = previewQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <PageBackHeader
        title="카테고리 규칙"
        subtitle="가맹점마다 어떤 카테고리가 자동으로 붙는지 확인해요"
        backHref="/more"
      />

      {/* ---- 규칙 목록 ---- */}
      <section className="flex flex-col gap-2">
        {rulesQuery.isPending ? (
          <p className="text-muted-foreground px-1 text-[13px]">불러오는 중…</p>
        ) : rulesQuery.isError ? (
          <p className="text-destructive px-1 text-[13px]">
            규칙을 불러오지 못했어요.
          </p>
        ) : rules.length === 0 ? (
          <EmptyState
            title="아직 규칙이 없어요"
            description="거래의 카테고리를 고치면서 '이 가맹점에 계속 적용'을 켜면 여기에 쌓여요."
          />
        ) : (
          rules.map((rule) => (
            <Card key={rule.id}>
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[15px] font-medium">
                      {rule.merchantPattern}
                    </span>
                    <span className="text-muted-foreground text-[13px]">
                      → {rule.categoryName ?? "알 수 없는 카테고리"}
                    </span>
                  </div>
                  {rule.source === "human_confirmed" ? (
                    <StatusBadge
                      status="human"
                      tone="success"
                      label="내가 확정"
                    />
                  ) : (
                    <StatusBadge status="model" tone="neutral" label="자동 학습" />
                  )}
                </div>

                {/*
                  과거에 남은 것이 있을 때만 제안한다. 0건인데 버튼을 띄우면 눌러도
                  아무 일이 없고, 그건 버튼이 거짓말을 하는 것이다.
                */}
                {rule.staleTransactionCount > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-warning-strong text-[13px]">
                      과거 {rule.staleTransactionCount}건이 다른 카테고리로 남아 있어요
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setTarget(rule)}
                    >
                      <Sparkles className="size-4" />
                      과거에도 적용하기
                    </Button>
                  </div>
                ) : null}

                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={removeRule.isPending}
                    onClick={() => removeRule.mutate(rule.id)}
                  >
                    <Trash2 className="size-4" />
                    규칙 지우기
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {/* ---- 적용 이력 · 되돌리기 ---- */}
      {batches.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground px-1 text-[13px] font-medium">
            <History className="mr-1 inline size-4" />
            최근에 한 일
          </h2>
          {batches.map((batch) => (
            <Card key={batch.id}>
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[14px]">
                    {batch.merchantCanonical} → {batch.toCategoryName ?? "?"}
                  </span>
                  <span className="text-muted-foreground text-[12px]">
                    {formatDateTime(batch.appliedAt)} · {batch.appliedCount}건
                    {batch.revertedAt
                      ? ` · 되돌림 ${batch.revertedCount ?? 0}건`
                      : ""}
                  </span>
                </div>
                {batch.revertable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revert.isPending}
                    onClick={() => revert.mutate(batch.id)}
                  >
                    되돌리기
                  </Button>
                ) : (
                  <StatusBadge status="reverted" tone="neutral" label="되돌림" />
                )}
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}

      {/* ---- 소급 적용 확인 ---- */}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>과거 거래에도 적용할까요?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-left">
                {previewQuery.isPending ? (
                  <span>불러오는 중…</span>
                ) : previewQuery.isError || !preview ? (
                  <span>미리보기를 불러오지 못했어요.</span>
                ) : (
                  <>
                    <span>
                      <strong>{preview.merchantCanonical}</strong>의{" "}
                      <strong>{preview.count}건</strong>을{" "}
                      <strong>{preview.toCategoryName}</strong>으로 바꿔요.
                      {preview.oldestAt ? (
                        <>
                          {" "}
                          ({new Date(preview.oldestAt).toLocaleDateString("ko-KR")}부터)
                        </>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground">
                      지금 카테고리: {preview.fromCategoryNames.join(", ")} · 합계{" "}
                      <Money amount={preview.amount} currency="KRW" muted />
                    </span>
                    {preview.months.length > 0 ? (
                      <span className="text-muted-foreground">
                        영향 받는 달:{" "}
                        {preview.months
                          .map(
                            (m) =>
                              `${formatMonthLabel(m.month)} ${m.count}건${
                                m.budgetAffected ? " (예산 영향)" : ""
                              }`,
                          )
                          .join(" · ")}
                      </span>
                    ) : null}
                    {/*
                      자산이동은 지출 합계에서 빠진다. 그 경계를 넘으면 "카테고리만
                      바꾸니 총액은 그대로"가 거짓이 되므로 다른 문장으로 경고한다.
                    */}
                    {preview.transferBoundaryCrossed ? (
                      <span className="text-warning-strong">
                        자산이동 여부가 바뀌어서 그 달 <strong>총지출도 달라져요.</strong>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        카테고리만 바뀌고 총지출은 그대로예요.
                      </span>
                    )}
                    {preview.exceedsLimit ? (
                      <span className="text-destructive">
                        한 번에 {preview.limit}건까지만 바꿀 수 있어요.
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        되돌릴 수 있어요 — 바꾼 뒤 이 화면에서 되돌리기를 누르면 돼요.
                      </span>
                    )}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>그만두기</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                !preview ||
                preview.count === 0 ||
                preview.exceedsLimit ||
                apply.isPending
              }
              onClick={(event) => {
                event.preventDefault();
                if (!preview || !target) return;
                apply.mutate({
                  merchant: target.merchantPattern,
                  categoryId: target.categoryId,
                  // 사용자가 **본 숫자**를 그대로 보낸다. 서버가 다시 세어 다르면 409다.
                  expectedCount: preview.count,
                });
              }}
            >
              {apply.isPending ? "바꾸는 중…" : "과거에도 적용하기"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
