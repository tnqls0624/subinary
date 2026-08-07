"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 비밀번호 변경 (/more/password)
 *
 * `POST /v1/auth/change-password`는 Phase 1부터 있었지만 화면이 없었다 —
 * `api-client`에 함수조차 없어서, 비밀번호를 잊거나 바꾸고 싶으면 DB를 직접 손대는
 * 수밖에 없었다(2인 사용에서 1명이 막히면 곧바로 장애다).
 *
 * 서버가 변경과 함께 **모든 세션을 폐기**하고 refresh 쿠키를 지운다. 그래서 성공 후엔
 * 로그아웃 상태로 만들고 로그인 화면으로 보낸다 — 그러지 않으면 다음 요청이 401로
 * 떨어져 사용자가 "바꿨는데 왜 튕기지"를 겪는다. 다른 기기도 함께 로그아웃된다는 것을
 * 미리 알린다.
 * ------------------------------------------------------------------------- */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageBackHeader } from "@/components/widgets";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

/** 계약(newPasswordSchema)과 같은 하한. 서버가 최종 판정하지만 미리 막아준다. */
const MIN_LENGTH = 8;

export default function ChangePasswordPage() {
  const router = useRouter();
  const { authedFetch, logout } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (newPassword.length < MIN_LENGTH) {
      setError(`새 비밀번호는 ${MIN_LENGTH}자 이상 입력해 주세요.`);
      return;
    }
    // 확인란은 서버가 모르는 클라이언트 전용 검사다(오타로 잠기는 것을 막는 유일한 방어).
    if (newPassword !== confirm) {
      setError("새 비밀번호가 서로 달라요. 다시 확인해 주세요.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("지금 쓰는 비밀번호와 다른 것으로 바꿔주세요.");
      return;
    }

    setBusy(true);
    try {
      await authedFetch((token) =>
        api.auth.changePassword(token, { currentPassword, newPassword }),
      );
      toast.success("비밀번호를 바꿨어요. 다시 로그인해 주세요");
      // 서버가 이미 세션을 폐기했다. 클라이언트 상태도 비워야 401 루프가 안 생긴다.
      await logout();
      router.replace("/login");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "비밀번호를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageBackHeader
        title="비밀번호 변경"
        subtitle="바꾸면 이 기기를 포함한 모든 기기에서 로그아웃돼요"
      />

      <Card>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="current-password">지금 비밀번호</Label>
              <Input
                id="current-password"
                name="current-password"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="new-password">새 비밀번호</Label>
              <Input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_LENGTH}
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <p className="text-muted-foreground text-[13px]">
                {MIN_LENGTH}자 이상으로 정해주세요
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password">새 비밀번호 확인</Label>
              <Input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}

            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? "바꾸는 중…" : "비밀번호 바꾸기"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
