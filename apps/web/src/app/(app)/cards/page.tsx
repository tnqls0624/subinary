"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 결제 카드 (오늘의집 톤, devices 화면 벤치마킹)
 *
 * 이 화면이 없던 동안 api.cards.create/update 는 호출자 0건의 데드 코드였고,
 * payment_cards 행이 생기지 않아 SMS→거래 자동연결(worker resolveCard)이 항상
 * 실패해 모든 거래가 cardId=null 로 남았다. 이 페이지가 그 끊긴 UI 한 겹을 잇는다.
 *
 * - 카드 = ListRow(카드 아이콘 · alias · issuer/뒤4자리/공개범위 subtitle · 상태 배지)
 *   + 소유자 본인 또는 owner/admin 만 행 우측 ⋯(수정 / 비활성·재활성) 노출(서버 §5.1과 일치).
 * - maskedNumber '뒤 4자리'는 자동연결의 유일한 조인 키 → 강하게 유도(숫자 4자리 제한,
 *   미입력/중복 시 경고). 전체 PAN 붙여넣기는 maxLength=4+숫자필터로 UI 레벨 차단.
 * - visibility 는 이후 자동연결 거래에 '그 시점 값'으로 상속된다(소급 없음).
 * ------------------------------------------------------------------------- */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CreditCard, MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import type {
  CardCreateRequest,
  CardSummary,
  CardUpdateRequest,
  CardVisibility,
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ListRow, StatusBadge } from "@/components/widgets";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { queryKeys, useCardList, useHouseholdMembers } from "@/lib/queries";

/** 표준 카드사 목록 — 분석 라벨('alias · issuer') 표기 일관성을 위해 자유입력 대신 고정. */
const ISSUER_OPTIONS = [
  "신한",
  "삼성",
  "현대",
  "KB국민",
  "롯데",
  "하나",
  "우리",
  "BC",
  "NH농협",
  "카카오뱅크",
  "토스뱅크",
  "기타",
] as const;

/** visibility 선택지 + 설명(이후 자동연결 거래에 상속되는 프라이버시 값). */
const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: CardVisibility;
  label: string;
  description: string;
}> = [
  {
    value: "household",
    label: "가족 공개",
    description: "가맹점과 금액을 가족과 모두 공유해요.",
  },
  {
    value: "summary_only",
    label: "요약만 공유",
    description: "금액만 공유하고 가맹점은 가족에게 비공개예요.",
  },
  {
    value: "private",
    label: "나만 보기",
    description: "가족에게 보이지 않고 가족 합계에서도 빠져요.",
  },
];

const VISIBILITY_LABEL: Record<CardVisibility, string> = {
  household: "가족 공개",
  summary_only: "요약만 공유",
  private: "나만 보기",
};

/** owner/admin 은 소유하지 않은 카드도 관리할 수 있다(서버 §5.1과 일치). */
const MANAGER_ROLES = ["owner", "admin"] as const;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** '****1234' / '1234' 등 저장 포맷 차이를 흡수해 뒤 4자리만 뽑는다. */
function lastFour(masked: string | null | undefined): string {
  if (!masked) return "";
  return masked.replace(/\D/g, "").slice(-4);
}

