"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · AI 도우미 (/ai)
 *
 * 자연어 가계부 질의 전용 대화 화면. 대시보드의 스크롤 피드에서 입력창을 분리해
 * "집중해서 대화하는" 성격에 맞는 전용 surface로 제공한다.
 *  - 빈 상태: 인사 + 추천 질문 칩(탭 → 바로 질문).
 *  - 대화: 질문(오른쪽)·답변(왼쪽) 말풍선 스택, 최신이 아래.
 *  - 입력: 화면 하단 고정(하단 탭바 위), Enter 전송.
 * 답변 금액은 서버 SQL 집계 근거이며 LLM이 지어내지 않는다(백엔드 계약).
 * ------------------------------------------------------------------------- */
import { useMutation } from "@tanstack/react-query";
import { Loader2, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import type { FinanceQueryResponse } from "@family/contracts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "이번 달 총 지출 얼마야?",
  "카페에 얼마 썼어?",
  "지난달이랑 비교해줘",
  "이번 달 식비 얼마야?",
];

interface Turn {
  id: number;
  question: string;
  answer?: string;
  error?: boolean;
}

export default function AiPage() {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  const mutation = useMutation({
    mutationFn: (question: string) =>
      authedFetch((token) =>
        api.ai.financeQuery(token, {
          householdId: householdId as string,
          question,
        }),
      ),
  });

  // 새 턴이 추가되면 맨 아래로 스크롤.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || !householdId || mutation.isPending) return;
    const id = nextId.current++;
    setTurns((prev) => [...prev, { id, question: q }]);
    setInput("");
    try {
      const res: FinanceQueryResponse = await mutation.mutateAsync(q);
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, answer: res.answer } : t)),
      );
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "답변을 가져오지 못했어요.";
      toast.error(msg);
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, answer: msg, error: true } : t)),
      );
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    ask(input);
  }

  const empty = turns.length === 0;

  return (
    // 가용 높이 = 100dvh − header(3.5rem) − main.pt-6(1.5rem) − main.pb-28(7rem).
    // main 패딩을 그대로 상속하므로 자체 dvh 계산에서 중복 차감해야 스크롤이 안 생긴다.
    <div className="mx-auto flex h-[calc(100dvh-12rem)] w-full max-w-2xl flex-col">
      {/* 대화 영역(스크롤) */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto pb-4">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 px-2 text-center">
            <div className="bg-accent text-accent-foreground flex size-14 items-center justify-center rounded-2xl">
              <Sparkles className="size-7" />
            </div>
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-bold tracking-tight">
                무엇이든 물어보세요
              </h1>
              <p className="text-muted-foreground text-sm">
                지출·예산에 대해 편하게 질문하면 바로 알려드려요.
              </p>
            </div>
            <div className="flex w-full max-w-sm flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="border-border hover:bg-muted rounded-xl border px-4 py-3 text-left text-sm transition-colors active:scale-[0.99]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-4">
            {turns.map((t) => (
              <div key={t.id} className="flex flex-col gap-2">
                {/* 질문 — 오른쪽 */}
                <div className="flex justify-end">
                  <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm">
                    {t.question}
                  </div>
                </div>
                {/* 답변 — 왼쪽 */}
                <div className="flex justify-start">
                  {t.answer === undefined ? (
                    <div className="bg-muted text-muted-foreground flex items-center gap-2 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm">
                      <Loader2 className="size-4 animate-spin" /> 살펴보고 있어요…
                    </div>
                  ) : (
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                        t.error
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted",
                      )}
                    >
                      {t.answer}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 입력 — 하단 고정 */}
      <form
        onSubmit={onSubmit}
        className="bg-background flex gap-2 border-t py-3"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="궁금한 걸 물어보세요"
          disabled={mutation.isPending}
          autoFocus
        />
        <Button
          type="submit"
          size="icon"
          disabled={mutation.isPending || input.trim() === ""}
          aria-label="질문 보내기"
        >
          {mutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </form>
    </div>
  );
}
