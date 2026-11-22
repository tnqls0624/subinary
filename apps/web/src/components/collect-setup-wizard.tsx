"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 문자 수집 설정 마법사 (로드맵 C-2)
 *
 * 이 앱의 **유일한 데이터 유입 경로**를 켜는 화면이다. 설정을 못 끝내면 다른 모든
 * 화면이 영구히 빈 상태로 남으므로, 여기서는 "값을 보여주고 끝"이 아니라
 * **끝났는지 확인될 때까지** 안내한다.
 *
 * 3단계:
 *   1) 앱 설치 — 플랫폼별. 암호학 용어는 이 화면에 절대 노출하지 않는다.
 *   2) 설정 옮겨 적기 — 자동화 앱의 칸마다 복사(전체 복사는 보조) + '연결 확인'(인증만 먼저 확인).
 *   3) 첫 문자 대기 — firstEventAt이 생기면 자동으로 성공 화면.
 *
 * 왜 '연결 테스트'와 '첫 문자'를 나누는가: 인증 성공(lastSeenAt)과 문자 수신
 * (firstEventAt)은 **다른 실패**다. 둘을 한 덩어리로 보여주면 사용자는 연결 열쇠를
 * 계속 다시 넣으며 엉뚱한 곳을 고친다. 60초가 지나도 문자가 없으면 Signal Doctor가
 * 지금 관측된 신호로 원인을 하나로 좁힌다(device-signal.ts).
 *
 * 보안: 연결 열쇠(collect token)는 Bearer 자격증명이라 등록/회전 응답에서 **한 번만**
 * 나온다. 화면을 닫으면 복구가 불가능(재발급만 가능)하므로 그 사실을 계속 보이게 둔다.
 * 열쇠를 챙기기 전(복사하거나 '옮겨 적었어요'로 넘어가기 전)에 닫으려 하면 액션 시트로 한 번
 * 묻고(안드로이드 뒤로 버튼도 같다), 열쇠가 있는 동안에는 바깥을 눌러도 닫히지 않는다 — 예전에는
 * 1단계의 '나중에 할게요'·바깥 누르기·X가 확인 없이 닫아 열쇠를 잃었다(2026-11-05 HIG 검수).
 * 서명용 값(HMAC secret 등)은 화면에 내지 않는다 — 연결 열쇠만으로 수집이 동작한다.
 * ------------------------------------------------------------------------- */
import {
  ArrowLeft,
  Check,
  CircleCheck,
  Copy,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { DeviceSecretResponse, DeviceSummary } from "@family/contracts";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { API_BASE_URL, ApiError, api } from "@/lib/api-client";
import {
  buildCollectSetup,
  buildSetupClipboardText,
  buildSetupCopySections,
  collectWizardBackAction,
  collectWizardCloseNeedsConfirm,
  collectWizardReceived,
  type SetupCopyRow,
} from "@/lib/collect-setup";
import { FIRST_EVENT_WAIT_MS, diagnoseDeviceSignal } from "@/lib/device-signal";
import { formatMonthDayTime } from "@/lib/format";
import { useDevices } from "@/lib/queries";
import { registerTransactionDetailBack } from "@/lib/transaction-detail-back";

/** 첫 문자 대기 중 기기 목록을 다시 읽는 주기. */
const WAIT_POLL_MS = 5_000;

type WizardStep = 1 | 2 | 3;

/** 재발급한 토큰을 넣을 자리 — 자동화가 이미 있으므로 어느 칸을 바꾸는지만 말한다. */
const REISSUE_WHERE: Readonly<Record<DeviceSummary["platform"], string>> = {
  ios: "단축어 자동화의 'URL의 콘텐츠 가져오기'에서",
  android: "MacroDroid 매크로의 'HTTP 요청'에서",
  other: "문자를 보내는 도구에서",
};

interface CollectSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 설정 대상 기기(목록에서 온 최신 신호). */
  device: DeviceSummary;
  /**
   * 방금 등록/재발급해서 **딱 한 번** 받은 연결 열쇠. 나중에 '설정 계속하기'로
   * 들어오면 null이다 — 그때는 열쇠를 다시 보여줄 수 없고 재발급만 가능하다.
   */
  issued: DeviceSecretResponse | null;
  /**
   * 열쇠를 잃어버렸을 때 재발급(rotate) 시키기.
   *
   * **재발급 권한이 없으면 넘기지 않는다**(undefined) — 서버가 owner 또는 기기를
   * 등록한 본인만 통과시키므로, 그 밖의 구성원에게 버튼을 보여 주면 누를 때마다
   * 실패한다(lib/device-permission.ts).
   */
  onReissue?: () => void;
  reissuePending?: boolean;
  /** 재발급 실패 문구. 마법사가 화면을 덮고 있으므로 페이지가 아니라 여기서 보여 준다. */
  reissueError?: string | null;
  /**
   * 기기 목록 ⋯ 메뉴의 '토큰 재발급'으로 열렸는가. 이때는 자동화가 이미 만들어져 있고 바꿀 것은
   * 토큰 하나뿐이라, 처음 설정용 칸별 안내 대신 새 토큰과 '토큰 복사'만 먼저 보여 준다.
   * '처음부터 설정하기'를 누르면 기존 단계 안내로 펼친다(2026-11-22 사용자 지적: 재발급했는데
   * 토큰을 복사할 창이 없다).
   */
  reissued?: boolean;
  /**
   * 열릴 때 시작할 단계. 재발급·설정 이어가기로 들어오면 앱은 이미 깔려 있으므로
   * 2단계부터 시작한다 — 이미 한 일을 다시 시키면 사용자는 화면을 닫는다.
   */
  initialStep?: WizardStep;
}

