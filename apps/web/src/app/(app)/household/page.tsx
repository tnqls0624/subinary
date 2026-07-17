"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 가족 (오늘의집 톤)
 *
 * - 구성원 = ListRow(이니셜 원형 아바타 · 이름 · 이메일 subtitle · 역할
 *   Select(소유자만)/역할 라벨 + 상태 배지) + 나가기/내보내기.
 * - "초대하기" 주 CTA(소유자) → 초대 Dialog(기존 RHF 폼 이동, 로직 보존).
 * - 대기 초대 = ListRow + 취소. 토큰/링크 1회 노출 Dialog + 복사 보존.
 * 권한은 서버에서도 강제(PRD §26). 여기서는 UI 노출/비활성으로 보조.
 * 파괴적 동작(내보내기/나가기/취소)은 AlertDialog로 확인.
 * ------------------------------------------------------------------------- */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Mail, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import type {
  HouseholdRole,
  InvitationCreated,
  InvitationCreateRequest,
  InvitationSummary,
  MemberSummary,
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
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
import { useHouseholdMembers } from "@/lib/queries";
import { formatDate } from "@/lib/format";

const ROLE_LABEL: Record<HouseholdRole, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "구성원",
  viewer: "뷰어",
};

type InvitableRole = "admin" | "member" | "viewer";
const INVITABLE_ROLES: ReadonlyArray<InvitableRole> = [
  "member",
  "admin",
  "viewer",
];

