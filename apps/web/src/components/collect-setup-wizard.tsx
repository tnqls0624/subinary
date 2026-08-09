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
 *   2) 설정 복사 — 한 번에 복사 + '연결 테스트'(인증만 먼저 확인).
 *   3) 첫 문자 대기 — firstEventAt이 생기면 자동으로 성공 화면.
 *
 * 왜 '연결 테스트'와 '첫 문자'를 나누는가: 인증 성공(lastSeenAt)과 문자 수신
 * (firstEventAt)은 **다른 실패**다. 둘을 한 덩어리로 보여주면 사용자는 토큰을
 * 계속 다시 넣으며 엉뚱한 곳을 고친다. 60초가 지나도 문자가 없으면 Signal Doctor가
 * 지금 관측된 신호로 원인을 하나로 좁힌다(device-signal.ts).
 *
 * 보안: collect token은 Bearer 자격증명이라 등록/회전 응답에서 **한 번만** 나온다.
 * 화면을 닫으면 복구가 불가능(재발급만 가능)하므로 그 사실을 계속 보이게 둔다.
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
import { useEffect, useMemo, useState } from "react";

import type { DeviceSecretResponse, DeviceSummary } from "@family/contracts";

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
  type SetupEntry,
} from "@/lib/collect-setup";
import { FIRST_EVENT_WAIT_MS, diagnoseDeviceSignal } from "@/lib/device-signal";
import { formatDate } from "@/lib/format";
import { useDevices } from "@/lib/queries";

/** 첫 문자 대기 중 장치 목록을 다시 읽는 주기. */
const WAIT_POLL_MS = 5_000;

type WizardStep = 1 | 2 | 3;

interface CollectSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 설정 대상 장치(목록에서 온 최신 신호). */
  device: DeviceSummary;
  /**
   * 방금 등록/재발급해서 **딱 한 번** 받은 자격증명. 나중에 '설정 계속하기'로
   * 들어오면 null이다 — 그때는 토큰을 다시 보여줄 수 없고 재발급만 가능하다.
   */
  issued: DeviceSecretResponse | null;
  /** 토큰을 잃어버렸을 때 재발급(rotate) 시키기. */
  onReissue: () => void;
  reissuePending: boolean;
  /**
   * 열릴 때 시작할 단계. 재발급·설정 이어가기로 들어오면 앱은 이미 깔려 있으므로
   * 2단계부터 시작한다 — 이미 한 일을 다시 시키면 사용자는 화면을 닫는다.
   */
  initialStep?: WizardStep;
}

