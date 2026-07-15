"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 로그인 (Phase 5 §6.1)
 * 이메일/비밀번호 → useAuth().login → 성공 시 /dashboard. 에러 표시.
 * ------------------------------------------------------------------------- */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Button, Field } from "@/components";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { login, status } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 이미 로그인된 상태면 대시보드로.
  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [status, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email, password });
      router.replace("/dashboard");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.";
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <header className="auth-head">
          <h1>Family Memory AI</h1>
          <p>가족 금융 대시보드에 로그인하세요.</p>
        </header>
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <Field
            label="이메일"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            label="비밀번호"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            disabled={submitting}
            className="auth-submit"
          >
            {submitting ? "로그인 중…" : "로그인"}
          </Button>
        </form>
        <p className="auth-alt">
          계정이 없으신가요? <Link href="/register">회원가입</Link>
        </p>
      </div>
    </main>
  );
}
