"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 장치 (오늘의집 톤)
 *
 * - 장치 행은 **두 신호를 분리**해 보여준다: 연결 확인(lastSeenAt) / 마지막 문자
 *   수신(lastEventAt). 하나로 합치면 자동화의 문자 트리거가 죽어도(인증만 계속
 *   성공) 정상으로 보이고, 사용자는 지출이 왜 비었는지 알 수 없다(진단 D-2).
 * - 등록/재발급 뒤에는 secret 덤프 대신 **수집 설정 마법사**(로드맵 C-2)를 연다.
 *   자격증명을 보여주는 것만으로는 설정이 끝나지 않는다 — 첫 문자가 들어와야
 *   끝난 것이고, 마법사가 그 지점까지 데려간다.
 * - 첫 문자 전 장치에는 '설정 미완료' 배지 + '설정 계속하기'를 둔다.
 * ------------------------------------------------------------------------- */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  MoreHorizontal,
  Plus,
  Smartphone,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import type {
  DevicePlatform,
  DeviceRegisterRequest,
  DeviceSecretResponse,
  DeviceSummary,
} from "@family/contracts";

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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CollectSetupWizard } from "@/components/collect-setup-wizard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ListRow, PageBackHeader, StatusBadge } from "@/components/widgets";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { isSetupComplete } from "@/lib/device-signal";
import { useHousehold } from "@/lib/household-context";
import { useDevices } from "@/lib/queries";
import { formatDate } from "@/lib/format";

/** 플랫폼 표시 라벨. */
const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  ios: "iOS",
  android: "Android",
  other: "기타",
};

