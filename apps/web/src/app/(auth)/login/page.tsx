"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 로그인 (오늘의집 톤)
 * loginRequestSchema로 클라 검증 → useAuth().login → /dashboard.
 * 카드 없는 화이트 베이스 센터 컬럼: 브랜드 마크 + 큰 제목 + 필드 + 풀폭 CTA.
 * ------------------------------------------------------------------------- */
import { zodResolver } from "@hookform/resolvers/zod";
import { CreditCard, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";

import { loginRequestSchema, type LoginRequest } from "@family/contracts";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { login, status } = useAuth();

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: "", password: "" },
  });

  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [status, router]);

  async function onSubmit(values: LoginRequest) {
    try {
      await login(values);
      router.replace("/dashboard");
    } catch (err) {
      form.setError("password", {
        message:
          err instanceof ApiError
            ? err.message
            : "로그인하지 못했어요. 잠시 후 다시 시도해 주세요.",
      });
    }
  }

  return (
    <main className="bg-background flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-8">
        {/* 브랜드 마크 + 큰 제목 */}
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-xl">
            <CreditCard className="size-6" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">
            다시 만나서 반가워요
          </h1>
          <p className="text-muted-foreground text-sm">
            가족의 소비와 예산, 이어서 함께 관리해요.
          </p>
        </div>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>이메일</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>비밀번호</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      placeholder="비밀번호를 입력해 주세요"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              size="lg"
              className="mt-2 h-12 w-full"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> 로그인하고 있어요…
                </>
              ) : (
                "로그인하기"
              )}
            </Button>
          </form>
        </Form>

        <p className="text-muted-foreground text-center text-sm">
          아직 계정이 없나요?{" "}
          <Link
            href="/register"
            className="text-accent-foreground font-medium hover:underline"
          >
            회원가입하기
          </Link>
        </p>
      </div>
    </main>
  );
}
