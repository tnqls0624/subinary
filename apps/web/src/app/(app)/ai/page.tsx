"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · AI 도우미 (/ai)
 *
 * 두 범위(dual-mode)의 대화 화면이다.
 *  - `금융`: 자연어 가계부 질의(`POST /v1/ai/finance-query`).
 *  - `업무 기억`: 가져온 Slack 기록 기반 질의(`POST /v1/ai/work-query`).
 *    답변에는 **채널·시각·스니펫 출처**가 반드시 따라붙는다. 출처 없는 업무
 *    답변은 내보내지 않는다(서버가 근거 없으면 `refused`를 준다).
 *
 * ## 정직함이 이 화면의 설계 원칙이다
 * 1) **못 하는 걸 할 수 있다고 말하지 않는다.** 예전 빈 상태는 "무엇이든
 *    물어보세요"였는데 실제로는 지출 집계만 답한다. 카피를 실제 능력으로 줄였다.
 * 2) **미지원 질문에 다른 답을 대신 주지 않는다.** 서버가 `refused`를 주면 그대로
 *    "아직 못 답해요 + 이런 건 물어보실 수 있어요"로 보여 준다. 오류 스타일(빨강)로
 *    그리지 않는다 — 거부는 실패가 아니라 정직한 답이다.
 * 3) **없는 데이터를 있는 척하지 않는다.** 업무 기억은 진입 시
 *    `GET /v1/slack/workspaces`를 먼저 조회한다. 0개면 가짜 예시 질문이나 가짜
 *    최근 기록 대신 "가져온 Slack 기록이 없습니다"를 명시한다. 그리고 **그 자리에
 *    업로드를 둔다**(C-6 본체): 서버가 Slack Export ZIP을 직접 받고
 *    (`docs/api/slack.md` §1), `GET /v1/slack/imports/:id`로 진행·실패를 확인할 수
 *    있게 된 뒤에야 연 동선이다. 그 전에는 파일 선택기가 성공할 수 없는 약속이었다.
 * 4) **소유자 경계.** 워크스페이스 목록은 서버가 소유자 본인 것만 준다(PRD §26).
 *    가족 구성원은 이름도 message count도 받지 못하고 빈 배열을 받으므로, 이
 *    화면에서도 자연히 "가져온 기록 없음"으로 보인다.
 *
 * 레이아웃: 문서 흐름(main pt/pb)에 의존하는 높이 calc 대신 fixed 패널로
 * 헤더 아래~탭바 위를 정확히 채운다(globals.css의 --app-header-h/--app-tabbar-h와
 * 단일 출처). 키보드가 열리면 네이티브/Android/Chrome은 뷰포트 자체가 줄고
 * (resize:native / adjustResize / resizes-content) 탭바는 kb-open으로 접혀
 * 입력바가 키보드에 밀착된다. iOS 사파리 웹만 뷰포트가 안 줄므로 --kb-inset
 * 폴백(native.ts)으로 패널 하단을 키보드 위로 끌어올린다.
 * 답변 금액은 서버 SQL 집계 근거이며 LLM이 지어내지 않는다(백엔드 계약).
 * ------------------------------------------------------------------------- */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Send, Sparkles } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { toast } from "sonner";

import type {
  Citation,
  FinanceQueryResponse,
  WorkQueryResponse,
} from "@family/contracts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  aiChatStorageKey,
  loadAiChat,
  saveAiChat,
} from "@/lib/ai-chat-history";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { cn } from "@/lib/utils";

import { SlackImportPanel } from "./import-panel";

/** 대화 범위. 서버 엔드포인트·근거 출처가 완전히 다르다. */
type Scope = "finance" | "work";

/**
 * 금융 추천 질문 — 전부 실제로 답할 수 있는 형태만 둔다.
 * (예전에 있던 "지난달이랑 비교해줘"는 기간 비교 기능이 없어 지금은 거부된다.
 * 답하지 못할 질문을 화면이 권하면 사용자는 두 번 속는다.)
 */
