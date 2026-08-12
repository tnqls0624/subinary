"use client";
/* ---------------------------------------------------------------------------
 * 업무 기억 · Slack Export 가져오기 패널 (C-6 본체)
 *
 * PO 판정 Q3은 "업로드를 열지 않는다"였고, 그 조건이 5가지였다(ZIP 파서 · 압축폭탄
 * 방어 · 메모리 예산 · importId 상태 API · 복구 가능한 폴링 계약). 이 화면은 그 5가지가
 * 갖춰진 뒤에 열리는 표면이다.
 *
 * ## 이 화면이 지키는 것
 *
 * 1. **`.zip`을 허용한다.** 사용자가 Slack에서 받은 파일을 그대로 올린다 — 직접 풀어
 *    하나의 JSON으로 합치라는 요구는 일반 사용자가 할 수 있는 일이 아니었다.
 *    (기존 단일 JSON 경로도 그대로 받는다. 스크립트가 쓰고 있을 수 있다.)
 * 2. **성공을 지어내지 않는다.** 업로드 응답은 `queued`뿐이라 그것만으로는 아무것도
 *    끝나지 않았다. 상태를 폴링해 완료/실패를 실제로 확인하고 나서 말한다.
 * 3. **실패하면 무엇이 잘못됐는지 말한다.** 서버가 주는 안전한 코드를 행동 가능한
 *    문구로 바꾼다(`slack-import.ts`).
 * 4. **화면을 벗어나도 결과를 잃지 않는다.** `importId`를 로컬에 적어 두고 돌아오면
 *    폴링을 이어 간다. 업로드 자체(전송 중)는 이어받지 못하므로 그 사실을 문구로
 *    알린다 — 조용히 실패하게 두지 않는다.
 * ------------------------------------------------------------------------- */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { API_BASE_URL, ApiError, type AccessToken } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

import {
  clearPendingImport,
  isTerminalImportStatus,
  pendingImportKey,
  readPendingImport,
  shouldKeepPolling,
  slackImportErrorMessage,
  slackImportPollInterval,
  writePendingImport,
  type SlackImportStatusValue,
} from "./slack-import";

/** 업로드 파일 크기 상한(bytes) — 서버 multipart 상한(`main.ts`)과 같은 값이다. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** `POST /v1/slack/import` 응답 중 이 화면이 쓰는 부분. */
interface ImportAccepted {
  importId: string;
  slackWorkspaceId: string;
  format: "json" | "zip";
}

/** `GET /v1/slack/imports/:id` 응답 중 이 화면이 쓰는 부분. */
interface ImportStatus {
  importId: string;
  status: SlackImportStatusValue;
  errorCode: string | null;
  channelCount: number | null;
  messageCount: number | null;
  createdMessageCount: number | null;
  skippedMessageCount: number | null;
}

/**
 * multipart 업로드. `apiFetch`는 JSON 전용이라 여기서 직접 만든다(라이브러리 계층을
 * 건드리지 않기 위해 이 화면 안에 둔다).
 */
async function postImport(
  token: AccessToken,
  file: File,
  workspaceName: string,
): Promise<ImportAccepted> {
  const form = new FormData();
  form.append("file", file, file.name);
  if (workspaceName.trim() !== "") {
    form.append("workspaceName", workspaceName.trim());
  }
  const res = await fetch(`${API_BASE_URL}/v1/slack/import`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    credentials: "include",
    body: form,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // 서버가 준 안전한 코드가 있으면 그대로 살려 문구 매핑에 쓴다.
    const code =
      body && typeof body === "object"
        ? (body as { errorCode?: unknown }).errorCode
        : undefined;
    throw new ApiError(
      res.status,
      typeof code === "string"
        ? slackImportErrorMessage(code)
        : res.status === 503
          ? "지금은 업로드가 몰려 있어요. 잠시 후 다시 시도해 주세요."
          : res.status === 413
            ? "파일이 너무 커요(최대 50MB)."
            : "업로드하지 못했어요. 잠시 후 다시 시도해 주세요.",
      body,
    );
  }
  return body as ImportAccepted;
}

