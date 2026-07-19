"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · AI 도우미 (/ai)
 *
 * 자연어 가계부 질의 전용 대화 화면. 대시보드의 스크롤 피드에서 입력창을 분리해
 * "집중해서 대화하는" 성격에 맞는 전용 surface로 제공한다.
 *  - 빈 상태: 인사 + 추천 질문 칩(탭 → 바로 질문).
 *  - 대화: 질문(오른쪽)·답변(왼쪽) 말풍선 스택, 최신이 아래.
 *  - 입력: 헤더~탭바 사이를 채우는 fixed 패널의 하단(탭바에 밀착).
 *
 * 레이아웃: 문서 흐름(main pt/pb)에 의존하는 높이 calc 대신 fixed 패널로
 * 헤더 아래~탭바 위를 정확히 채운다(globals.css의 --app-header-h/--app-tabbar-h와
 * 단일 출처). 키보드가 열리면 네이티브/Android/Chrome은 뷰포트 자체가 줄고
 * (resize:native / adjustResize / resizes-content) 탭바는 kb-open으로 접혀
 * 입력바가 키보드에 밀착된다. iOS 사파리 웹만 뷰포트가 안 줄므로 --kb-inset
 * 폴백(native.ts)으로 패널 하단을 키보드 위로 끌어올린다.
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

/** 이 거리(px) 이내면 '바닥에 붙어 있음'으로 간주 — 자동 스크롤 유지 판단 기준. */
const NEAR_BOTTOM_PX = 80;

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
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  // 바닥 고정 여부는 DOM이 자라기 *전* 상태로 판단해야 하므로 onScroll로 기록해 둔다.
  // (effect 시점엔 새 말풍선이 이미 붙어 scrollHeight가 커진 뒤라 오판한다.)
  const atBottomRef = useRef(true);
  const prevTurnCount = useRef(0);

  const mutation = useMutation({
    mutationFn: (question: string) =>
      authedFetch((token) =>
        api.ai.financeQuery(token, {
          householdId: householdId as string,
          question,
        }),
      ),
  });

  // 새 질문 추가 → 무조건 바닥으로(사용자 액션). 답변 갱신 → 사용자가 위로
  // 스크롤해 읽는 중이면 강제로 끌어내리지 않고, 바닥 근처였을 때만 따라간다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const added = turns.length > prevTurnCount.current;
    prevTurnCount.current = turns.length;
    if (added || atBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [turns]);

  // 키보드 개폐 등으로 스크롤 영역 높이가 변할 때 바닥에 있었다면 바닥 유지.
  // (네이티브 resize·adjustResize·resizes-content 모두 컨테이너 리사이즈로 관측됨)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTo({ top: el.scrollHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 자동 포커스는 물리 키보드 환경(데스크톱)에서만 — 터치 기기에서 진입 즉시
  // 소프트 키보드가 화면 절반을 덮는 것을 피한다(추천 칩이 첫 행동 동선).
  useEffect(() => {
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      inputRef.current?.focus();
    }
  }, []);

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
    // fixed 패널: 헤더 아래(top)~탭바 위(bottom)를 채운다. 문서 흐름 밖이라
    // main 패딩·보더 1px 오차 등으로 페이지 전체가 스크롤되는 문제가 없다.
    // bottom의 max(): iOS 사파리 웹에서만 --kb-inset(키보드 높이)이 탭바 높이를
    // 이겨 입력바를 키보드 위로 올린다. 그 외 환경에선 --kb-inset=0.
    <div className="bg-background fixed inset-x-0 top-[var(--app-header-h)] bottom-[max(var(--app-tabbar-h),var(--kb-inset))] z-10">
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-4">
        {/* 대화 영역(스크롤) — overscroll-contain: 끝 바운스가 바디로 번지지 않게 */}
        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            atBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
          }}
          className="flex-1 overflow-y-auto overscroll-contain pb-4"
        >
          {empty ? (
            // min-h-full(h-full 아님): 키보드로 뷰포트가 줄어 콘텐츠가 넘치면
            // 래퍼가 자라면서 정상 스크롤 — h-full+center는 상단이 잘려 도달 불가.
            <div className="flex min-h-full flex-col items-center justify-center gap-5 px-2 py-6 text-center">
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
                        <Loader2 className="size-4 animate-spin" /> 살펴보고
                        있어요…
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

        {/* 입력 — 패널 하단(탭바/키보드에 밀착).
            Input은 전송 중에도 disabled하지 않는다: 포커스가 끊기면 모바일
            키보드가 매 질문마다 닫혔다 열린다(중복 전송은 ask()의 isPending
            가드 + submit 버튼 disabled가 막는다). h-11/size-11: 터치 타깃
            44px 통일(기존 40px input vs 36px 버튼 어긋남 해소). 포커스 줌
            방어(16px)는 globals.css의 pointer:coarse 전역 규칙이 담당. */}
        <form
          onSubmit={onSubmit}
          className="bg-background flex items-center gap-2 border-t py-3"
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="궁금한 걸 물어보세요"
            enterKeyHint="send"
            className="h-11"
          />
          <Button
            type="submit"
            size="icon"
            className="size-11"
            disabled={mutation.isPending || input.trim() === ""}
            aria-label="질문 보내기"
            // 버튼 탭이 input의 포커스를 뺏어 키보드가 닫히는 것 방지(Android).
            onPointerDown={(e) => e.preventDefault()}
          >
            {mutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