/** 초대 폼: email은 빈 문자열 허용(→ 미지정), expiresInHours는 1~720 정수. */
const inviteFormSchema = z.object({
  email: z
    .union([z.literal(""), z.string().email("올바른 이메일 형식이 아니에요")])
    .optional(),
  role: z.enum(["member", "admin", "viewer"]),
  expiresInHours: z.coerce
    .number()
    .int("정수로 입력해 주세요")
    .min(1, "1~720 사이로 입력해 주세요")
    .max(720, "1~720 사이로 입력해 주세요"),
});
type InviteFormValues = z.input<typeof inviteFormSchema>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export default function HouseholdPage() {
  const { authedFetch, user } = useAuth();
  const { householdId, activeMembership } = useHousehold();
  const queryClient = useQueryClient();

  const myRole = activeMembership?.role;
  const isOwner = myRole === "owner";
  const canViewInvitations = myRole === "owner" || myRole === "admin";

  const membersQuery = useHouseholdMembers();
  const invitationsQuery = useQuery({
    queryKey: ["household-invitations", householdId],
    enabled: householdId != null && canViewInvitations,
    queryFn: () =>
      authedFetch((token) =>
        api.households.invitations(token, householdId as string),
      ),
  });

  // "초대하기" 주 CTA → 초대 Dialog.
  const [inviteOpen, setInviteOpen] = useState(false);

  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<
    | { type: "remove" | "leave"; member: MemberSummary }
    | { type: "revoke"; invitation: InvitationSummary }
    | null
  >(null);

  const invalidateMembers = () =>
    queryClient.invalidateQueries({
      queryKey: ["household-members", householdId],
    });
  const invalidateInvitations = () =>
    queryClient.invalidateQueries({
      queryKey: ["household-invitations", householdId],
    });

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteFormSchema),
    defaultValues: { email: "", role: "member", expiresInHours: 168 },
  });

  const inviteMutation = useMutation({
    mutationFn: (body: InvitationCreateRequest) =>
      authedFetch((token) =>
        api.households.invite(token, householdId as string, body),
      ),
    onSuccess: (result) => {
      void invalidateInvitations();
      form.reset({ email: "", role: "member", expiresInHours: 168 });
      setCopied(false);
      setInviteOpen(false);
      setCreated(result);
      toast.success("초대를 만들었어요.");
    },
    onError: (error) =>
      toast.error(errorMessage(error, "초대를 만들지 못했어요.")),
  });

  const roleMutation = useMutation({
    mutationFn: (input: { memberId: string; role: InvitableRole }) =>
      authedFetch((token) =>
        api.households.updateRole(token, householdId as string, input.memberId, {
          role: input.role,
        }),
      ),
    onSuccess: () => {
      void invalidateMembers();
      toast.success("역할을 변경했어요.");
    },
    onError: (error) =>
      toast.error(errorMessage(error, "역할을 변경하지 못했어요.")),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      authedFetch((token) =>
        api.households.removeMember(token, householdId as string, memberId),
      ),
    onSuccess: () => {
      void invalidateMembers();
      toast.success("처리했어요.");
    },
    onError: (error) =>
      toast.error(errorMessage(error, "구성원을 내보내지 못했어요.")),
  });

  const revokeMutation = useMutation({
    mutationFn: (invitationId: string) =>
      authedFetch((token) =>
        api.households.revokeInvite(token, householdId as string, invitationId),
      ),
    onSuccess: () => {
      void invalidateInvitations();
      toast.success("초대를 취소했어요.");
    },
    onError: (error) =>
      toast.error(errorMessage(error, "초대를 취소하지 못했어요.")),
  });

  function onInvite(values: InviteFormValues) {
    if (!householdId) return;
    const email = values.email?.trim();
    const body: InvitationCreateRequest = {
      role: values.role,
      expiresInHours: Number(values.expiresInHours),
      ...(email ? { email } : {}),
    };
    inviteMutation.mutate(body);
  }

  function inviteLink(c: InvitationCreated): string {
    const path = `/join?token=${encodeURIComponent(c.token)}`;
    return typeof window !== "undefined"
      ? `${window.location.origin}${path}`
      : path;
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(inviteLink(created));
      setCopied(true);
      toast.success("수락 링크를 복사했어요.");
    } catch {
      toast.error("복사하지 못했어요. 직접 복사해 주세요.");
    }
  }

  function runConfirm() {
    if (!confirm) return;
    if (confirm.type === "revoke") {
      revokeMutation.mutate(confirm.invitation.id);
    } else {
      removeMutation.mutate(confirm.member.memberId);
    }
    setConfirm(null);
  }

  const members = membersQuery.data ?? [];
  const invitations = invitationsQuery.data ?? [];
  const busy = removeMutation.isPending || revokeMutation.isPending;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">가족</h1>
        <p className="text-muted-foreground text-sm">
          {activeMembership?.name
            ? `${activeMembership.name} 가족의 구성원과 초대를 관리해요.`
            : "가족 구성원과 초대를 관리해요."}
        </p>
      </div>

      {/* 구성원 */}
      <Card>
        <CardHeader>
          <CardTitle>구성원</CardTitle>
          <CardDescription>
            함께 쓰는 가족의 역할과 상태를 한눈에 볼 수 있어요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {membersQuery.isLoading ? (
            <div className="flex flex-col gap-3 py-2">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </div>
          ) : membersQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {errorMessage(membersQuery.error, "구성원을 불러오지 못했어요.")}
            </p>
          ) : members.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="bg-muted flex size-12 items-center justify-center rounded-full">
                <Users
                  className="text-muted-foreground size-6"
                  aria-hidden="true"
                />
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-[15px] font-semibold">
                  아직 구성원이 없어요
                </p>
                <p className="text-muted-foreground text-[13px]">
                  초대 링크를 만들어 가족을 초대해 보세요
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              {members.map((m) => {
                const editable =
                  isOwner && m.status === "active" && m.role !== "owner";
                const isSelf = m.userId === user?.id;
                const canRemove =
                  m.status === "active" &&
                  m.role !== "owner" &&
                  (isOwner || isSelf);
                return (
                  <div key={m.memberId} className="flex items-center gap-1">
                    <ListRow
                      className="min-w-0 flex-1"
                      icon={
                        <span className="text-sm font-semibold">
                          {m.name.slice(0, 1) || "?"}
                        </span>
                      }
                      title={
                        isSelf ? (
                          <span className="inline-flex items-center gap-1.5">
                            {m.name}
                            <span className="bg-muted text-muted-foreground rounded px-1 py-0.5 text-[11px] font-medium">
                              나
                            </span>
                          </span>
                        ) : (
                          m.name
                        )
                      }
                      subtitle={m.email}
                      value={
                        editable ? (
                          <Select
                            value={m.role}
                            onValueChange={(role) =>
                              role !== m.role &&
                              roleMutation.mutate({
                                memberId: m.memberId,
                                role: role as InvitableRole,
                              })
                            }
                            disabled={roleMutation.isPending}
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label={`${m.name} 역할 변경`}
                              className="h-8 rounded-full border bg-card px-3 text-[13px] font-medium shadow-none"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {INVITABLE_ROLES.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {ROLE_LABEL[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span
                            className={
                              m.role === "owner"
                                ? "text-[13px] font-semibold"
                                : "text-muted-foreground text-[13px] font-medium"
                            }
                          >
                            {ROLE_LABEL[m.role]}
                          </span>
                        )
                      }
                      valueSub={<StatusBadge status={m.status} />}
                    />
                    {canRemove ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive shrink-0 px-2"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            type: isSelf ? "leave" : "remove",
                            member: m,
                          })
                        }
                      >
                        {isSelf ? "나가기" : "내보내기"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 주 CTA — 초대 Dialog 열기 (소유자) */}
      {isOwner ? (
        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={() => setInviteOpen(true)}
        >
          <UserPlus /> 초대하기
        </Button>
      ) : null}

      {/* 대기 초대 (소유자·관리자) */}
      {canViewInvitations ? (
        <Card>
          <CardHeader>
            <CardTitle>초대 현황</CardTitle>
            <CardDescription>보낸 초대의 상태를 확인해요.</CardDescription>
          </CardHeader>
          <CardContent>
            {invitationsQuery.isLoading ? (
              <div className="flex flex-col gap-3 py-2">
                <Skeleton className="h-14 w-full rounded-lg" />
              </div>
            ) : invitationsQuery.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {errorMessage(
                  invitationsQuery.error,
                  "초대를 불러오지 못했어요.",
                )}
              </p>
            ) : invitations.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <span className="bg-muted flex size-12 items-center justify-center rounded-full">
                  <Mail
                    className="text-muted-foreground size-6"
                    aria-hidden="true"
                  />
                </span>
                <div className="flex flex-col gap-1">
                  <p className="text-[15px] font-semibold">
                    아직 보낸 초대가 없어요
                  </p>
                  <p className="text-muted-foreground text-[13px]">
                    초대하기를 누르면 수락 링크를 만들 수 있어요
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col">
                {invitations.map((i) => (
                  <div key={i.id} className="flex items-center gap-1">
                    <ListRow
                      className="min-w-0 flex-1"
                      icon={<Mail />}
                      iconClassName="bg-muted text-muted-foreground"
                      title={
                        i.email ?? (
                          <span className="text-muted-foreground">
                            이메일 지정 없음
                          </span>
                        )
                      }
                      subtitle={`${ROLE_LABEL[i.role]} 초대 · ${formatDate(i.expiresAt)}까지`}
                      valueSub={<StatusBadge status={i.status} />}
                    />
                    {isOwner && i.status === "pending" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive shrink-0 px-2"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({ type: "revoke", invitation: i })
                        }
                      >
                        취소
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* 초대 Dialog (소유자) — 기존 RHF 폼 이동, 로직 보존 */}
      {isOwner ? (
        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>가족 초대하기</DialogTitle>
              <DialogDescription>
                이메일은 적지 않아도 돼요. 만들면 수락 링크가 딱 한 번 표시돼요.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onInvite)}
                className="flex flex-col gap-4"
                noValidate
              >
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>이메일 (선택)</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="초대할 사람의 이메일"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>역할</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {INVITABLE_ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {ROLE_LABEL[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="expiresInHours"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>만료 (시간)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={720}
                            name={field.name}
                            ref={field.ref}
                            onBlur={field.onBlur}
                            value={String(field.value ?? "")}
                            onChange={(e) => field.onChange(e.target.value)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <DialogFooter className="flex-col sm:flex-col">
                  <Button
                    type="submit"
                    className="h-11 w-full"
                    disabled={inviteMutation.isPending}
                  >
                    {inviteMutation.isPending
                      ? "만들고 있어요…"
                      : "초대 만들기"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11 w-full"
                    onClick={() => setInviteOpen(false)}
                  >
                    다음에 할게요
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* 초대 생성 결과 — 토큰/링크 1회 노출 */}
      <Dialog
        open={created !== null}
        onOpenChange={(o) => !o && setCreated(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>초대 링크가 만들어졌어요</DialogTitle>
            <DialogDescription>
              <span className="text-destructive font-semibold">
                지금만 볼 수 있어요.
              </span>{" "}
              창을 닫기 전에 초대할 가족에게 링크를 전달해 주세요.
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="flex flex-col gap-4">
              <div className="bg-muted grid grid-cols-2 gap-3 rounded-lg p-3 text-sm">
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground text-xs">역할</span>
                  <span className="font-medium">
                    {ROLE_LABEL[created.role]}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground text-xs">만료</span>
                  <span className="font-medium">
                    {formatDate(created.expiresAt)}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-xs">
                  수락 링크
                </span>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={inviteLink(created)}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={copyLink}
                    aria-label="수락 링크 복사"
                  >
                    {copied ? (
                      <Check className="size-4" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter className="flex-col sm:flex-col">
            <Button className="h-11 w-full" onClick={() => setCreated(null)}>
              전달했어요
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 파괴적 동작 확인 */}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.type === "leave"
                ? "가족에서 나갈까요?"
                : confirm?.type === "remove"
                  ? "구성원을 내보낼까요?"
                  : "초대를 취소할까요?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.type === "leave"
                ? "이 가족에서 나가요. 다시 함께하려면 새 초대가 필요해요."
                : confirm?.type === "remove"
                  ? `'${confirm.member.name}' 님을 가족에서 내보내요. 필요하면 언제든 다시 초대할 수 있어요.`
                  : "초대를 취소하면 보냈던 링크가 더 이상 동작하지 않아요."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={runConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : confirm?.type === "leave" ? (
                "나가기"
              ) : confirm?.type === "remove" ? (
                "내보내기"
              ) : (
                "초대 취소"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
