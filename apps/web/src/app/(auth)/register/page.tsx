"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 회원가입 (오늘의집 톤)
 * registerRequestSchema로 클라 검증 → useAuth().register → /dashboard(→ 온보딩).
 * 카드 없는 화이트 베이스 센터 컬럼: 브랜드 마크 + 큰 제목 + 필드 + 풀폭 CTA.
 * ------------------------------------------------------------------------- */
import { zodResolver } from "@hookform/resolvers/zod";
import { CreditCard, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";

import { registerRequestSchema, type RegisterRequest } from "@family/contracts";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

export default function RegisterPage() {
  const router = useRouter();
  const { register, status } = useAuth();

  const form = useForm<RegisterRequest>({
    resolver: zodResolver(registerRequestSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [status, router]);

  async function onSubmit(values: RegisterRequest) {
    try {
      await register(values);
      router.replace("/dashboard");
    } catch (err) {
      form.setError("email", {
        message:
          err instanceof ApiError
            ? err.message
            : "가입하지 못했어요. 잠시 후 다시 시도해 주세요.",
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
            가족 소비 관리,
            <br />
            오늘부터 시작해요
          </h1>
          <p className="text-muted-foreground text-sm">
            계정 하나로 가족 모두의 지출을 한곳에 모아요.
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
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>이름</FormLabel>
                  <FormControl>
                    <Input autoComplete="name" placeholder="홍길동" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
                      autoComplete="new-password"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>8자 이상 입력해 주세요</FormDescription>
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
                  <Loader2 className="size-4 animate-spin" /> 가입하고 있어요…
                </>
              ) : (
                "가입하고 시작하기"
              )}
            </Button>
          </form>
        </Form>

        <p className="text-muted-foreground text-center text-sm">
          이미 계정이 있나요?{" "}
          <Link
            href="/login"
            className="text-accent-foreground font-medium hover:underline"
          >
            로그인하기
          </Link>
        </p>
      </div>
    </main>
  );
}
