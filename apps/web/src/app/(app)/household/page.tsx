"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 가족 관리 (Phase 5 §6.2 P8)
 *
 * - 구성원 목록: 이름 / 이메일 / 역할 / 상태. 역할 변경 select(소유자만), 제거.
 * - 초대 생성(소유자): 이메일(선택)·역할·만료 → 토큰/수락 링크 1회 노출 모달.
 * - 대기 중 초대 목록(소유자·관리자): 상태 표시 + 취소(revoke).
 * 권한은 서버에서도 강제되며(PRD §26), 여기서는 UI 노출/비활성으로 보조한다.
 * ------------------------------------------------------------------------- */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  HouseholdRole,
  InvitationCreated,
  InvitationCreateRequest,
  InvitationSummary,
  MemberRoleUpdateRequest,
  MemberSummary,
} from "@family/contracts";

import {
  Button,
  Field,
  Modal,
  Select,
  StatusBadge,
  Table,
  type SelectOption,
  type TableColumn,
} from "@/components";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { useHouseholdMembers } from "@/lib/queries";
import { formatDate } from "@/lib/format";

/** 역할 표시 라벨. */
const ROLE_LABEL: Record<HouseholdRole, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "구성원",
  viewer: "뷰어",
};

/** 소유자가 부여/변경할 수 있는 역할(소유권 이전은 범위 밖). */
type InvitableRole = "admin" | "member" | "viewer";

