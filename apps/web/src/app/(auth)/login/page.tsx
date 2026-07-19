"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 로그인 (오늘의집 톤)
 * loginRequestSchema로 클라 검증 → useAuth().login → /dashboard.
 * 카드 없는 화이트 베이스 센터 컬럼: 브랜드 마크 + 큰 제목 + 필드 + 풀폭 CTA.
 *
 * 네이티브 전용 흐름 2가지(웹에서는 둘 다 비활성):
 *  - 생체인식 재시도: 잠금이 켜진 채 부트스트랩 게이트를 취소/실패해 여기로
 *    왔을 때, 비밀번호 없이 다시 시도하는 보조 버튼.
 *  - 옵트인 제안: 비밀번호 로그인 직후 아직 묻지 않은 기기에서 1회 제안.
 *    다이얼로그가 떠 있는 동안은 대시보드 리다이렉트를 보류한다.
 * ------------------------------------------------------------------------- */
import { zodResolver } from "@hookform/resolvers/zod";
import { CreditCard, Fingerprint, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { loginRequestSchema, type LoginRequest } from "@family/contracts";

import { Button } from "@/components/ui/button";
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
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import {
  authenticateBiometric,
  getBiometricPref,
  isBiometryAvailable,
  setBiometricPref,
} from "@/lib/biometric";
import { getStoredRefreshToken, isNative } from "@/lib/native";

export default function LoginPage() {
  const router = useRouter();
  const { login, status, biometricLogin } = useAuth();

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: "", password: "" },
  });

  // 생체인식 재시도 버튼 노출 여부(네이티브 && 잠금 on && 저장 세션 존재).
  const [bioRetry, setBioRetry] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [optInOpen, setOptInOpen] = useState(false);
  const optInEligible = useRef(false);
  // 옵트인 흐름 동안 status 기반 리다이렉트 보류. login()이 status를 바꾸기
  // 전에 동기적으로 세워야 레이스가 없으므로 state가 아닌 ref를 쓴다.
  const holdRedirect = useRef(false);

  useEffect(() => {
    if (!isNative()) return;
    void (async () => {
      const [pref, available, stored] = await Promise.all([
        getBiometricPref(),
        isBiometryAvailable(),
        getStoredRefreshToken(),
      ]);
      setBioRetry(pref === "on" && available && stored !== null);
      // 아직 묻지 않은 기기 + 생체인식 가능 → 로그인 성공 직후 1회 제안.
      optInEligible.current = pref === null && available;
    })();
  }, []);

  useEffect(() => {
    if (status === "authenticated" && !holdRedirect.current) {
      router.replace("/dashboard");
    }
  }, [status, router]);

  async function onSubmit(values: LoginRequest) {
    // 옵트인 대상이면 login()이 status를 authenticated로 바꾸기 전에 리다이렉트
    // 보류를 동기적으로 세운다. 다이얼로그는 로그인 "성공 후"에만 연다 —
    // 실패/진행 중 노출되면 미인증 상태로 설정이 영구 기록될 수 있다.
    if (optInEligible.current) holdRedirect.current = true;
    try {
      await login(values);
      if (optInEligible.current) {
        setOptInOpen(true);
      } else {
        router.replace("/dashboard");
      }
    } catch (err) {
      holdRedirect.current = false;
      form.setError("password", {
        message:
          err instanceof ApiError
            ? err.message
            : "로그인하지 못했어요. 잠시 후 다시 시도해 주세요.",
      });
    }
  }

  /** 옵트인 응답 처리 — 어느 쪽이든 다이얼로그를 닫고 대시보드로 보낸다. */
  async function answerOptIn(enable: boolean) {
    if (enable) {
      const gate = await authenticateBiometric(
        "생체인식 잠금을 켜려면 본인 확인이 필요해요",
      );
      if (gate === "ok") {
        await setBiometricPref("on");
        toast.success("생체인식 잠금을 켰어요.");
      } else if (gate === "unsupported") {
        toast.error("이 기기에서는 생체인식을 사용할 수 없어요.");
        await setBiometricPref("off");
      } else {
        // 취소/실패 — 설정을 남기지 않아 다음 로그인 때 다시 제안한다.
        toast.error("생체인식을 확인하지 못했어요. 더보기에서 다시 켤 수 있어요.");
      }
    } else {
      await setBiometricPref("off");
    }
    setOptInOpen(false);
    holdRedirect.current = false;
    router.replace("/dashboard");
  }

  async function onBiometricRetry() {
    setBioBusy(true);
    try {
      const result = await biometricLogin();
      if (result === "failed") {
        toast.error("본인 확인에 실패했어요. 비밀번호로 로그인해 주세요.");
      }
      // "ok"는 status 변화로 자동 리다이렉트, "cancelled"는 그대로 머무름.
    } catch {
      // 게이트는 통과했지만 세션이 만료된 경우.
      setBioRetry(false);
      toast.error("세션이 만료됐어요. 비밀번호로 다시 로그인해 주세요.");
    } finally {
      setBioBusy(false);
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

        {bioRetry && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-12 w-full"
            disabled={bioBusy}
            onClick={onBiometricRetry}
          >
            {bioBusy ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 확인하고 있어요…
              </>
            ) : (
              <>
                <Fingerprint className="size-4" /> 생체인식으로 로그인
              </>
            )}
          </Button>
        )}

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

      {/* 로그인 직후 1회 생체인식 옵트인 제안(네이티브 전용). */}
      <Dialog
        open={optInOpen}
        onOpenChange={(open) => {
          // 바깥 탭/ESC로 닫으면 '나중에'와 동일하게 처리하되, 설정을 남기지
          // 않아 다음 로그인 때 다시 제안한다.
          if (!open) {
            setOptInOpen(false);
            holdRedirect.current = false;
            router.replace("/dashboard");
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>생체인식으로 잠금 해제할까요?</DialogTitle>
            <DialogDescription>
              앱을 열 때 Face ID·지문으로 본인을 확인한 뒤 자동으로
              로그인해요. 더보기에서 언제든 바꿀 수 있어요.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2">
            <Button
              type="button"
              size="lg"
              className="h-11 w-full"
              onClick={() => void answerOptIn(true)}
            >
              <Fingerprint className="size-4" /> 생체인식 사용하기
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="h-11 w-full"
              onClick={() => void answerOptIn(false)}
            >
              사용하지 않기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