const PLATFORM_OPTIONS = (["ios", "android", "other"] as const).map(
  (value) => ({ value, label: PLATFORM_LABEL[value] }),
);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export default function DevicesPage() {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const queryClient = useQueryClient();

  const devicesQuery = useDevices();

  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<DevicePlatform>("ios");
  const [formError, setFormError] = useState<string | null>(null);

  // "장치 등록" 주 CTA → 등록 Dialog.
  const [registerOpen, setRegisterOpen] = useState(false);

  /**
   * 수집 설정 마법사. `issued`는 등록/재발급 응답에서 **한 번만** 오는 자격증명이라
   * 이 상태 밖에는 저장하지 않는다(뮤테이션 캐시도 닫을 때 reset). 마법사를
   * '설정 계속하기'로 여는 경우에는 null이며, 그때는 재발급만 제안할 수 있다.
   */
  const [wizard, setWizard] = useState<{
    deviceId: string;
    issued: DeviceSecretResponse | null;
    initialStep: 1 | 2;
  } | null>(null);

  // 파괴적 동작 확인 (재발급/폐기).
  const [confirm, setConfirm] = useState<
    { type: "rotate" | "revoke"; device: DeviceSummary } | null
  >(null);

  const invalidateDevices = () =>
    queryClient.invalidateQueries({ queryKey: ["devices", householdId] });

  const registerMutation = useMutation({
    mutationFn: (body: DeviceRegisterRequest) =>
      authedFetch((token) => api.devices.register(token, body)),
    onSuccess: (result) => {
      void invalidateDevices();
      setName("");
      setPlatform("ios");
      setFormError(null);
      setRegisterOpen(false);
      // 등록은 시작이지 완료가 아니다 — 바로 설정 마법사로 이어 붙인다.
      setWizard({ deviceId: result.device.id, issued: result, initialStep: 1 });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.devices.rotate(token, id)),
    onSuccess: (result) => {
      void invalidateDevices();
      // 재발급하면 자동화에 넣어둔 옛 값이 즉시 죽는다. 새 값을 어디에 넣어야
      // 하는지까지 안내해야 수집이 멈춘 채 방치되지 않는다(앱은 이미 깔려 있으므로 2단계).
      setWizard({ deviceId: result.device.id, issued: result, initialStep: 2 });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.devices.revoke(token, id)),
    onSuccess: () => void invalidateDevices(),
  });

  function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!householdId) return;
    if (name.trim() === "") {
      setFormError("장치 이름을 입력해 주세요.");
      return;
    }
    registerMutation.mutate({
      householdId,
      name: name.trim(),
      platform,
    });
  }

  function runConfirm() {
    if (!confirm) return;
    if (confirm.type === "rotate") {
      rotateMutation.mutate(confirm.device.id);
    } else {
      revokeMutation.mutate(confirm.device.id);
    }
    setConfirm(null);
  }

  /**
   * 마법사 닫기. raw secret/collectToken이 mutation cache
   * (registerMutation.data / rotateMutation.data)에 남지 않도록 reset까지 수행
   * — '지금만 볼 수 있어요' 계약을 메모리 상태에도 동일하게 적용한다.
   */
  function closeWizard() {
    setWizard(null);
    registerMutation.reset();
    rotateMutation.reset();
  }

  const devices = devicesQuery.data ?? [];
  const isEmpty =
    !devicesQuery.isLoading && !devicesQuery.isError && devices.length === 0;

  // 마법사가 보는 장치는 **목록의 최신 행**이다 — 등록 응답 스냅샷을 계속 보면
  // 폴링으로 firstEventAt이 채워져도 화면이 영영 '대기 중'에 머문다.
  const wizardDevice = useMemo(
    () =>
      wizard
        ? (devices.find((d) => d.id === wizard.deviceId) ??
          wizard.issued?.device ??
          null)
        : null,
    [wizard, devices],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageBackHeader
        title="장치"
        subtitle="휴대폰을 등록하면 카드 문자를 자동으로 모아요."
      />

      {/* 장치 목록 */}
      <Card>
        <CardHeader>
          <CardTitle>등록된 장치</CardTitle>
          <CardDescription>
            플랫폼과 마지막 수신 상태를 한눈에 볼 수 있어요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {devicesQuery.isLoading ? (
            <div className="flex flex-col gap-3 py-2">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </div>
          ) : devicesQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {errorMessage(devicesQuery.error, "장치를 불러오지 못했어요.")}
            </p>
          ) : devices.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="bg-muted flex size-12 items-center justify-center rounded-full">
                <Smartphone
                  className="text-muted-foreground size-6"
                  aria-hidden="true"
                />
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-[15px] font-semibold">
                  아직 등록된 장치가 없어요
                </p>
                <p className="text-muted-foreground text-[13px]">
                  휴대폰을 등록하면 카드 문자를 자동으로 모아요
                </p>
              </div>
              <Button
                type="button"
                className="mt-1"
                onClick={() => setRegisterOpen(true)}
              >
                <Plus /> 장치 등록하기
              </Button>
            </div>
          ) : (
            <div className="flex flex-col">
              {devices.map((d) => (
                <div key={d.id} className="flex flex-col">
                <div className="flex items-center gap-1">
                  <ListRow
                    className="min-w-0 flex-1"
                    icon={d.platform === "other" ? <Bot /> : <Smartphone />}
                    title={d.name}
                    subtitle={
                      /* 두 신호를 한 줄로 합치지 않는다 — 인증만 성공하고 문자가
                         끊긴 상태가 정상으로 보이던 것이 이 화면의 버그였다. */
                      <span className="flex flex-col gap-0.5">
                        <span>
                          {PLATFORM_LABEL[d.platform]} · 연결 확인{" "}
                          {d.lastSeenAt ? formatDate(d.lastSeenAt) : "아직 없어요"}
                        </span>
                        <span>
                          마지막 문자{" "}
                          {d.lastEventAt
                            ? formatDate(d.lastEventAt)
                            : "아직 받지 못했어요"}
                        </span>
                      </span>
                    }
                    valueSub={
                      d.status === "active" && !isSetupComplete(d) ? (
                        <StatusBadge
                          status="setup_incomplete"
                          label="설정 미완료"
                          tone="warning"
                        />
                      ) : (
                        <StatusBadge status={d.status} />
                      )
                    }
                  />
                  {d.status === "active" ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          aria-label={`${d.name} 관리 메뉴`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={rotateMutation.isPending}
                          onSelect={() =>
                            setConfirm({ type: "rotate", device: d })
                          }
                        >
                          secret·수집 토큰 재발급
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={revokeMutation.isPending}
                          onSelect={() =>
                            setConfirm({ type: "revoke", device: d })
                          }
                        >
                          장치 폐기
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                {/* 첫 문자가 오기 전까지는 등록이 끝난 게 아니다 — 다음 행동을 남겨둔다. */}
                {d.status === "active" && !isSetupComplete(d) ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg px-2 pb-3">
                    <span className="text-muted-foreground text-[13px]">
                      {d.lastSeenAt
                        ? "연결은 됐어요. 문자만 아직이에요."
                        : "아직 연결 확인 전이에요."}
                    </span>
                    <Button
                      type="button"
                      variant="tint"
                      size="sm"
                      onClick={() =>
                        setWizard({
                          deviceId: d.id,
                          issued: null,
                          initialStep: 2,
                        })
                      }
                    >
                      설정 계속하기
                    </Button>
                  </div>
                ) : null}
                </div>
              ))}
            </div>
          )}
          {revokeMutation.isError ? (
            <p className="text-destructive mt-3 text-sm" role="alert">
              {errorMessage(revokeMutation.error, "폐기하지 못했어요.")}
            </p>
          ) : null}
          {rotateMutation.isError ? (
            <p className="text-destructive mt-3 text-sm" role="alert">
              {errorMessage(
                rotateMutation.error,
                "secret을 재발급하지 못했어요.",
              )}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* 주 CTA — 빈 상태에서는 빈 상태 안의 CTA 하나만 노출 */}
      {!isEmpty ? (
        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={() => setRegisterOpen(true)}
        >
          <Plus /> 장치 등록
        </Button>
      ) : null}

      {/* 등록 Dialog */}
      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>장치 등록</DialogTitle>
            <DialogDescription>
              등록하면 secret이 딱 한 번 표시돼요. 장치 앱에 안전하게 저장해
              주세요.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onRegister} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-name">장치 이름</Label>
              <Input
                id="device-name"
                type="text"
                placeholder="예: 엄마 아이폰"
                maxLength={100}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-platform">플랫폼</Label>
              <Select
                value={platform}
                onValueChange={(value) => setPlatform(value as DevicePlatform)}
              >
                <SelectTrigger id="device-platform" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORM_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {formError ? (
              <p className="text-destructive text-sm" role="alert">
                {formError}
              </p>
            ) : null}
            {registerMutation.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {errorMessage(
                  registerMutation.error,
                  "장치를 등록하지 못했어요.",
                )}
              </p>
            ) : null}
            <DialogFooter className="flex-col sm:flex-col">
              <Button
                type="submit"
                className="h-11 w-full"
                disabled={registerMutation.isPending}
              >
                {registerMutation.isPending ? "등록하고 있어요…" : "등록하기"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-full"
                onClick={() => setRegisterOpen(false)}
              >
                다음에 할게요
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 수집 설정 마법사 — 등록/재발급 직후, 그리고 '설정 계속하기'로 진입 */}
      {wizard && wizardDevice ? (
        <CollectSetupWizard
          open
          onOpenChange={(o) => !o && closeWizard()}
          device={wizardDevice}
          issued={wizard.issued}
          initialStep={wizard.initialStep}
          onReissue={() => rotateMutation.mutate(wizard.deviceId)}
          reissuePending={rotateMutation.isPending}
        />
      ) : null}

      {/* 파괴적 동작 확인 */}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.type === "rotate"
                ? "secret과 수집 토큰을 재발급할까요?"
                : "이 장치를 폐기할까요?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.type === "rotate"
                ? `'${confirm.device.name}' 장치의 secret과 간편 수집 토큰을 모두 새로 발급해요. 이전 값들은 바로 사용할 수 없게 되니, 단축어·MacroDroid에 새 수집 토큰을 다시 넣어 주세요.`
                : confirm
                  ? `'${confirm.device.name}' 장치를 폐기하면 더 이상 이 장치의 카드 문자를 받아오지 않아요.`
                  : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={runConfirm}
              className={
                confirm?.type === "revoke"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
            >
              {confirm?.type === "revoke" ? "폐기하기" : "재발급하기"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