const FINANCE_SUGGESTIONS = [
  "이번 달 총 지출 얼마야?",
  "이번 달 식비 얼마 썼어?",
  "이번 달 어디서 제일 많이 썼어?",
  "지난달 카페 얼마 썼어?",
];

/** 이 거리(px) 이내면 '바닥에 붙어 있음'으로 간주 — 자동 스크롤 유지 판단 기준. */
const NEAR_BOTTOM_PX = 80;

/** 저장 키가 어긋난 순간에 쓰는 고정 빈 배열(매 렌더 새 배열이면 effect가 헛돈다). */
const EMPTY_TURNS: Turn[] = [];

interface Turn {
  id: number;
  /** 저장 시각(ms) — 보존 기간 판정에 쓴다(lib/ai-chat-history.ts). */
  at: number;
  scope: Scope;
  question: string;
  answer?: string;
  /** 서버가 "답할 근거가 없다"고 한 경우(오류 아님). */
  refused?: boolean;
  /** 거부와 함께 제시하는 "대신 이렇게 물어보세요". */
  suggestions?: string[];
  /** 업무 답변의 출처(채널·시각·스니펫). 업무 답변은 항상 하나 이상 있다. */
  citations?: Citation[];
  /** 네트워크/서버 오류 — 이때만 오류 스타일로 그린다. */
  error?: boolean;
}

