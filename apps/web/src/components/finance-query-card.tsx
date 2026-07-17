"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 자연어 가계부 질의 카드 (AI)
 *
 * "이번 달 카페에 얼마 썼어?" 같은 질문 → POST /v1/ai/finance-query. 답변은 전부
 * 서버 SQL 집계에 근거하며(LLM이 금액을 지어내지 않음), 답변 말풍선으로 표시한다.
 * ------------------------------------------------------------------------- */
import { useMutation } from "@tanstack/react-query";
import { Loader2, Send, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import type { FinanceQueryResponse } from "@family/contracts";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";

const EXAMPLES = [
  "이번 달 총 지출 얼마야?",
  "카페에 얼마 썼어?",
  "지난달이랑 비교해줘",
];

export function FinanceQueryCard() {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<FinanceQueryResponse | null>(null);

  const mutation = useMutation({
    mutationFn: (q: string) =>
      authedFetch((token) =>
        api.ai.financeQuery(token, {
          householdId: householdId as string,
          question: q,
        }),
      ),
    onSuccess: (result) => setAnswer(result),
    onError: (error) =>
      toast.error(
        error instanceof ApiError ? error.message : "답변을 가져오지 못했어요.",
      ),
  });

  function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || !householdId || mutation.isPending) return;
    setQuestion(trimmed);
    mutation.mutate(trimmed);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    ask(question);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Sparkles className="text-accent-foreground size-4" /> AI에게 물어보기
        </CardTitle>
        <CardDescription>
          지출에 대해 편하게 물어보세요. 예: 이번 달 카페에 얼마 썼어?
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={onSubmit} className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="궁금한 걸 물어보세요"
            disabled={mutation.isPending}
          />
          <Button
            type="submit"
            size="icon"
            disabled={mutation.isPending || question.trim() === ""}
            aria-label="질문 보내기"
          >
            {mutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </form>

        {/* 예시 칩 */}
        {!answer && !mutation.isPending ? (
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => ask(ex)}
                className="border-border text-muted-foreground hover:bg-muted rounded-full border px-3 py-1 text-[13px] transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        ) : null}

        {/* 답변 말풍선 */}
        {mutation.isPending ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> 살펴보고 있어요…
          </div>
        ) : answer ? (
          <div className="bg-muted rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
            {answer.answer}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
