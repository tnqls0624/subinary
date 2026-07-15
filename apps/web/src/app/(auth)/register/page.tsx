"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 회원가입 (Phase 5 §6.1)
 * 이름/이메일/비밀번호 → useAuth().register → 성공 시 /dashboard. 에러 표시.
 * ------------------------------------------------------------------------- */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Button, Field } from "@/components";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

export default function RegisterPage() {
  const router = useRouter();
  const { register, status } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [status, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register({ name, email, password });
      router.replace("/dashboard");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "회원가입에 실패했습니다. 잠시 후 다시 시도해 주세요.";
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <header className="auth-head">
          <h1>회원가입</h1>
          <p>가족 금융을 함께 관리할 계정을 만드세요.</p>
        </header>
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <Field
            label="이름"
            name="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
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
            autoComplete="new-password"
            required
            minLength={8}
            hint="8자 이상"
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
            {submitting ? "가입 중…" : "회원가입"}
          </Button>
        </form>
        <p className="auth-alt">
          이미 계정이 있으신가요? <Link href="/login">로그인</Link>
        </p>
      </div>
    </main>
  );
}