export default function AiPage() {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const [scope, setScope] = useState<Scope>("finance");
  const [input, setInput] = useState("");

  /* --- 대화 보존 -----------------------------------------------------------
   * 대화는 `(가족, 범위)` 단위로 로컬에 남는다(lib/ai-chat-history.ts). 상태에
   * **어느 키의 대화인지**를 함께 들고 있는 이유: 가족이나 범위가 바뀌면 로드
   * effect가 새 대화를 넣기 전에 저장 effect가 먼저 돌 수 있는데, 그때 이전 범위의
   * 문답을 새 키에 덮어쓰면 금융 답변이 업무 기억 쪽에 섞인다. 키가 어긋나면
   * 저장도 화면 표시도 하지 않는다. */
  const historyKey = householdId ? aiChatStorageKey(householdId, scope) : null;
  const [chat, setChat] = useState<{ key: string | null; turns: Turn[] }>({
    key: null,
    turns: [],
  });
  const turns = useMemo(
    () => (chat.key === historyKey ? chat.turns : EMPTY_TURNS),
    [chat, historyKey],
  );
  const setTurns = useCallback(
    (updater: (prev: Turn[]) => Turn[]) => {
      setChat((prev) => ({
        key: historyKey,
        turns: updater(prev.key === historyKey ? prev.turns : []),
      }));
    },
    [historyKey],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  // 바닥 고정 여부는 DOM이 자라기 *전* 상태로 판단해야 하므로 onScroll로 기록해 둔다.
  // (effect 시점엔 새 말풍선이 이미 붙어 scrollHeight가 커진 뒤라 오판한다.)
  const atBottomRef = useRef(true);
  const prevTurnCount = useRef(0);

  // 업무 기억 범위를 열 때만 조회한다 — 금융만 쓰는 사용자에게 불필요한 요청을
  // 만들지 않는다. 소유자가 아니면 서버가 빈 배열을 준다(PRD §26).
  const workspacesQuery = useQuery({
    queryKey: ["slack", "workspaces"],
    queryFn: () => authedFetch((token) => api.slack.listWorkspaces(token)),
    enabled: scope === "work",
    staleTime: 60_000,
  });
  const workspaces = workspacesQuery.data ?? [];
  const workspace = workspaces[0];

  const financeMutation = useMutation({
    mutationFn: (question: string) =>
      authedFetch((token) =>
        api.ai.financeQuery(token, {
          householdId: householdId as string,
          question,
        }),
      ),
  });

  const workMutation = useMutation({
    mutationFn: (vars: { workspaceId: string; question: string }) =>
      authedFetch((token) => api.ai.workQuery(token, vars)),
  });

  const pending = financeMutation.isPending || workMutation.isPending;

  // 진입/가족·범위 전환 → 저장된 대화 복원. id는 화면 안에서만 쓰는 번호라 복원한
  // 최대값 다음부터 이어 준다(같은 id가 두 번 나오면 말풍선이 잘못 재사용된다).
  //
  // 답이 없는 문답은 버린다: 요청 중에 화면을 떠난 것이라 이어받을 요청이 없고,
  // 복원하면 영원히 '살펴보고 있어요…'로 남는다.
  useEffect(() => {
    if (!historyKey) return;
    const restored = loadAiChat<Turn>(historyKey, Date.now()).filter(
      (t) => t.answer !== undefined,
    );
    nextId.current = restored.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    setChat({ key: historyKey, turns: restored });
  }, [historyKey]);

  // 대화가 바뀔 때마다 저장. 키가 어긋난 커밋(전환 직후 1프레임)은 건너뛴다 —
  // 여기서 쓰면 이전 범위의 답변이 새 범위 키에 들어간다.
  useEffect(() => {
    if (!historyKey || chat.key !== historyKey) return;
    saveAiChat(historyKey, chat.turns, Date.now());
  }, [historyKey, chat]);

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
    if (!q || pending) return;
    if (scope === "finance" && !householdId) return;
    if (scope === "work" && !workspace) return;

    const id = nextId.current++;
    const asked = scope;
    setTurns((prev) => [
      ...prev,
      { id, at: Date.now(), scope: asked, question: q },
    ]);
    setInput("");
    try {
      const patch: Partial<Turn> =
        asked === "finance"
          ? financeTurn(await financeMutation.mutateAsync(q))
          : workTurn(
              await workMutation.mutateAsync({
                workspaceId: workspace!.workspaceId,
                question: q,
              }),
            );
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
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

  /**
   * 범위 전환. 두 범위는 **근거가 다른 답변**이라 한 줄에 섞이면 오해가 되므로
   * 화면을 갈아 끼운다. 다만 지우지는 않는다 — 저장이 `(가족, 범위)`별이라
   * 돌아오면 아까 보던 대화가 그대로 있다(로드 effect가 채운다).
   */
  function switchScope(next: Scope) {
    if (next === scope) return;
    setScope(next);
    setInput("");
  }

  const empty = turns.length === 0;
  const workReady = scope === "work" && workspace !== undefined;
  const workBlocked =
    scope === "work" && !workspacesQuery.isPending && workspace === undefined;

  return (
    // fixed 패널: 헤더 아래(top)~탭바 위(bottom)를 채운다. 문서 흐름 밖이라
    // main 패딩·보더 1px 오차 등으로 페이지 전체가 스크롤되는 문제가 없다.
    // bottom의 max(): iOS 사파리 웹에서만 --kb-inset(키보드 높이)이 탭바 높이를
    // 이겨 입력바를 키보드 위로 올린다. 그 외 환경에선 --kb-inset=0.
    <div
      // 당겨서 새로고침 제외 — 이 패널은 fixed라 조상 transform이 걸리면
      // 기준이 뷰포트에서 그 조상으로 바뀌어 헤더/탭바 정렬이 깨진다.
      data-no-pull-refresh
      className="bg-background fixed inset-x-0 top-[var(--app-header-h)] bottom-[max(var(--app-tabbar-h),var(--kb-inset))] z-10"
    >
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-4">
        {/* 범위 선택 — 어떤 근거로 답하는지가 바뀌므로 항상 보이게 둔다. */}
        <div
          role="tablist"
          aria-label="질문 범위"
          className="bg-muted mt-3 flex shrink-0 gap-1 rounded-xl p-1"
        >
          {(
            [
              { key: "finance", label: "금융" },
              { key: "work", label: "업무 기억" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={scope === tab.key}
              onClick={() => switchScope(tab.key)}
              className={cn(
                "h-9 flex-1 rounded-lg text-sm font-medium transition-colors",
                scope === tab.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

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

              {scope === "finance" ? (
                <>
                  <div className="flex flex-col gap-1">
                    {/* 카피는 실제 능력까지만 — "무엇이든"은 지키지 못하는 약속이었다. */}
                    <h1 className="text-xl font-bold tracking-tight">
                      가계부에 대해 물어보세요
                    </h1>
                    <p className="text-muted-foreground text-sm">
                      기간·카테고리·가맹점 기준의 지출 집계를 알려드려요. 그 밖의
                      질문은 아직 답하기 어려워요.
                    </p>
                  </div>
                  <div className="flex w-full max-w-sm flex-col gap-2">
                    {FINANCE_SUGGESTIONS.map((s) => (
                      <SuggestionButton key={s} text={s} onPick={ask} />
                    ))}
                  </div>
                </>
              ) : workspacesQuery.isPending ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" /> 가져온 기록을
                  확인하고 있어요…
                </p>
              ) : workspace ? (
                <>
                  <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-bold tracking-tight">
                      업무 기록에 대해 물어보세요
                    </h1>
                    <p className="text-muted-foreground text-sm">
                      가져온 Slack 기록에서 근거를 찾아 답하고, 채널·시각·원문
                      스니펫을 함께 보여드려요.
                    </p>
                  </div>
                  {/* 검색 가능한 범위를 숫자로 밝힌다 — 무엇을 물어봐도 되는지의 근거. */}
                  <dl className="border-border w-full max-w-sm rounded-xl border px-4 py-3 text-left text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">워크스페이스</dt>
                      <dd className="truncate font-medium">{workspace.name}</dd>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">검색 가능한 메시지</dt>
                      <dd className="font-medium">
                        {workspace.messageCount.toLocaleString("ko-KR")}건
                      </dd>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">마지막 가져오기</dt>
                      <dd className="font-medium">
                        {formatSeoul(workspace.lastImportedAt)}
                      </dd>
                    </div>
                  </dl>
                  {/* 이미 기록이 있어도 새 Export를 이어 올릴 수 있어야 한다 —
                      Slack 기록은 계속 쌓이고, 재업로드는 멱등이다(ADR-0011 §3). */}
                  <SlackImportPanel />
                </>
              ) : (
                // 빈 화면 대신 왜 비었는지를 말하고, **다음 행동을 바로 준다**.
                // 예전에는 "개발자용 JSON 업로드로만 가능해요"로 끝나 막다른 길이었다
                // (서버가 ZIP을 못 받았기 때문이다 — C-6 본체가 그 조건을 없앴다).
                <div className="flex w-full max-w-sm flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    <h1 className="text-xl font-bold tracking-tight">
                      가져온 Slack 기록이 없습니다
                    </h1>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      업무 기억은 가져온 Slack 기록에서만 답을 찾아요. 아직 가져온
                      기록이 없어서 지금은 물어볼 수 있는 게 없어요.
                    </p>
                  </div>
                  <SlackImportPanel />
                </div>
              )}
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
                      // 거부(refused)는 오류가 아니다 — 빨간 스타일을 쓰지 않는다.
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

                  {/* 거부 시 "대신 이런 건 물어보실 수 있어요" */}
                  {t.refused && t.suggestions && t.suggestions.length > 0 ? (
                    <div className="flex flex-wrap gap-2 pl-1">
                      {t.suggestions.map((s) => (
                        <SuggestionChip key={s} text={s} onPick={ask} />
                      ))}
                    </div>
                  ) : null}

                  {/* 업무 답변 출처 — 채널·시각·스니펫. 없으면 답변도 없다. */}
                  {t.citations && t.citations.length > 0 ? (
                    <ul className="flex flex-col gap-1.5 pl-1">
                      {t.citations.map((c) => (
                        <li
                          key={c.chunkId}
                          className="border-border text-muted-foreground rounded-lg border px-3 py-2 text-xs leading-relaxed"
                        >
                          <span className="text-foreground font-medium">
                            {c.channelName ? `#${c.channelName}` : "채널 미상"}
                          </span>
                          <span className="mx-1.5">·</span>
                          <span>{formatSeoul(c.occurredAt)}</span>
                          <p className="mt-1 line-clamp-3 whitespace-pre-wrap">
                            {c.snippet}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 입력 — 패널 하단(탭바/키보드에 밀착).
            Input은 전송 중에도 disabled하지 않는다: 포커스가 끊기면 모바일
            키보드가 매 질문마다 닫혔다 열린다(중복 전송은 ask()의 pending
            가드 + submit 버튼 disabled가 막는다). h-11/size-11: 터치 타깃
            44px 통일. 포커스 줌 방어(16px)는 globals.css의 pointer:coarse
            전역 규칙이 담당.
            업무 기억에 가져온 기록이 없으면 입력 자체를 막는다 — 물어봐도
            전부 "근거 없음"이라 시도하게 두는 게 더 불친절하다. */}
        <form
          onSubmit={onSubmit}
          className="bg-background flex items-center gap-2 border-t py-3"
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              workBlocked
                ? "가져온 Slack 기록이 없어요"
                : scope === "work"
                  ? "업무 기록에서 찾을 내용을 물어보세요"
                  : "지출에 대해 물어보세요"
            }
            enterKeyHint="send"
            disabled={workBlocked}
            className="h-11"
          />
          <Button
            type="submit"
            size="icon"
            className="size-11"
            disabled={
              pending ||
              input.trim() === "" ||
              workBlocked ||
              (scope === "work" && !workReady)
            }
            aria-label="질문 보내기"
            // 버튼 탭이 input의 포커스를 뺏어 키보드가 닫히는 것 방지(Android).
            onPointerDown={(e) => e.preventDefault()}
          >
            {pending ? (
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

/* -------------------------------------------------------------------------- */
/* 응답 → 말풍선 매핑                                                          */
/* -------------------------------------------------------------------------- */

/** 가계부 응답. `refused`면 답 대신 안내 + 예시 질문을 싣는다(오류 아님). */
function financeTurn(res: FinanceQueryResponse): Partial<Turn> {
  return {
    answer: res.answer,
    refused: res.refused,
    suggestions: res.refused ? res.suggestions : undefined,
  };
}

/**
 * 업무 응답. 근거가 없으면 서버가 `refused: true` + `answer: null`을 준다 —
 * 이때 **가계부 총액 같은 다른 답으로 갈아타지 않는다**(B8과 같은 원칙).
 */
function workTurn(res: WorkQueryResponse): Partial<Turn> {
  if (res.refused || res.answer === null) {
    return {
      answer:
        "가져온 기록에서 근거를 찾지 못했어요. 다른 낱말로 다시 물어보시겠어요?",
      refused: true,
    };
  }
  return { answer: res.answer, refused: false, citations: res.citations };
}

/* -------------------------------------------------------------------------- */
/* 작은 조각                                                                    */
/* -------------------------------------------------------------------------- */

function SuggestionButton({
  text,
  onPick,
}: {
  text: string;
  onPick: (q: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(text)}
      className="border-border hover:bg-muted rounded-xl border px-4 py-3 text-left text-sm transition-colors active:scale-[0.99]"
    >
      {text}
    </button>
  );
}

function SuggestionChip({
  text,
  onPick,
}: {
  text: string;
  onPick: (q: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(text)}
      className="border-border hover:bg-muted rounded-full border px-3 py-1.5 text-xs transition-colors active:scale-[0.99]"
    >
      {text}
    </button>
  );
}

/** ISO → 'YYYY. M. D. HH:mm' (Asia/Seoul). null은 '아직 없음'. */
function formatSeoul(iso: string | null): string {
  if (!iso) return "아직 없음";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "아직 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
