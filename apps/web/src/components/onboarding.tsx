"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 온보딩 (신규 사용자 · 멤버십 0개, 오늘의집 톤)
 *
 * 히어로 + 선택 카드 2개(전체 클릭영역) → 선택한 방법의 폼만 점진 공개.
 * - 가족 만들기: RHF + zodResolver(householdCreateRequestSchema) → POST /households
 *   → refreshMemberships() → 대시보드. (성공 시 레이아웃이 앱 셸로 전환)
 * - 초대 받기: 붙여넣은 링크/토큰에서 토큰을 추출해 /join/<token> 수락 화면으로.
 * ------------------------------------------------------------------------- */
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowLeft,
  ChevronRight,
  HousePlus,
  Mail,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import {
  householdCreateRequestSchema,
  type HouseholdCreateRequest,
} from "@family/contracts";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

/** 링크/전체 URL/원문 토큰 어디서든 초대 토큰만 뽑아낸다. */
function extractToken(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  // /join/<token>
  const join = input.match(/\/join\/([^/?#\s]+)/);
  if (join) return decodeURIComponent(join[1]);
  // API 경로: /v1/household-invitations/<token>/accept
  const api = input.match(/household-invitations\/([^/?#\s]+)/);
  if (api) return decodeURIComponent(api[1]);
  // URL이면 마지막 경로 세그먼트, 아니면 원문 그대로 토큰으로 간주.
  if (/^https?:\/\//i.test(input)) {
    try {
      const segs = new URL(input).pathname.split("/").filter(Boolean);
      return segs.length ? decodeURIComponent(segs[segs.length - 1]) : null;
    } catch {
      return null;
    }
  }
  return input;
}

type OnboardingMode = "create" | "join";

/** 전체 클릭영역 선택 카드(오늘의집 톤 — 연보더 + hover 시 진한 보더). */
function ChoiceCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-card hover:border-foreground/20 flex w-full items-center gap-4 rounded-xl border p-5 text-left transition-colors active:scale-[0.99]"
    >
      <span className="bg-accent text-accent-foreground flex size-12 shrink-0 items-center justify-center rounded-full [&_svg]:size-5">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold">{title}</span>
        <span className="text-muted-foreground text-[13px]">{description}</span>
      </span>
      <ChevronRight className="text-muted-foreground/50 size-4 shrink-0" />
    </button>
  );
}

export function Onboarding() {
  const router = useRouter();
  const { authedFetch, refreshMemberships, user } = useAuth();

  // 점진 공개: 선택 카드 → 선택한 방법의 폼.
  const [mode, setMode] = useState<OnboardingMode | null>(null);

  const form = useForm<HouseholdCreateRequest>({
    resolver: zodResolver(householdCreateRequestSchema),
    defaultValues: { name: "" },
  });

  async function onCreate(values: HouseholdCreateRequest) {
    try {
      const created = await authedFetch((token) =>
        api.households.create(token, values),
      );
      await refreshMemberships();
      toast.success(`'${created.name}' 가족을 만들었어요.`);
      router.push("/dashboard");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "가족을 만들지 못했어요. 잠시 후 다시 시도해 주세요.";
      form.setError("name", { message });
      toast.error(message);
    }
  }

  // 초대 수락 진입
  const [inviteInput, setInviteInput] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);

  function onJoin() {
    const token = extractToken(inviteInput);
    if (!token) {
      setInviteError("초대 링크 또는 토큰을 입력해 주세요.");
      return;
    }
    router.push(`/join/${encodeURIComponent(token)}`);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8 py-12">
      {/* 히어로 */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="bg-accent text-accent-foreground flex size-14 items-center justify-center rounded-full">
          <Sparkles className="size-6" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          가장 먼저,
          <br />
          가족을 만들어 주세요
        </h1>
        <p className="text-muted-foreground max-w-sm text-sm">
          {user?.name ? `${user.name}님, 반가워요. ` : ""}
          가족 단위로 카드 지출과 예산을 함께 살펴볼 수 있어요.
        </p>
      </div>

      {mode === null ? (
        /* 선택 카드 2개 — 전체 클릭영역 */
        <div className="flex flex-col gap-3">
          <ChoiceCard
            icon={<HousePlus />}
            title="새 가족 만들기"
            description="우리 가족의 소비 기록을 새로 시작해요"
            onClick={() => setMode("create")}
          />
          <ChoiceCard
            icon={<Mail />}
            title="초대로 참여하기"
            description="가족에게 받은 초대 링크가 있어요"
            onClick={() => setMode("join")}
          />
        </div>
      ) : mode === "create" ? (
        /* 가족 만들기 폼 */
        <Card>
          <CardHeader>
            <CardTitle>새 가족 만들기</CardTitle>
            <CardDescription>
              가족 이름은 나중에 언제든 바꿀 수 있어요.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onCreate)}
                className="flex flex-col gap-4"
                noValidate
              >
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>가족 이름</FormLabel>
                      <FormControl>
                        <Input placeholder="예: 우리집" autoFocus {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={form.formState.isSubmitting}
                >
                  {form.formState.isSubmitting
                    ? "만들고 있어요…"
                    : "가족 만들기"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => setMode(null)}
                >
                  <ArrowLeft className="size-4" /> 다른 방법으로 시작할래요
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      ) : (
        /* 초대 수락 진입 */
        <Card>
          <CardHeader>
            <CardTitle>초대로 참여하기</CardTitle>
            <CardDescription>
              받은 초대 링크나 토큰을 붙여넣어 주세요.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Input
                  placeholder="초대 링크 또는 토큰"
                  value={inviteInput}
                  onChange={(e) => {
                    setInviteInput(e.target.value);
                    if (inviteError) setInviteError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onJoin();
                  }}
                  aria-invalid={inviteError != null}
                />
                {inviteError ? (
                  <p className="text-destructive text-sm">{inviteError}</p>
                ) : null}
              </div>
              <Button
                size="lg"
                className="w-full"
                onClick={onJoin}
                disabled={inviteInput.trim() === ""}
              >
                초대 수락하러 가기
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setMode(null)}
              >
                <ArrowLeft className="size-4" /> 다른 방법으로 시작할래요
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