const INVITABLE_ROLE_OPTIONS: ReadonlyArray<SelectOption> = [
  { value: "member", label: ROLE_LABEL.member },
  { value: "admin", label: ROLE_LABEL.admin },
  { value: "viewer", label: ROLE_LABEL.viewer },
];

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

  // --- 초대 폼 상태 ---------------------------------------------------------
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitableRole>("member");
  const [inviteHours, setInviteHours] = useState("168");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidateMembers = () =>
    queryClient.invalidateQueries({
      queryKey: ["household-members", householdId],
    });
  const invalidateInvitations = () =>
    queryClient.invalidateQueries({
      queryKey: ["household-invitations", householdId],
    });

  const inviteMutation = useMutation({
    mutationFn: (body: InvitationCreateRequest) =>
      authedFetch((token) =>
        api.households.invite(token, householdId as string, body),
      ),
    onSuccess: (result) => {
      void invalidateInvitations();
      setInviteEmail("");
      setInviteRole("member");
      setInviteHours("168");
      setInviteError(null);
      setCopied(false);
      setCreated(result);
    },
  });

  const roleMutation = useMutation({
    mutationFn: (input: { memberId: string; body: MemberRoleUpdateRequest }) =>
      authedFetch((token) =>
        api.households.updateRole(
          token,
          householdId as string,
          input.memberId,
          input.body,
        ),
      ),
    onSuccess: () => void invalidateMembers(),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      authedFetch((token) =>
        api.households.removeMember(token, householdId as string, memberId),
      ),
    onSuccess: () => void invalidateMembers(),
  });

  const revokeMutation = useMutation({
    mutationFn: (invitationId: string) =>
      authedFetch((token) =>
        api.households.revokeInvite(
          token,
          householdId as string,
          invitationId,
        ),
      ),
    onSuccess: () => void invalidateInvitations(),
  });

  function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteError(null);
    if (!householdId) return;

    let expiresInHours = 168;
    if (inviteHours.trim() !== "") {
      const parsed = Number(inviteHours);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 720) {
        setInviteError("만료 시간은 1~720시간 사이의 정수여야 합니다.");
        return;
      }
      expiresInHours = parsed;
    }

    const body: InvitationCreateRequest = {
      role: inviteRole,
      expiresInHours,
      ...(inviteEmail.trim() !== "" ? { email: inviteEmail.trim() } : {}),
    };
    inviteMutation.mutate(body);
  }

  function onRoleChange(member: MemberSummary, role: string) {
    if (role === member.role) return;
    roleMutation.mutate({
      memberId: member.memberId,
      body: { role: role as InvitableRole },
    });
  }

  function onRemove(member: MemberSummary) {
    const isSelf = member.userId === user?.id;
    const question = isSelf
      ? "이 가족에서 나가시겠어요?"
      : `'${member.name}' 구성원을 가족에서 제거할까요?`;
    if (!window.confirm(question)) return;
    removeMutation.mutate(member.memberId);
  }

  function onRevoke(invitation: InvitationSummary) {
    if (!window.confirm("이 초대를 취소할까요?")) return;
    revokeMutation.mutate(invitation.id);
  }

  async function copyLink() {
    if (!created) return;
    const link =
      typeof window !== "undefined"
        ? `${window.location.origin}${created.acceptUrlPath}`
        : created.acceptUrlPath;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const members = membersQuery.data ?? [];

  const memberColumns: ReadonlyArray<TableColumn<MemberSummary>> = [
    { key: "name", header: "이름", render: (m) => m.name },
    { key: "email", header: "이메일", render: (m) => m.email },
    {
      key: "role",
      header: "역할",
      render: (m) => {
        const editable =
          isOwner && m.status === "active" && m.role !== "owner";
        if (!editable) {
          return (
            <span className={m.role === "owner" ? "" : "text-muted"}>
              {ROLE_LABEL[m.role]}
            </span>
          );
        }
        return (
          <Select
            aria-label={`${m.name} 역할`}
            options={INVITABLE_ROLE_OPTIONS}
            value={m.role}
            disabled={roleMutation.isPending}
            onChange={(e) => onRoleChange(m, e.target.value)}
          />
        );
      },
    },
    {
      key: "status",
      header: "상태",
      render: (m) => <StatusBadge status={m.status} />,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (m) => {
        const isSelf = m.userId === user?.id;
        const canRemove =
          m.status === "active" &&
          m.role !== "owner" &&
          (isOwner || isSelf);
        if (!canRemove) return <span className="text-subtle">—</span>;
        return (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onRemove(m)}
            disabled={removeMutation.isPending}
          >
            {isSelf ? "나가기" : "제거"}
          </button>
        );
      },
    },
  ];

  const invitationColumns: ReadonlyArray<TableColumn<InvitationSummary>> = [
    {
      key: "email",
      header: "이메일",
      render: (i) => i.email ?? <span className="text-subtle">지정 없음</span>,
    },
    { key: "role", header: "역할", render: (i) => ROLE_LABEL[i.role] },
    {
      key: "status",
      header: "상태",
      render: (i) => <StatusBadge status={i.status} />,
    },
    {
      key: "expiresAt",
      header: "만료",
      render: (i) => formatDate(i.expiresAt),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (i) =>
        isOwner && i.status === "pending" ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onRevoke(i)}
            disabled={revokeMutation.isPending}
          >
            취소
          </button>
        ) : (
          <span className="text-subtle">—</span>
        ),
    },
  ];

  return (
    <div className="stack">
      <h1 className="section-title">가족</h1>

      {/* 구성원 ----------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-title">구성원</div>
        {membersQuery.isLoading ? (
          <p className="empty">불러오는 중…</p>
        ) : membersQuery.isError ? (
          <p className="form-error" role="alert">
            {errorMessage(membersQuery.error, "구성원을 불러오지 못했습니다.")}
          </p>
        ) : (
          <Table
            columns={memberColumns}
            rows={members}
            rowKey={(m) => m.memberId}
            emptyLabel="구성원이 없습니다"
          />
        )}
        {roleMutation.isError ? (
          <p className="form-error" role="alert" style={{ marginTop: 12 }}>
            {errorMessage(roleMutation.error, "역할 변경에 실패했습니다.")}
          </p>
        ) : null}
        {removeMutation.isError ? (
          <p className="form-error" role="alert" style={{ marginTop: 12 }}>
            {errorMessage(removeMutation.error, "구성원 제거에 실패했습니다.")}
          </p>
        ) : null}
      </section>

      {/* 초대 생성(소유자) ------------------------------------------------ */}
      {isOwner ? (
        <section className="panel">
          <div className="panel-title">구성원 초대</div>
          <form className="stack" onSubmit={onInvite} noValidate>
            <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
              <Field
                label="이메일 (선택)"
                name="invite-email"
                type="email"
                placeholder="초대할 사람의 이메일"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
              <label className="field">
                <span className="field-label">역할</span>
                <Select
                  options={INVITABLE_ROLE_OPTIONS}
                  value={inviteRole}
                  onChange={(e) =>
                    setInviteRole(e.target.value as InvitableRole)
                  }
                />
              </label>
              <Field
                label="만료 (시간)"
                name="invite-hours"
                type="number"
                inputMode="numeric"
                min={1}
                max={720}
                step={1}
                value={inviteHours}
                onChange={(e) => setInviteHours(e.target.value)}
              />
            </div>
            {inviteError ? (
              <p className="form-error" role="alert">
                {inviteError}
              </p>
            ) : null}
            {inviteMutation.isError ? (
              <p className="form-error" role="alert">
                {errorMessage(inviteMutation.error, "초대 생성에 실패했습니다.")}
              </p>
            ) : null}
            <div>
              <Button
                type="submit"
                variant="primary"
                disabled={inviteMutation.isPending}
              >
                {inviteMutation.isPending ? "생성 중…" : "초대 생성"}
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      {/* 대기 중 초대(소유자·관리자) -------------------------------------- */}
      {canViewInvitations ? (
        <section className="panel">
          <div className="panel-title">초대 현황</div>
          {invitationsQuery.isLoading ? (
            <p className="empty">불러오는 중…</p>
          ) : invitationsQuery.isError ? (
            <p className="form-error" role="alert">
              {errorMessage(
                invitationsQuery.error,
                "초대를 불러오지 못했습니다.",
              )}
            </p>
          ) : (
            <Table
              columns={invitationColumns}
              rows={invitationsQuery.data ?? []}
              rowKey={(i) => i.id}
              emptyLabel="발급된 초대가 없습니다"
            />
          )}
          {revokeMutation.isError ? (
            <p className="form-error" role="alert" style={{ marginTop: 12 }}>
              {errorMessage(revokeMutation.error, "초대 취소에 실패했습니다.")}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* 초대 토큰/링크 1회 노출 모달 ------------------------------------- */}
      <Modal
        open={created !== null}
        title="초대 생성됨 (링크 1회 표시)"
        onClose={() => setCreated(null)}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            확인
          </Button>
        }
      >
        {created ? (
          <div className="stack">
            <p className="form-error" role="alert" style={{ margin: 0 }}>
              이 링크(토큰)는 지금만 확인할 수 있습니다. 초대할 사람에게 바로
              전달하세요.
            </p>
            <div>
              <span className="field-label">역할</span>
              <p style={{ margin: "4px 0 0" }}>{ROLE_LABEL[created.role]}</p>
            </div>
            <div>
              <span className="field-label">만료</span>
              <p style={{ margin: "4px 0 0" }} className="text-muted">
                {formatDate(created.expiresAt)}
              </p>
            </div>
            <div>
              <span className="field-label">수락 링크</span>
              <p style={{ margin: "4px 0 0", wordBreak: "break-all" }}>
                <code>
                  {typeof window !== "undefined"
                    ? `${window.location.origin}${created.acceptUrlPath}`
                    : created.acceptUrlPath}
                </code>
              </p>
            </div>
            <div>
              <span className="field-label">토큰</span>
              <p style={{ margin: "4px 0 0", wordBreak: "break-all" }}>
                <code>{created.token}</code>
              </p>
            </div>
            <div>
              <Button size="sm" variant="secondary" onClick={copyLink}>
                {copied ? "복사됨" : "수락 링크 복사"}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
