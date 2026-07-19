"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 카테고리 관리 (/categories)
 *
 * 우리 가족만의 커스텀 지출 카테고리를 만들고(이름만), 이름 수정·삭제한다.
 * 시스템 기본 카테고리는 읽기 전용(수정/삭제 불가). 삭제 시 그 카테고리를 쓰던
 * 거래는 서버에서 '미분류'로 되돌아간다(파괴적이라 AlertDialog로 확인).
 * 여기서 만든 커스텀 카테고리는 이후 AI 자동분류 후보에도 자동 포함된다.
 * ------------------------------------------------------------------------- */
import {
  ArrowRight,
  BrainCircuit,
  Check,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type {
  CategorySummary,
  MerchantLabelCandidate,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCategoryList,
  useConfirmMerchantLabel,
  useCreateCategory,
  useDeleteCategory,
  useMerchantLabelCandidates,
  useUpdateCategory,
} from "@/lib/queries";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function CategoriesPage() {
  const categoriesQuery = useCategoryList();
  const createMut = useCreateCategory();
  const updateMut = useUpdateCategory();
  const deleteMut = useDeleteCategory();
  const labelCandidatesQuery = useMerchantLabelCandidates();
  const confirmLabelMut = useConfirmMerchantLabel();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<
    Record<string, string>
  >({});
  const [deferredCandidateIds, setDeferredCandidateIds] = useState<string[]>(
    [],
  );
  const [confirmedThisSession, setConfirmedThisSession] = useState(0);

  const all = categoriesQuery.data ?? [];
  const system = all.filter((c) => c.isSystem);
  const custom = all.filter((c) => !c.isSystem);
  const labelCandidates = labelCandidatesQuery.data?.items ?? [];
  const deferredCandidates = new Set(deferredCandidateIds);
  const reviewQueue = labelCandidates.filter(
    (candidate) =>
      !deferredCandidates.has(candidate.representativeTransactionId),
  );
  const activeCandidate = reviewQueue[0] ?? null;
  const deferredInBatch = labelCandidates.length - reviewQueue.length;
  const trainingReadiness = labelCandidatesQuery.data?.trainingReadiness;
  const labelProgress = trainingReadiness
    ? Math.min(
        100,
        Math.round(
          (trainingReadiness.humanConfirmedLabels /
            trainingReadiness.requiredLabels) *
            100,
        ),
      )
    : 0;

  function selectedCategory(candidate: MerchantLabelCandidate): string {
    return (
      selectedLabels[candidate.representativeTransactionId] ??
      candidate.suggestedCategoryId ??
      ""
    );
  }

  async function onConfirmLabel(candidate: MerchantLabelCandidate) {
    const categoryId = selectedCategory(candidate);
    if (!categoryId || confirmLabelMut.isPending) return;
    try {
      await confirmLabelMut.mutateAsync({
        transactionId: candidate.representativeTransactionId,
        categoryId,
      });
      setSelectedLabels((current) => {
        const next = { ...current };
        delete next[candidate.representativeTransactionId];
        return next;
      });
      setDeferredCandidateIds((current) =>
        current.filter(
          (transactionId) =>
            transactionId !== candidate.representativeTransactionId,
        ),
      );
      setConfirmedThisSession((current) => current + 1);
      toast.success("가맹점 카테고리를 사람 확정 라벨로 저장했어요.");
    } catch (err) {
      toast.error(errMsg(err, "가맹점 라벨을 저장하지 못했어요."));
    }
  }

  function onDeferLabel(candidate: MerchantLabelCandidate) {
    setDeferredCandidateIds((current) =>
      current.includes(candidate.representativeTransactionId)
        ? current
        : [...current, candidate.representativeTransactionId],
    );
  }

  async function onCreate() {
    const name = newName.trim();
    if (!name || createMut.isPending) return;
    try {
      await createMut.mutateAsync(name);
      setNewName("");
      toast.success("카테고리를 만들었어요.");
    } catch (err) {
      toast.error(errMsg(err, "카테고리를 만들지 못했어요."));
    }
  }

  async function onRename(id: string) {
    const name = editName.trim();
    if (!name) return;
    try {
      await updateMut.mutateAsync({ id, name });
      setEditingId(null);
      toast.success("이름을 바꿨어요.");
    } catch (err) {
      toast.error(errMsg(err, "이름을 바꾸지 못했어요."));
    }
  }

  async function onDelete(cat: CategorySummary) {
    try {
      await deleteMut.mutateAsync(cat.id);
      toast.success(`'${cat.name}' 카테고리를 삭제했어요.`);
    } catch (err) {
      toast.error(errMsg(err, "삭제하지 못했어요."));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">카테고리 관리</h1>
        <p className="text-muted-foreground text-sm">
          우리 가족만의 지출 카테고리를 만들어요. 만든 카테고리는 AI 자동분류에도
          쓰여요.
        </p>
      </div>

      {/* 모델 학습에는 AI 예측이 아니라 사용자가 명시적으로 확정한 규칙만 사용한다. */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <div className="bg-primary/10 text-primary rounded-full p-2">
            <BrainCircuit className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">가맹점 분류 검토</h2>
            <p className="text-muted-foreground text-[13px]">
              직접 확인한 항목만 AI 학습 라벨로 사용해요. 다른 가족의 비공개
              거래는 표시하지 않아요.
            </p>
          </div>
        </div>

        {trainingReadiness ? (
          <div className="bg-muted/60 flex flex-col gap-3 rounded-lg p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {trainingReadiness.status === "ready"
                    ? "라벨 수집 기준을 충족했어요"
                    : `학습 라벨 ${trainingReadiness.humanConfirmedLabels}/${trainingReadiness.requiredLabels}`}
                </p>
                <p className="text-muted-foreground text-xs">
                  전체 라벨 수집 진행률 {labelProgress}%
                  {confirmedThisSession > 0
                    ? ` · 이번에 ${confirmedThisSession}개 확정`
                    : ""}
                </p>
              </div>
              <span className="bg-background rounded-full px-2 py-1 text-xs font-medium">
                {labelProgress}%
              </span>
            </div>
            <div
              className="bg-background h-2 overflow-hidden rounded-full"
              role="progressbar"
              aria-label="학습 라벨 수집 진행률"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={labelProgress}
            >
              <div
                className="bg-primary h-full rounded-full transition-[width]"
                style={{ width: `${labelProgress}%` }}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <span>
                라벨 {trainingReadiness.humanConfirmedLabels}/
                {trainingReadiness.requiredLabels}
              </span>
              <span>
                클래스 {trainingReadiness.distinctClasses}/
                {trainingReadiness.requiredClasses}
              </span>
              <span>
                최소 클래스 {trainingReadiness.minimumClassLabels}/
                {trainingReadiness.requiredLabelsPerClass}
              </span>
              <span>
                계보{" "}
                {trainingReadiness.missingLineage === 0
                  ? "정상"
                  : `${trainingReadiness.missingLineage}건 누락`}
              </span>
            </div>
          </div>
        ) : null}

        {labelCandidatesQuery.isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 py-3 text-sm">
            <Loader2 className="size-4 animate-spin" /> 검토 항목을 불러오는 중…
          </div>
        ) : labelCandidatesQuery.isError ? (
          <p className="text-destructive text-sm">
            검토할 가맹점을 불러오지 못했어요.
          </p>
        ) : labelCandidates.length === 0 ? (
          <div className="bg-muted/60 rounded-lg px-3 py-4 text-center text-sm">
            현재 확인할 가맹점이 없어요.
          </div>
        ) : activeCandidate === null ? (
          <div className="bg-muted/60 flex flex-col items-center gap-3 rounded-lg px-3 py-4 text-center text-sm">
            <p>
              이번 목록의 {deferredInBatch}개 항목을 모두 나중으로 미뤘어요.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDeferredCandidateIds([])}
            >
              <RotateCcw className="size-4" /> 다시 검토
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">
                현재 목록에서 {reviewQueue.length}개 남음
              </span>
              <span className="font-medium">
                {activeCandidate.source === "model_prediction"
                  ? "AI 추천 우선"
                  : "거래 빈도 우선"}
              </span>
            </div>
            <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all text-sm font-medium">
                    {activeCandidate.merchantNormalized}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    확인 가능한 거래 {activeCandidate.transactionCount}건
                    {activeCandidate.source === "model_prediction"
                      ? " · AI 추천 있음"
                      : " · 미분류"}
                  </p>
                </div>
              </div>
              <Select
                value={selectedCategory(activeCandidate)}
                disabled={confirmLabelMut.isPending}
                onValueChange={(categoryId) =>
                  setSelectedLabels((current) => ({
                    ...current,
                    [activeCandidate.representativeTransactionId]: categoryId,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="카테고리 선택" />
                </SelectTrigger>
                <SelectContent>
                  {all.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  disabled={confirmLabelMut.isPending}
                  onClick={() => onDeferLabel(activeCandidate)}
                >
                  나중에
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  disabled={
                    !selectedCategory(activeCandidate) ||
                    confirmLabelMut.isPending
                  }
                  onClick={() => void onConfirmLabel(activeCandidate)}
                >
                  {confirmLabelMut.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  확정 후 다음
                </Button>
              </div>
            </div>
            {labelCandidatesQuery.data?.hasMore ? (
              <p className="text-muted-foreground text-center text-xs">
                먼저 표시된 항목을 확인하면 다음 가맹점이 이어서 나타나요.
              </p>
            ) : null}
          </div>
        )}
      </Card>

      {/* 새 카테고리 만들기 */}
      <Card className="flex flex-col gap-3 p-4">
        <label htmlFor="new-category" className="text-sm font-medium">
          새 카테고리
        </label>
        <div className="flex gap-2">
          <Input
            id="new-category"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onCreate();
              }
            }}
            placeholder="예: 간식, 반려동물, 경조사"
            maxLength={20}
            disabled={createMut.isPending}
          />
          <Button
            onClick={() => void onCreate()}
            disabled={createMut.isPending || newName.trim() === ""}
          >
            {createMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            추가
          </Button>
        </div>
      </Card>

      {/* 커스텀 카테고리 */}
      <div className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-[13px] font-medium">
          우리 가족 카테고리
        </h2>
        {categoriesQuery.isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 px-1 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" /> 불러오는 중…
          </div>
        ) : custom.length === 0 ? (
          <Card className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm">
            <Tags className="size-6" />
            아직 만든 카테고리가 없어요. 위에서 추가해 보세요.
          </Card>
        ) : (
          <Card className="gap-0 overflow-hidden p-0">
            {custom.map((cat, i) => (
              <div
                key={cat.id}
                className={`flex items-center gap-2 px-4 py-3 ${
                  i > 0 ? "border-t" : ""
                }`}
              >
                {editingId === cat.id ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void onRename(cat.id);
                        }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      maxLength={20}
                      autoFocus
                      disabled={updateMut.isPending}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="저장"
                      onClick={() => void onRename(cat.id)}
                      disabled={updateMut.isPending || editName.trim() === ""}
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="취소"
                      onClick={() => setEditingId(null)}
                      disabled={updateMut.isPending}
                    >
                      <X className="size-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-[15px]">{cat.name}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="이름 수정"
                      onClick={() => {
                        setEditingId(cat.id);
                        setEditName(cat.name);
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="삭제"
                          className="text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            '{cat.name}' 카테고리를 삭제할까요?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            이 카테고리로 분류된 거래는 '미분류'로 되돌아가고,
                            관련 자동분류 규칙·예산도 함께 삭제돼요. 되돌릴 수
                            없어요.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>취소</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => void onDelete(cat)}
                            className="bg-destructive text-white hover:bg-destructive/90"
                          >
                            삭제
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                )}
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* 시스템 기본 카테고리(읽기 전용) */}
      <div className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-[13px] font-medium">
          기본 카테고리
        </h2>
        <Card className="flex flex-wrap gap-2 p-4">
          {system.map((cat) => (
            <span
              key={cat.id}
              className="bg-muted text-muted-foreground rounded-full px-3 py-1 text-[13px]"
            >
              {cat.name}
            </span>
          ))}
        </Card>
        <p className="text-muted-foreground px-1 text-[12px]">
          기본 카테고리는 수정·삭제할 수 없어요.
        </p>
      </div>
    </div>
  );
}