/** 값 한 줄(라벨 + 모노스페이스 값 + 왜 그대로 쓰면 안 되는지). */
function SettingRow({ entry }: { entry: SetupEntry }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{entry.label}</span>
      <code className="font-mono text-xs break-all">{entry.value}</code>
      {entry.note ? (
        <span className="text-muted-foreground text-[11px] leading-relaxed">
          {entry.note}
        </span>
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
  reissuePending,
  initialStep = 1,
}: CollectSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

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
        // 토큰이 없는 '이어가기' 모드에서도 절차는 보여줘야 한다. 값 자리에는
        // 실제 토큰 대신 무엇을 넣어야 하는지를 적는다(추측 값을 인쇄하지 않는다).
        collectToken: collectToken ?? "(등록할 때 받은 수집 토큰)",
        apiBaseUrl: API_BASE_URL,
        deviceName: device.name,
      }),
    [device.platform, device.name, collectToken],
  );

  // 첫 문자 대기 중에만 폴링한다. 다이얼로그가 닫히면 이 컴포넌트가 사라지고
  // 폴링도 함께 멈춘다.
  const waiting = open && step === 3 && device.firstEventAt == null;
  useDevices({ refetchInterval: waiting ? WAIT_POLL_MS : false });

  // 열릴 때마다, 그리고 **토큰이 새로 발급될 때마다** 처음 상태로 되돌린다.
  // 재발급 직후에도 '복사했어요'/'연결됐어요'가 남아 있으면 사용자는 옛 값을 이미
  // 넣었다고 믿고 그대로 나간다 — 그 순간부터 수집이 조용히 멈춘다.
  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setCopied(false);
    setCopyFailed(false);
    setPingState("idle");
    setPingError(null);
    setWaitStartedAt(null);
    setWaitedEnough(false);
  }, [open, initialStep, device.id, collectToken]);

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

  const received = device.firstEventAt != null;

  async function copyAll() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(
        buildSetupClipboardText(plan, device.name),
      );
      setCopied(true);
    } catch {
      // 클립보드는 권한·컨텍스트(비-HTTPS)로 막힐 수 있다. 실패를 삼키면
      // 사용자는 복사됐다고 믿고 빈 값을 붙여넣는다.
      setCopied(false);
      setCopyFailed(true);
    }
  }

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {received
              ? "연결이 끝났어요"
              : `'${device.name}' 연결하는 중 ${step}/3`}
          </DialogTitle>
          <DialogDescription>
            {received
              ? "이제 카드 문자가 오면 자동으로 지출에 쌓여요."
              : "카드 문자를 자동으로 모아오도록 휴대폰을 설정할게요."}
          </DialogDescription>
        </DialogHeader>

        {/* 진행 표시 — 3단계 중 어디인지 항상 보이게 둔다. */}
        {!received ? (
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
            <p className="text-[15px] font-semibold">
              첫 문자를 받았어요
            </p>
            <p className="text-muted-foreground text-[13px]">
              {formatDate(device.firstEventAt)}에 이 휴대폰에서 카드 문자가
              도착했어요. 앞으로는 따로 할 일이 없어요.
            </p>
          </div>
        ) : step === 1 ? (
          /* --- 1단계: 앱 설치 ------------------------------------------ */
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1">
              <p className="text-[15px] font-semibold">
                ① {plan.appName} 앱을 준비해 주세요
              </p>
              <p className="text-muted-foreground text-[13px]">
                {plan.appDescription}
              </p>
            </div>
            {plan.appStoreUrl ? (
              <Button asChild variant="tint" className="w-full">
                <a
                  href={plan.appStoreUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <ExternalLink /> {plan.appStoreCta}
                </a>
              </Button>
            ) : null}
            <div className="bg-muted flex flex-col gap-2 rounded-lg p-3 text-[13px]">
              <span className="font-medium">앱에서 만들 것</span>
              <span className="text-muted-foreground">{plan.triggerSummary}</span>
              <span className="text-muted-foreground">{plan.actionSummary}</span>
              <span className="text-muted-foreground text-[11px]">
                메뉴 이름은 앱 버전에 따라 조금씩 달라요. 비슷한 이름을 찾으면 돼요.
              </span>
            </div>
          </div>
        ) : step === 2 ? (
          /* --- 2단계: 설정 복사 ---------------------------------------- */
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1">
              <p className="text-[15px] font-semibold">
                ② 아래 설정을 그대로 옮겨 적어 주세요
              </p>
              <p className="text-muted-foreground text-[13px]">
                {plan.actionSummary}
              </p>
            </div>

            {collectToken ? (
              <p
                className="text-destructive flex items-start gap-1.5 text-[13px] font-medium"
                role="alert"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                이 화면을 닫으면 열쇠 값을 다시 볼 수 없어요. 먼저 복사해 주세요.
              </p>
            ) : (
              <div className="bg-muted flex flex-col gap-2 rounded-lg p-3">
                <p className="text-[13px]">
                  열쇠 값은 등록할 때 한 번만 보여드려요. 적어둔 값이 없다면 새로
                  발급받아 다시 넣어 주세요.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onReissue}
                  disabled={reissuePending}
                >
                  <RefreshCw />
                  {reissuePending ? "발급하고 있어요…" : "새로 발급받기"}
                </Button>
              </div>
            )}

            <div className="bg-muted flex flex-col gap-3 rounded-lg p-3">
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  요청 방식 · 주소
                </span>
                <code className="font-mono text-xs break-all">
                  {plan.method} {plan.endpoint}
                </code>
              </div>
              {plan.headers.map((header) => (
                <SettingRow key={header.label} entry={header} />
              ))}
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  {plan.bodyLabel}
                </span>
                <code className="font-mono text-xs break-all whitespace-pre-wrap">
                  {plan.body}
                </code>
              </div>
              {plan.bodyFields.map((field) => (
                <SettingRow key={field.label} entry={field} />
              ))}
            </div>

            <Button type="button" variant="tint" className="w-full" onClick={copyAll}>
              {copied ? (
                <>
                  <Check /> 복사했어요
                </>
              ) : (
                <>
                  <Copy /> 설정 전체 복사하기
                </>
              )}
            </Button>
            {copyFailed ? (
              <p className="text-destructive text-[13px]" role="alert">
                복사하지 못했어요. 위 값을 직접 눌러 선택해 복사해 주세요.
              </p>
            ) : null}

            <div className="bg-muted/60 flex flex-col gap-1 rounded-lg p-3 text-[13px]">
              <span className="font-medium">문자를 구분하는 값</span>
              <span className="text-muted-foreground">{plan.eventIdHint}</span>
            </div>

            {plan.cautions.length > 0 ? (
              <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-[13px]">
                {plan.cautions.map((caution) => (
                  <li key={caution}>{caution}</li>
                ))}
              </ul>
            ) : null}

            {/* 연결 테스트 — 문자 수신과 분리해 '인증'만 먼저 확정한다. */}
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={runPing}
                disabled={pingState === "pending" || !collectToken}
              >
                {pingState === "pending" ? (
                  <>
                    <LoaderCircle className="animate-spin" /> 확인하고 있어요…
                  </>
                ) : (
                  <>연결 테스트</>
                )}
              </Button>
              {!collectToken ? (
                <p className="text-muted-foreground text-[13px]">
                  연결 테스트는 열쇠 값이 있어야 할 수 있어요.
                </p>
              ) : pingState === "ok" ? (
                <p className="text-[13px] font-medium text-emerald-600 dark:text-emerald-400">
                  연결됐어요. 이제 문자만 들어오면 돼요.
                </p>
              ) : pingState === "failed" ? (
                <p className="text-destructive text-[13px]" role="alert">
                  {pingError}
                </p>
              ) : (
                <p className="text-muted-foreground text-[13px]">
                  문자 없이 열쇠 값이 맞는지만 먼저 확인해 볼 수 있어요.
                </p>
              )}
            </div>

            {/* 개발자용 고급 설정 — 기본 접힘. 1단계 화면에는 절대 노출하지 않는다. */}
            {issued ? (
              <details className="border-border rounded-lg border p-3">
                <summary className="cursor-pointer text-[13px] font-medium">
                  개발자용 고급 설정 (HMAC 서명)
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <p className="text-muted-foreground text-[11px]">
                    서명을 직접 계산하는 앱을 쓸 때만 필요해요. 위 설정만으로도
                    수집은 동작합니다.
                  </p>
                  <SettingRow
                    entry={{ label: "deviceId", value: issued.deviceId }}
                  />
                  <SettingRow entry={{ label: "secret", value: issued.secret }} />
                  <SettingRow
                    entry={{ label: "algorithm", value: issued.algorithm }}
                  />
                  <SettingRow
                    entry={{
                      label: "signingRecipe",
                      value: issued.signingRecipe,
                    }}
                  />
                </div>
              </details>
            ) : null}
          </div>
        ) : (
          /* --- 3단계: 첫 문자 대기 ------------------------------------- */
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1">
              <p className="text-[15px] font-semibold">
                ③ 카드로 한 번 결제해 보세요
              </p>
              <p className="text-muted-foreground text-[13px]">
                카드사에서 온 결제 문자가 이 휴대폰에 도착하면 자동으로 알아채요.
              </p>
            </div>

            <div className="bg-muted flex items-center gap-3 rounded-lg p-4">
              <LoaderCircle className="text-muted-foreground size-5 shrink-0 animate-spin" />
              <span className="text-[13px]">첫 문자를 기다리고 있어요…</span>
            </div>

            {device.lastSeenAt ? (
              <p className="text-muted-foreground text-[13px]">
                연결 확인 {formatDate(device.lastSeenAt)}
              </p>
            ) : null}

            {/* Signal Doctor — 60초가 지나도 안 오면 관측된 신호로 원인을 좁힌다. */}
            {waitedEnough ? (
              <div className="border-border flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Stethoscope className="size-4 shrink-0" />
                  <span className="text-[13px] font-semibold">
                    {diagnosis.title}
                  </span>
                </div>
                <p className="text-muted-foreground text-[13px]">
                  {diagnosis.detail}
                </p>
                <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-[13px]">
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
            <Button className="h-11 w-full" onClick={() => onOpenChange(false)}>
              다 했어요
            </Button>
          ) : (
            <>
              {step < 3 ? (
                <Button
                  className="h-11 w-full"
                  onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
                >
                  {step === 1 ? "설치했어요" : "옮겨 적었어요"}
                </Button>
              ) : (
                <Button
                  className="h-11 w-full"
                  onClick={() => onOpenChange(false)}
                >
                  나중에 확인할게요
                </Button>
              )}
              {step > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full"
                  onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
                >
                  <ArrowLeft /> 이전 단계
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full"
                  onClick={() => onOpenChange(false)}
                >
                  나중에 할게요
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