async function getImportStatus(
  token: AccessToken,
  importId: string,
): Promise<ImportStatus> {
  const res = await fetch(`${API_BASE_URL}/v1/slack/imports/${importId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new ApiError(res.status, "상태를 확인하지 못했어요");
  }
  return (await res.json()) as ImportStatus;
}

/** 파일 이름에서 워크스페이스 이름 후보를 만든다(서버 폴백과 같은 규칙). */
function guessWorkspaceName(fileName: string): string {
  return fileName
    .replace(/\.(zip|json)$/i, "")
    .replace(/\s*Slack export.*$/i, "")
    .replace(/^[\s_-]+|[\s_-]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

export function SlackImportPanel() {
  const { authedFetch, user } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const storageKey = user ? pendingImportKey(user.id) : null;
  const [file, setFile] = useState<File | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  /** 진행 중 import(업로드 수락 이후). `startedAt`으로 경과·TTL을 잰다. */
  const [pending, setPending] = useState<{
    importId: string;
    startedAt: number;
  } | null>(null);
  /** 자동 폴링을 포기한 뒤에도 사용자가 직접 확인할 수 있게 하는 플래그. */
  const [gaveUp, setGaveUp] = useState(false);

  // 화면에 들어올 때 이전에 적어 둔 import를 이어받는다 — 앱을 내렸다 올려도
  // "그래서 어떻게 됐지?"에 답할 수 있어야 한다.
  useEffect(() => {
    if (!storageKey) return;
    const saved = readPendingImport(storageKey, Date.now());
    if (saved) {
      setPending({ importId: saved.importId, startedAt: saved.startedAt });
      setGaveUp(false);
    }
  }, [storageKey]);

  const statusQuery = useQuery({
    queryKey: ["slack", "import", pending?.importId],
    enabled: pending !== null,
    // 폴링 주기는 경과에 따라 조밀 → 느슨. 종료 상태이거나 포기 시점을 넘으면 멈춘다.
    refetchInterval: (query) => {
      if (!pending || gaveUp) return false;
      const elapsed = Date.now() - pending.startedAt;
      const status = (query.state.data as ImportStatus | undefined)?.status;
      if (status && !shouldKeepPolling(status, elapsed)) return false;
      if (elapsed >= 0 && !shouldKeepPolling("processing", elapsed)) return false;
      return slackImportPollInterval(elapsed);
    },
    retry: false,
    queryFn: () =>
      authedFetch((token) =>
        getImportStatus(token, pending?.importId as string),
      ),
  });

  const status = statusQuery.data ?? null;

  // 자동 폴링을 멈춰야 하는 시점을 기록한다(실패로 단정하지 않고 "다시 확인"만 남긴다).
  useEffect(() => {
    if (!pending || gaveUp) return;
    const elapsed = Date.now() - pending.startedAt;
    if (!shouldKeepPolling(status?.status ?? "processing", elapsed)) {
      if (!status || !isTerminalImportStatus(status.status)) setGaveUp(true);
    }
  }, [pending, gaveUp, status]);

  // 완료되면 워크스페이스 요약(메시지 수·마지막 가져오기)을 다시 읽어 화면을 맞춘다.
  const completedAt = status?.status === "completed" ? status.importId : null;
  useEffect(() => {
    if (!completedAt) return;
    void queryClient.invalidateQueries({ queryKey: ["slack", "workspaces"] });
  }, [completedAt, queryClient]);

  // 조회가 403/404를 주면 이 기기에 남은 기록이 내 것이 아니다(계정이 바뀌었거나
  // 삭제됨). 유령 카드를 남기지 않고 그 자리에서 지운다.
  useEffect(() => {
    const error = statusQuery.error;
    if (!(error instanceof ApiError)) return;
    if (error.status === 403 || error.status === 404) {
      if (storageKey) clearPendingImport(storageKey);
      setPending(null);
    }
  }, [statusQuery.error, storageKey]);

  const uploadMutation = useMutation({
    mutationFn: (input: { file: File; workspaceName: string }) =>
      authedFetch((token) =>
        postImport(token, input.file, input.workspaceName),
      ),
    onSuccess: (accepted) => {
      const startedAt = Date.now();
      if (storageKey) {
        writePendingImport(storageKey, {
          importId: accepted.importId,
          slackWorkspaceId: accepted.slackWorkspaceId,
          startedAt,
        });
      }
      setPending({ importId: accepted.importId, startedAt });
      setGaveUp(false);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof ApiError ? error.message : "업로드하지 못했어요",
      );
    },
  });

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    if (!picked) {
      setFile(null);
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      // 서버까지 보내고 413을 받느니 여기서 막는다 — 50MB를 헛되이 올리지 않는다.
      toast.error(
        "파일이 너무 커요(최대 50MB). Slack에서 기간을 나눠 내보내 주세요.",
      );
      event.target.value = "";
      setFile(null);
      return;
    }
    setFile(picked);
    if (workspaceName.trim() === "") {
      setWorkspaceName(guessWorkspaceName(picked.name));
    }
  }

  function startOver() {
    if (storageKey) clearPendingImport(storageKey);
    setPending(null);
    setGaveUp(false);
  }

  /* --- 진행/결과 -------------------------------------------------------- */
  if (pending) {
    const failed = status?.status === "failed";
    const completed = status?.status === "completed";
    return (
      <div className="border-border w-full max-w-sm rounded-xl border p-4 text-left">
        {completed ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <CircleCheck className="size-4 shrink-0" />
              가져오기가 끝났어요
            </p>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              {/* 0건도 정직하게 말한다 — "성공했지만 검색할 게 없다"는 다른 사실이다. */}
              메시지 {(status.messageCount ?? 0).toLocaleString("ko-KR")}건
              {status.channelCount !== null
                ? ` · 채널 ${status.channelCount.toLocaleString("ko-KR")}개`
                : ""}
              를 읽었어요
              {status.createdMessageCount !== null
                ? ` (새로 저장 ${status.createdMessageCount.toLocaleString("ko-KR")}건)`
                : ""}
              .
            </p>
            {status.skippedMessageCount ? (
              <p className="text-muted-foreground text-[12px] leading-relaxed">
                채널을 찾지 못해 건너뛴 메시지가{" "}
                {status.skippedMessageCount.toLocaleString("ko-KR")}건 있어요.
              </p>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={startOver}>
              다른 파일 올리기
            </Button>
          </div>
        ) : failed ? (
          <div className="flex flex-col gap-2">
            <p className="text-destructive flex items-center gap-2 text-sm font-semibold">
              <TriangleAlert className="size-4 shrink-0" />
              가져오지 못했어요
            </p>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              {slackImportErrorMessage(status?.errorCode ?? null)}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={startOver}>
              다시 시도하기
            </Button>
          </div>
        ) : gaveUp ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">아직 처리 중이에요</p>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              {/* 실패라고 단정하지 않는다 — 처리 시간 상한을 우리도 모른다. */}
              생각보다 오래 걸리고 있어요. 이 화면을 닫아도 처리 자체는 계속돼요.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={statusQuery.isFetching}
                onClick={() => {
                  setGaveUp(false);
                  void statusQuery.refetch();
                }}
              >
                <RefreshCw className="size-4" />
                다시 확인
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={startOver}>
                그만 보기
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              {status?.status === "processing"
                ? "기록을 읽고 있어요…"
                : "가져오기를 기다리고 있어요…"}
            </p>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              파일이 크면 몇 분 걸릴 수 있어요. 이 화면을 벗어나도 처리는 계속되고,
              돌아오면 결과를 보여드려요.
            </p>
          </div>
        )}
      </div>
    );
  }

  /* --- 업로드 폼 -------------------------------------------------------- */
  const uploading = uploadMutation.isPending;
  return (
    <div className="border-border flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4 text-left">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold">Slack 기록 가져오기</p>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Slack에서 내려받은 Export ZIP을 그대로 올려주세요. 압축을 직접 풀 필요
          없어요.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slack-export-file">Export 파일</Label>
        <input
          ref={fileInputRef}
          id="slack-export-file"
          type="file"
          accept=".zip,.json,application/zip,application/json"
          disabled={uploading}
          onChange={onPick}
          className="file:bg-muted file:text-foreground text-muted-foreground w-full text-[13px] file:mr-3 file:rounded-lg file:border-0 file:px-3 file:py-2 file:text-[13px] file:font-medium"
        />
        <p className="text-muted-foreground text-[12px]">
          최대 50MB · ZIP 또는 단일 JSON 번들
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slack-workspace-name">워크스페이스 이름</Label>
        <Input
          id="slack-workspace-name"
          value={workspaceName}
          disabled={uploading}
          maxLength={100}
          placeholder="예: 우리 회사"
          onChange={(e) => setWorkspaceName(e.target.value)}
          className="h-10"
        />
        <p className="text-muted-foreground text-[12px]">
          {/* ZIP 안에는 워크스페이스 이름이 들어 있지 않다 — 사용자가 정하는 값이다. */}
          같은 이름으로 다시 올리면 기존 기록에 이어서 쌓여요.
        </p>
      </div>

      <Button
        type="button"
        className="w-full"
        disabled={!file || uploading}
        onClick={() =>
          file && uploadMutation.mutate({ file, workspaceName })
        }
      >
        {uploading ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            올리는 중…
          </>
        ) : (
          <>
            <Upload className="size-4" />
            가져오기
          </>
        )}
      </Button>
      {uploading ? (
        <p className="text-muted-foreground text-[12px] leading-relaxed">
          {/* 전송 중에는 이어받을 수 없다. 조용히 실패하게 두지 않고 미리 말한다. */}
          올리는 동안은 이 화면을 열어 두세요. 지금 앱을 벗어나면 전송이 끊겨
          처음부터 다시 올려야 해요.
        </p>
      ) : null}
    </div>
  );
}