/** 마지막 복사 결과. id는 칸의 id 또는 전체 복사('all'), name은 스크린 리더에 알릴 이름. */
type CopyResult = { id: string; name: string; ok: boolean } | null;

/**
 * 칸 하나: 이름 + 값(고정폭) + 복사 버튼(44px, 누르면 '복사됨'). 자동화 앱에서 고르는 값(요청 방식)은
 * 보여 주기만 한다. 복사에 실패하면 그 칸 바로 아래에 알린다 — 멀리 있는 한 줄은 폰에서 안 보인다.
 */
function CopyRow({
  row,
  result,
  onCopy,
}: {
  row: SetupCopyRow;
  result: CopyResult;
  onCopy: (row: SetupCopyRow) => void;
}) {
  const copied = result?.id === row.id && result.ok;
  const failed = result?.id === row.id && !result.ok;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-caption text-muted-foreground">{row.label}</span>
          <code className="text-caption font-mono break-all whitespace-pre-wrap">
            {row.value}
          </code>
        </div>
        {row.copyable ? (
          <Button
            type="button"
            variant="ghost"
            // 회색 상자 안이라 ghost의 회색 눌림이 보이지 않는다 — 바탕색으로 눌림을 보인다.
            className="text-primary hover:bg-background active:bg-background min-w-20 shrink-0 px-2"
            aria-label={`${row.name} ${copied ? "복사됨" : "복사"}`}
            onClick={() => onCopy(row)}
          >
            {copied ? (
              <>
                <Check className="size-4" /> 복사됨
              </>
            ) : (
              <>
                <Copy className="size-4" /> 복사
              </>
            )}
          </Button>
        ) : null}
      </div>
      {row.note ? (
        <span className="text-micro text-muted-foreground">{row.note}</span>
      ) : null}
      {failed ? (
        <p className="text-caption text-destructive" role="alert">
          복사하지 못했어요. 값을 길게 눌러 직접 복사해 주세요.
        </p>
      ) : null}
    </div>
  );
}