export default function CardsPage() {
  const { authedFetch, user } = useAuth();
  const { householdId, activeMembership } = useHousehold();
  const queryClient = useQueryClient();

  const cardsQuery = useCardList();
  const membersQuery = useHouseholdMembers();

  // 정확 권한 게이팅: 내 memberId 역산(activeMembership 엔 role 만 있고 memberId 는 없음).
  const myMemberId = useMemo(
    () =>
      membersQuery.data?.find((m) => m.userId === user?.id)?.memberId ?? null,
    [membersQuery.data, user?.id],
  );
  const isManagerRole = MANAGER_ROLES.includes(
    activeMembership?.role as (typeof MANAGER_ROLES)[number],
  );
  const canManage = (card: CardSummary) =>
    isManagerRole || (myMemberId != null && card.ownerMemberId === myMemberId);

  // 등록 폼 상태(단순 폼 → useState + FormEvent 수동검증, devices 패턴).
  const [registerOpen, setRegisterOpen] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [alias, setAlias] = useState("");
  const [masked, setMasked] = useState("");
  const [visibility, setVisibility] = useState<CardVisibility>("household");
  const [formError, setFormError] = useState<string | null>(null);

  // 수정 다이얼로그 상태(alias/visibility 만 — maskedNumber 는 계약상 수정 불가).
  const [editing, setEditing] = useState<CardSummary | null>(null);
  const [editAlias, setEditAlias] = useState("");
  const [editVisibility, setEditVisibility] =
    useState<CardVisibility>("household");
  const [editError, setEditError] = useState<string | null>(null);

  // 상태 전환(비활성/재활성) 확인.
  const [confirm, setConfirm] = useState<
    { type: "deactivate" | "reactivate"; card: CardSummary } | null
  >(null);

  const cards = cardsQuery.data ?? [];

  // 뒤 4자리 중복 감지(non-blocking 경고) — 활성 카드 대상, 자동연결이 섞일 수 있음.
  const maskedTail = lastFour(masked);
  const duplicateTail =
    maskedTail.length === 4 &&
    cards.some(
      (c) => c.status === "active" && lastFour(c.maskedNumber) === maskedTail,
    );

  const invalidateCards = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.cards(householdId),
    });
    // 카드별 집계(CardBreakdown)의 alias·issuer 라벨/합계 갱신.
    void queryClient.invalidateQueries({ queryKey: ["analytics"] });
  };

  const createMutation = useMutation({
    mutationFn: (body: CardCreateRequest) =>
      authedFetch((token) => api.cards.create(token, body)),
    onSuccess: (result) => {
      invalidateCards();
      // 소급 연결(backfill)이 과거 거래를 건드렸으면 목록/집계도 갱신하고 알린다.
      if (result.linkedTransactionCount > 0) {
        void queryClient.invalidateQueries({ queryKey: ["transactions"] });
        void queryClient.invalidateQueries({ queryKey: ["budgets"] });
        toast.success(
          `과거 거래 ${result.linkedTransactionCount}건을 이 카드에 연결했어요.`,
        );
      }
      setIssuer("");
      setAlias("");
      setMasked("");
      setVisibility("household");
      setFormError(null);
      setRegisterOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; body: CardUpdateRequest }) =>
      authedFetch((token) => api.cards.update(token, input.id, input.body)),
    onSuccess: () => {
      invalidateCards();
      setEditing(null);
      setConfirm(null);
    },
  });

  function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!householdId) return;
    if (issuer === "") {
      setFormError("카드사를 선택해 주세요.");
      return;
    }
    if (alias.trim() === "") {
      setFormError("카드 별칭을 입력해 주세요.");
      return;
    }
    createMutation.mutate({
      householdId,
      issuer,
      alias: alias.trim(),
      // 뒤 4자리는 선택이지만 자동연결의 유일한 키 → 4자리일 때만 전송, 아니면 생략.
      maskedNumber: maskedTail.length === 4 ? maskedTail : undefined,
      visibility,
    });
  }

  function openEdit(card: CardSummary) {
    setEditing(card);
    setEditAlias(card.alias);
    setEditVisibility(card.visibility);
    setEditError(null);
  }

  function onEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEditError(null);
    if (!editing) return;
    if (editAlias.trim() === "") {
      setEditError("카드 별칭을 입력해 주세요.");
      return;
    }
    updateMutation.mutate({
      id: editing.id,
      body: { alias: editAlias.trim(), visibility: editVisibility },
    });
  }

  function runConfirm() {
    if (!confirm) return;
    updateMutation.mutate({
      id: confirm.card.id,
      body: { status: confirm.type === "deactivate" ? "inactive" : "active" },
    });
  }

  const isEmpty =
    !cardsQuery.isLoading && !cardsQuery.isError && cards.length === 0;
  const selectedVisibility = VISIBILITY_OPTIONS.find(
    (o) => o.value === visibility,
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">결제 카드</h1>
        <p className="text-muted-foreground text-sm">
          카드를 등록하면 카드 문자가 이 카드에 자동으로 연결돼요.
        </p>
      </div>

      {/* 카드 목록 */}
      <Card>
        <CardHeader>
          <CardTitle>등록된 카드</CardTitle>
          <CardDescription>
            뒤 4자리로 문자를 자동 연결하고, 공개 범위를 카드별로 정해요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cardsQuery.isLoading ? (
            <div className="flex flex-col gap-3 py-2">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </div>
          ) : cardsQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {errorMessage(cardsQuery.error, "카드를 불러오지 못했어요.")}
            </p>
          ) : cards.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="bg-muted flex size-12 items-center justify-center rounded-full">
                <CreditCard
                  className="text-muted-foreground size-6"
                  aria-hidden="true"
                />
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-[15px] font-semibold">
                  아직 등록된 카드가 없어요
                </p>
                <p className="text-muted-foreground text-[13px]">
                  카드를 등록하면 문자 내역이 자동으로 연결돼요
                </p>
              </div>
              <Button
                type="button"
                className="mt-1"
                onClick={() => setRegisterOpen(true)}
              >
                <Plus /> 카드 등록하기
              </Button>
            </div>
          ) : (
            <div className="flex flex-col">
              {cards.map((c) => {
                const tail = lastFour(c.maskedNumber);
                const subtitle = `${c.issuer} · ${
                  tail ? `•••• ${tail}` : "뒤 4자리 미등록"
                } · ${VISIBILITY_LABEL[c.visibility]}`;
                return (
                  <div key={c.id} className="flex items-center gap-1">
                    <ListRow
                      className="min-w-0 flex-1"
                      icon={<CreditCard />}
                      title={c.alias}
                      subtitle={subtitle}
                      valueSub={<StatusBadge status={c.status} />}
                    />
                    {canManage(c) ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            aria-label={`${c.alias} 관리 메뉴`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={updateMutation.isPending}
                            onSelect={() => openEdit(c)}
                          >
                            수정
                          </DropdownMenuItem>
                          {c.status === "active" ? (
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={updateMutation.isPending}
                              onSelect={() =>
                                setConfirm({ type: "deactivate", card: c })
                              }
                            >
                              비활성화
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={updateMutation.isPending}
                              onSelect={() =>
                                setConfirm({ type: "reactivate", card: c })
                              }
                            >
                              다시 활성화
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {updateMutation.isError ? (
            <p className="text-destructive mt-3 text-sm" role="alert">
              {errorMessage(updateMutation.error, "카드를 수정하지 못했어요.")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* 주 CTA — 빈 상태에서는 빈 상태 안의 CTA 하나만 노출 */}
      {!isEmpty ? (
        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={() => setRegisterOpen(true)}
        >
          <Plus /> 카드 등록
        </Button>
      ) : null}

      {/* 등록 Dialog */}
      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>카드 등록</DialogTitle>
            <DialogDescription>
              등록 후 도착하는 카드 문자부터 이 카드에 자동으로 연결돼요.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onRegister} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="card-issuer">카드사</Label>
              <Select value={issuer} onValueChange={setIssuer}>
                <SelectTrigger id="card-issuer" className="w-full">
                  <SelectValue placeholder="카드사를 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {ISSUER_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="card-alias">별칭</Label>
              <Input
                id="card-alias"
                type="text"
                placeholder="예: 생활비카드"
                maxLength={100}
                required
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="card-masked">카드번호 뒤 4자리</Label>
              <Input
                id="card-masked"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="1234"
                maxLength={4}
                value={masked}
                onChange={(e) =>
                  setMasked(e.target.value.replace(/\D/g, "").slice(0, 4))
                }
              />
              {maskedTail.length > 0 && maskedTail.length < 4 ? (
                <p className="text-muted-foreground text-[13px]">
                  숫자 4자리를 모두 입력해 주세요.
                </p>
              ) : maskedTail.length === 0 ? (
                <p className="text-muted-foreground text-[13px]">
                  비워 두면 이 카드로는 문자가 자동 연결되지 않아요.
                </p>
              ) : duplicateTail ? (
                <p className="text-[13px] text-amber-600 dark:text-amber-500">
                  뒤 4자리가 같은 카드가 이미 있어요. 문자가 어느 카드에 연결될지
                  섞일 수 있어요.
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="card-visibility">공개 범위</Label>
              <Select
                value={visibility}
                onValueChange={(v) => setVisibility(v as CardVisibility)}
              >
                <SelectTrigger id="card-visibility" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISIBILITY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedVisibility ? (
                <p className="text-muted-foreground text-[13px]">
                  {selectedVisibility.description} 앞으로 들어올 거래에
                  적용되며, 나중에 바꿔도 기존 거래엔 반영되지 않아요.
                </p>
              ) : null}
            </div>

            {formError ? (
              <p className="text-destructive text-sm" role="alert">
                {formError}
              </p>
            ) : null}
            {createMutation.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {errorMessage(createMutation.error, "카드를 등록하지 못했어요.")}
              </p>
            ) : null}
            <DialogFooter className="flex-col sm:flex-col">
              <Button
                type="submit"
                className="h-11 w-full"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "등록하고 있어요…" : "등록하기"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-full"
                onClick={() => setRegisterOpen(false)}
              >
                다음에 할게요
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 수정 Dialog */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>카드 수정</DialogTitle>
            <DialogDescription>
              별칭과 공개 범위를 바꿀 수 있어요. 뒤 4자리는 변경할 수 없어요.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onEditSubmit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-alias">별칭</Label>
              <Input
                id="edit-alias"
                type="text"
                maxLength={100}
                required
                value={editAlias}
                onChange={(e) => setEditAlias(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-visibility">공개 범위</Label>
              <Select
                value={editVisibility}
                onValueChange={(v) => setEditVisibility(v as CardVisibility)}
              >
                <SelectTrigger id="edit-visibility" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISIBILITY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-[13px]">
                공개 범위 변경은 앞으로 들어올 거래에만 적용돼요.
              </p>
            </div>
            {editError ? (
              <p className="text-destructive text-sm" role="alert">
                {editError}
              </p>
            ) : null}
            {updateMutation.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {errorMessage(updateMutation.error, "카드를 수정하지 못했어요.")}
              </p>
            ) : null}
            <DialogFooter className="flex-col sm:flex-col">
              <Button
                type="submit"
                className="h-11 w-full"
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? "저장하고 있어요…" : "저장하기"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-full"
                onClick={() => setEditing(null)}
              >
                취소
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 상태 전환 확인 */}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.type === "deactivate"
                ? "이 카드를 비활성화할까요?"
                : "이 카드를 다시 활성화할까요?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.type === "deactivate"
                ? `'${confirm.card.alias}' 카드를 비활성화하면 새로 도착하는 문자가 이 카드에 더 이상 자동 연결되지 않아요. 기존 거래는 그대로 남아요.`
                : confirm
                  ? `'${confirm.card.alias}' 카드를 다시 활성화하면 뒤 4자리가 맞는 문자가 다시 이 카드에 연결돼요.`
                  : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={runConfirm}
              className={
                confirm?.type === "deactivate"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
            >
              {confirm?.type === "deactivate" ? "비활성화" : "다시 활성화"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