export function CollectSetupWizard({
  open,
  onOpenChange,
  device,
  issued,
  onReissue,
  reissuePending = false,
  reissueError = null,
  initialStep = 1,
  reissued = false,
}: CollectSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [copyResult, setCopyResult] = useState<CopyResult>(null);
  // 연결 열쇠를 챙겼는가 — 열쇠가 든 값을 복사했거나(전체 복사 포함) '옮겨 적었어요'로 넘어갔다.
  const [keyKept, setKeyKept] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  // 재발급 직후 '새 토큰 + 토큰 복사'만 보여 주는 상태. '처음부터 설정하기'로 단계 안내를 펼친다.
  const [tokenOnly, setTokenOnly] = useState(reissued);
  // 토큰을 받은 순간의 마지막 문자 시각(서버 값). '연결이 끝났어요'는 그 뒤로 문자가 새로 들어왔을
  // 때만 띄운다. 재발급한 기기는 예전에 받은 문자(firstEventAt)가 이미 있어서, 그것으로 판정하면
  // 새 토큰을 보여 주기도 전에 성공 화면이 떴다 — 재발급하면 토큰이 한 번도 보이지 않던 원인
  // (2026-11-22). 휴대폰 시계와 섞지 않으려고 시각 비교 대신 값이 바뀌었는지만 본다.
  const latestLastEventAt = useRef(device.lastEventAt);
  latestLastEventAt.current = device.lastEventAt;
  const [baselineLastEventAt, setBaselineLastEventAt] = useState(device.lastEventAt);

  // 연결 테스트(인증만 확인).
  const [pingState, setPingState] = useState<
    "idle" | "pending" | "ok" | "failed"
  >("idle");
  const [pingError, setPingError] = useState<string | null>(null);

  // 3단계 진입 시각 — 60초가 지나야 진단을 띄운다(그전엔 '아직 안 긁은 것'과
  // 구분이 안 된다).
  const [waitStartedAt, setWaitStartedAt] = useState<number | null>(null);
  const [waitedEnough, setWaitedEnough] = useState(false);

  const collectToken = issued?.collectToken ?? null;

  const plan = useMemo(
    () =>
      buildCollectSetup({
        platform: device.platform,
        // 열쇠가 없는 '이어가기' 모드에서도 절차는 보여줘야 한다. 값 자리에는
        // 실제 열쇠 대신 무엇을 넣어야 하는지를 적는다(추측 값을 인쇄하지 않는다).
        collectToken: collectToken ?? "(등록할 때 받은 토큰)",
        apiBaseUrl: API_BASE_URL,
        deviceName: device.name,
      }),
    [device.platform, device.name, collectToken],
  );
  const copySections = useMemo(
    () => buildSetupCopySections(plan, { hasKey: collectToken != null }),
    [plan, collectToken],
  );

  // 첫 문자 대기 중에만 폴링한다. 다이얼로그가 닫히면 이 컴포넌트가 사라지고
  // 폴링도 함께 멈춘다.
  const received = collectWizardReceived({
    hasIssuedKey: collectToken != null,
    baselineLastEventAt,
    lastEventAt: device.lastEventAt,
    firstEventAt: device.firstEventAt,
  });
  const receivedAt = collectToken != null ? device.lastEventAt : device.firstEventAt;
  const showTokenOnly = tokenOnly && collectToken != null && !received;
  const waiting = open && step === 3 && !received;
  useDevices({ refetchInterval: waiting ? WAIT_POLL_MS : false });

  // 열릴 때마다, 그리고 **열쇠가 새로 발급될 때마다** 처음 상태로 되돌린다.
  // 재발급 직후에도 '복사했어요'/'연결됐어요'가 남아 있으면 사용자는 옛 값을 이미
  // 넣었다고 믿고 그대로 나간다 — 그 순간부터 수집이 조용히 멈춘다.
  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setCopyResult(null);
    setKeyKept(false);
    setConfirmCloseOpen(false);
    setTokenOnly(reissued);
    setBaselineLastEventAt(latestLastEventAt.current);
    setPingState("idle");
    setPingError(null);
    setWaitStartedAt(null);
    setWaitedEnough(false);
  }, [open, initialStep, reissued, device.id, collectToken]);

  useEffect(() => {
    if (step !== 3) return;
    if (waitStartedAt == null) {
      setWaitStartedAt(Date.now());
      return;
    }
    const remaining = FIRST_EVENT_WAIT_MS - (Date.now() - waitStartedAt);
    if (remaining <= 0) {
      setWaitedEnough(true);
      return;
    }
    const timer = setTimeout(() => setWaitedEnough(true), remaining);
    return () => clearTimeout(timer);
  }, [step, waitStartedAt]);

  const needsCloseConfirm = collectWizardCloseNeedsConfirm({
    hasIssuedKey: collectToken != null,
    keyKept,
    received,
  });

  /** 닫기(X·Esc·닫기 버튼). 열쇠를 아직 챙기지 않았으면 바로 닫지 않고 액션 시트로 묻는다. */
  function requestClose() {
    if (needsCloseConfirm) {
      setConfirmCloseOpen(true);
      return;
    }
    onOpenChange(false);
  }

  // 안드로이드 뒤로 버튼 — 이 창이 먼저 받는다. 받지 않으면 앱이 앞 화면으로 돌아가 열쇠가 든 창이
  // 확인 없이 사라진다(카드 뒤 4자리 정정 창과 같은 방식). 처리기는 매 렌더의 최신 상태를 본다.
  const onNativeBack = useRef<() => void>(() => undefined);
  onNativeBack.current = () => {
    const action = collectWizardBackAction({
      confirmOpen: confirmCloseOpen,
      needsConfirm: needsCloseConfirm,
    });
    if (action === "dismiss-confirm") setConfirmCloseOpen(false);
    else if (action === "ask") setConfirmCloseOpen(true);
    else onOpenChange(false);
  };
  useEffect(() => {
    if (!open) return;
    // 브라우저 뒤로(popstate)는 주소가 이미 바뀐 뒤라 막을 수 없다 — 화면과 함께 창도 사라진다.
    return registerTransactionDetailBack(window, (source) => {
      if (source === "native") onNativeBack.current();
    });
  }, [open]);

  async function copyText(
    target: { id: string; name: string },
    text: string,
    holdsKey: boolean,
  ) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyResult({ id: target.id, name: target.name, ok: true });
      if (holdsKey) setKeyKept(true);
    } catch {
      // 클립보드는 권한·컨텍스트(비-HTTPS)로 막힐 수 있다. 실패를 삼키면
      // 사용자는 복사됐다고 믿고 빈 값을 붙여넣는다.
      setCopyResult({ id: target.id, name: target.name, ok: false });
    }
  }

  function copyAll() {
    void copyText(
      { id: "all", name: "설정 전체" },
      buildSetupClipboardText(plan, device.name),
      true,
    );
  }

  function copyRow(row: SetupCopyRow) {
    // 상태에는 id·이름만 남긴다 — 열쇠가 든 값을 복사 결과에 들고 다니지 않는다.
    void copyText({ id: row.id, name: row.name }, row.value, row.holdsKey === true);
  }

  /** 재발급 화면의 '토큰 복사' — 자동화 앱의 Authorization 값 칸을 통째로 바꾸도록 'Bearer '까지 복사한다. */
  function copyReissuedToken() {
    if (!collectToken) return;
    void copyText({ id: "reissued-token", name: "새 토큰" }, `Bearer ${collectToken}`, true);
  }
  const tokenCopied = copyResult?.id === "reissued-token" && copyResult.ok;
  const tokenCopyFailed = copyResult?.id === "reissued-token" && !copyResult.ok;

  async function runPing() {
    if (!collectToken) return;
    setPingState("pending");
    setPingError(null);
    try {
      await api.mobileEvents.pingWithCollectToken(collectToken);
      setPingState("ok");
    } catch (error) {
      setPingState("failed");
      setPingError(
        error instanceof ApiError && error.status === 401
          ? "토큰이 맞지 않아요. 복사한 값을 다시 붙여넣어 주세요."
          : "연결하지 못했어요. 인터넷 연결과 주소를 확인해 주세요.",
      );
    }
  }

  const diagnosis = diagnoseDeviceSignal(device);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
    >
      <DialogContent
        className="overflow-y-auto"
        // 열쇠가 이 창에만 있는 동안에는 바깥을 눌러 닫지 않는다 — 실수 한 번에 열쇠를 잃는다.
        onInteractOutside={(event) => {
          if (collectToken) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {received
              ? "연결이 끝났어요"
              : showTokenOnly
                ? "토큰을 재발급했어요"
                : `'${device.name}' 연결하는 중 ${step}/3`}
          </DialogTitle>
          <DialogDescription>
            {received
              ? "이제 카드 문자가 오면 자동으로 지출에 쌓여요."
              : showTokenOnly
                ? `'${device.name}'에 넣어 둔 예전 토큰은 이제 쓸 수 없어요.`
                : "카드 문자를 자동으로 모아오도록 휴대폰을 설정할게요."}
          </DialogDescription>
        </DialogHeader>

        {/* 진행 표시 — 3단계 중 어디인지 항상 보이게 둔다. */}
        {!received && !showTokenOnly ? (
          <div className="flex gap-1.5" aria-hidden="true">
            {([1, 2, 3] as const).map((s) => (
              <span
                key={s}
                className={`h-1 flex-1 rounded-full ${
                  s <= step ? "bg-primary" : "bg-muted"
                }`}
              />
            ))}
          </div>
        ) : null}

        {received ? (
          /* --- 성공 --------------------------------------------------- */
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="bg-accent text-accent-foreground flex size-14 items-center justify-center rounded-full">
              <CircleCheck className="size-7" />
            </span>
            <p className="text-body font-semibold">첫 문자를 받았어요</p>
            <p className="text-caption text-muted-foreground">
              {formatMonthDayTime(receivedAt)}에 이 휴대폰에서 카드 문자가
              도착했어요. 앞으로는 따로 할 일이 없어요.
            </p>
          </div>
        ) : showTokenOnly ? (
          /* --- 토큰 재발급: 자동화는 그대로, 바꿀 것은 토큰 하나 -------------- */
          <div className="text-body flex flex-col gap-4">
            <p
              className="text-caption text-destructive flex items-start gap-1.5 font-medium"
              role="alert"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              이 화면을 닫으면 토큰을 다시 볼 수 없으니 먼저 복사해 주세요.
            </p>
            <div className="bg-muted flex min-w-0 flex-col gap-1 rounded-control p-3">
              <span className="text-caption text-muted-foreground">
                새 토큰 (Authorization 값)
              </span>
              <code className="text-caption font-mono break-all whitespace-pre-wrap">
                {`Bearer ${collectToken}`}
              </code>
            </div>
            <Button type="button" className="w-full" onClick={copyReissuedToken}>
              {tokenCopied ? (
                <>
                  <Check /> 복사했어요
                </>
              ) : (
                <>
                  <Copy /> 토큰 복사
                </>
              )}
            </Button>
            {tokenCopyFailed ? (
              <p className="text-caption text-destructive" role="alert">
                복사하지 못했어요. 값을 길게 눌러 직접 복사해 주세요.
              </p>
            ) : null}
            <p className="text-caption text-muted-foreground">
              {REISSUE_WHERE[plan.platform]} Authorization 헤더 값을 모두 지우고 붙여 넣어 주세요.
              &lsquo;Bearer &rsquo;까지 함께 복사돼요.
            </p>
            <p role="status" className="sr-only">
              {tokenCopied ? "새 토큰, 복사했어요." : ""}
            </p>
          </div>
        ) : step === 1 ? (
          /* --- 1단계: 앱 설치 ------------------------------------------ */
          <div className="text-body flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-body font-semibold">
                {/* '직접 연동'은 앱 이름이 아니다 — '직접 연동 앱'이라고 쓰지 않는다. */}
                {plan.platform === "other"
                  ? "① 문자를 보낼 도구를 준비해 주세요"
                  : `① ${plan.appName} 앱을 준비해 주세요`}
              </p>
              <p className="text-caption text-muted-foreground">
                {plan.appDescription}
              </p>
            </div>
            {plan.appStoreUrl ? (
              <Button asChild variant="weak" className="w-full">
                <a
                  href={plan.appStoreUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <ExternalLink /> {plan.appStoreCta}
                </a>
              </Button>
            ) : null}
            <div className="bg-muted text-caption flex flex-col gap-2 rounded-control p-3">
              <span className="font-medium">앱에서 만들 것</span>
              <span className="text-muted-foreground">{plan.triggerSummary}</span>
              <span className="text-muted-foreground">{plan.actionSummary}</span>
              <span className="text-micro text-muted-foreground">
                메뉴 이름은 앱 버전에 따라 조금씩 달라요. 비슷한 이름을 찾으면 돼요.
              </span>
            </div>
          </div>
        ) : step === 2 ? (
          /* --- 2단계: 설정 복사 ---------------------------------------- */
          <div className="text-body flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-body font-semibold">
                ② 아래 값을 앱의 칸마다 옮겨 적어 주세요
              </p>
              <p className="text-caption text-muted-foreground">
                {plan.actionSummary} · 값 옆 &lsquo;복사&rsquo;를 누른 뒤 앱의 같은 칸에 붙여 넣어요.
              </p>
            </div>

            {collectToken ? (
              <p
                className="text-caption text-destructive flex items-start gap-1.5 font-medium"
                role="alert"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                이 화면을 닫으면 토큰을 다시 볼 수 없으니 먼저 복사해 주세요.
              </p>
            ) : (
              <div className="bg-muted flex flex-col gap-2 rounded-control p-3">
                <p className="text-caption">
                  토큰은 등록할 때 한 번만 보여드려요.{" "}
                  {onReissue
                    ? "적어둔 값이 없다면 토큰을 재발급해 다시 넣어 주세요."
                    : "적어둔 값이 없다면 이 기기를 등록한 사람이나 가족의 소유자가 토큰을 재발급해 줄 수 있어요."}
                </p>
                {onReissue ? (
                  <Button
                    type="button"
                    variant="weak"
                    onClick={onReissue}
                    disabled={reissuePending}
                  >
                    <RefreshCw />
                    {reissuePending ? "재발급 중…" : "토큰 재발급"}
                  </Button>
                ) : null}
                {reissueError ? (
                  <p className="text-caption text-destructive" role="alert">
                    {reissueError}
                  </p>
                ) : null}
              </div>
            )}

            {/* 자동화 앱의 칸 순서대로 — 칸마다 복사하고 붙여 넣는다. */}
            {copySections.map((section) => (
              <section
                key={section.title}
                aria-label={section.title}
                className="bg-muted flex min-w-0 flex-col gap-3 rounded-control p-3"
              >
                <h3 className="text-caption font-semibold">{section.title}</h3>
                {section.rows.map((row) => (
                  <CopyRow
                    key={row.id}
                    row={row}
                    result={copyResult}
                    onCopy={copyRow}
                  />
                ))}
              </section>
            ))}

            {/* 전체 복사는 보조 — 메모 앱에 한꺼번에 남겨 두고 싶을 때. */}
            <Button
              type="button"
              variant="ghost"
              className="text-primary w-full"
              onClick={copyAll}
            >
              {copyResult?.id === "all" && copyResult.ok ? (
                <>
                  <Check /> 전체를 복사했어요
                </>
              ) : (
                <>
                  <Copy /> 설정 전체 복사하기
                </>
              )}
            </Button>
            {copyResult?.id === "all" && !copyResult.ok ? (
              <p className="text-caption text-destructive" role="alert">
                복사하지 못했어요. 값을 길게 눌러 직접 복사해 주세요.
              </p>
            ) : null}
            {/* 버튼 글자가 '복사됨'으로 바뀌는 것만으로는 화면 읽기 사용자가 알기 어렵다. */}
            <p role="status" className="sr-only">
              {copyResult?.ok ? `${copyResult.name}, 복사했어요.` : ""}
            </p>

            <div className="bg-muted/60 text-caption flex flex-col gap-1 rounded-control p-3">
              <span className="font-medium">문자를 구분하는 값</span>
              <span className="text-muted-foreground">{plan.eventIdHint}</span>
            </div>

            {plan.cautions.length > 0 ? (
              <ul className="text-caption text-muted-foreground flex list-disc flex-col gap-1 pl-4">
                {plan.cautions.map((caution) => (
                  <li key={caution}>{caution}</li>
                ))}
              </ul>
            ) : null}

            {/* 연결 확인 — 문자 수신과 분리해 '인증'만 먼저 확정한다. */}
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="weak"
                className="w-full"
                onClick={runPing}
                disabled={pingState === "pending" || !collectToken}
              >
                {pingState === "pending" ? (
                  <>
                    <LoaderCircle className="animate-spin" /> 확인하고 있어요…
                  </>
                ) : (
                  <>연결 확인하기</>
                )}
              </Button>
              {!collectToken ? (
                <p className="text-caption text-muted-foreground">
                  연결 확인은 토큰이 있어야 할 수 있어요.
                </p>
              ) : pingState === "ok" ? (
                <p className="text-caption text-success-strong font-medium">
                  연결됐어요. 이제 문자만 들어오면 돼요.
                </p>
              ) : pingState === "failed" ? (
                <p className="text-caption text-destructive" role="alert">
                  {pingError}
                </p>
              ) : (
                <p className="text-caption text-muted-foreground">
                  문자 없이 토큰이 맞는지만 먼저 확인해 볼 수 있어요.
                </p>
              )}
            </div>
          </div>
        ) : (
          /* --- 3단계: 첫 문자 대기 ------------------------------------- */
          <div className="text-body flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-body font-semibold">
                ③ 카드로 한 번 결제해 보세요
              </p>
              <p className="text-caption text-muted-foreground">
                카드사에서 온 결제 문자가 이 휴대폰에 도착하면 자동으로 알아채요.
              </p>
            </div>

            <div className="bg-muted flex items-center gap-3 rounded-control p-4">
              <LoaderCircle className="text-muted-foreground size-5 shrink-0 animate-spin" />
              <span className="text-caption">첫 문자를 기다리고 있어요…</span>
            </div>

            {device.lastSeenAt ? (
              <p className="text-caption text-muted-foreground">
                연결 확인 {formatMonthDayTime(device.lastSeenAt)}
              </p>
            ) : null}

            {/* Signal Doctor — 60초가 지나도 안 오면 관측된 신호로 원인을 좁힌다. */}
            {waitedEnough ? (
              <div className="bg-muted/60 flex flex-col gap-2 rounded-control p-3">
                <div className="flex items-center gap-2">
                  <Stethoscope className="size-4 shrink-0" />
                  <span className="text-caption font-semibold">
                    {diagnosis.title}
                  </span>
                </div>
                <p className="text-caption text-muted-foreground">
                  {diagnosis.detail}
                </p>
                <ul className="text-caption text-muted-foreground flex list-disc flex-col gap-1 pl-4">
                  {diagnosis.hints.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-col">
          {received ? (
            <Button className="w-full" onClick={() => onOpenChange(false)}>
              다 했어요
            </Button>
          ) : showTokenOnly ? (
            <>
              <Button type="button" variant="weak" className="w-full" onClick={requestClose}>
                닫기
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setTokenOnly(false);
                  setStep(1);
                }}
              >
                처음부터 설정하기
              </Button>
            </>
          ) : (
            <>
              {step < 3 ? (
                <Button
                  className="w-full"
                  onClick={() => {
                    // '옮겨 적었어요'는 열쇠를 자동화 앱에 넣었다는 사용자의 확인이다.
                    if (step === 2) setKeyKept(true);
                    setStep((s) => (s === 1 ? 2 : 3));
                  }}
                >
                  {step === 1 ? "준비했어요" : "옮겨 적었어요"}
                </Button>
              ) : (
                <Button className="w-full" onClick={requestClose}>
                  나중에 확인할게요
                </Button>
              )}
              {step > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
                >
                  <ArrowLeft /> 이전 단계
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={requestClose}
                >
                  닫기
                </Button>
              )}
            </>
          )}
        </DialogFooter>

        {/* 열쇠를 챙기기 전에 닫으려 할 때 — 내가 누른 동작의 확인이라 액션 시트(sheet-layout.ts 표).
            닫기를 묻는 확인이라 남는 쪽에 '닫기'를 쓰지 않는다. 남기는 '계속 설정하기'(버리기 확인의
            '계속 입력하기'와 같은 꼴), 위험한 쪽은 결과를 말하는 '열쇠 없이 닫기'. */}
        <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>닫으면 토큰을 다시 볼 수 없어요</AlertDialogTitle>
              <AlertDialogDescription>
                아직 토큰을 복사하지 않았어요. 닫은 뒤에는 토큰을 재발급해야 해요.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>계속 설정하기</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => onOpenChange(false)}
              >
                토큰 없이 닫기
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
