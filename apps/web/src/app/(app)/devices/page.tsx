"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 장치 (오늘의집 톤)
 *
 * - 장치 = ListRow(플랫폼 아이콘 · 이름 · 플랫폼/마지막 수신 subtitle · 상태 배지)
 *   + 행 우측 ⋯ DropdownMenu(secret 재발급 / 폐기 — AlertDialog 확인).
 * - "장치 등록" 주 CTA → 등록 Dialog(이름 + 플랫폼).
 * - secret은 register/rotate 응답에서 단 한 번만 노출 → 1회 노출 Dialog + 복사.
 * 쿼리/뮤테이션/상태/핸들러는 기존 로직 그대로 보존.
 * ------------------------------------------------------------------------- */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  Copy,
  MoreHorizontal,
  Plus,
  Smartphone,
} from "lucide-react";
import { useState, type FormEvent } from "react";

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
import { ListRow, StatusBadge } from "@/components/widgets";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
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

  // register/rotate 공용: secret 1회 노출 Dialog.
  const [secret, setSecret] = useState<DeviceSecretResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

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
      setCopied(false);
      setTokenCopied(false);
      setRegisterOpen(false);
      setSecret(result);
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.devices.rotate(token, id)),
    onSuccess: (result) => {
      void invalidateDevices();
      setCopied(false);
      setTokenCopied(false);
      setSecret(result);
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

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function copyCollectToken() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.collectToken);
      setTokenCopied(true);
    } catch {
      setTokenCopied(false);
    }
  }

  /**
   * 1회 노출 다이얼로그 닫기. raw secret/collectToken이 mutation cache
   * (registerMutation.data / rotateMutation.data)에 남지 않도록 reset까지 수행
   * — '지금만 볼 수 있어요' 계약을 메모리 상태에도 동일하게 적용한다.
   */
  function closeSecretDialog() {
    setSecret(null);
    registerMutation.reset();
    rotateMutation.reset();
  }

  const devices = devicesQuery.data ?? [];
  const isEmpty =
    !devicesQuery.isLoading && !devicesQuery.isError && devices.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">장치</h1>
        <p className="text-muted-foreground text-sm">
          휴대폰을 등록하면 카드 문자를 자동으로 모아요.
        </p>
      </div>

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
                <div key={d.id} className="flex items-center gap-1">
                  <ListRow
                    className="min-w-0 flex-1"
                    icon={d.platform === "other" ? <Bot /> : <Smartphone />}
                    title={d.name}
                    subtitle={`${PLATFORM_LABEL[d.platform]} · ${
                      d.lastSeenAt
                        ? `마지막 수신 ${formatDate(d.lastSeenAt)}`
                        : "아직 수신이 없어요"
                    }`}
                    valueSub={<StatusBadge status={d.status} />}
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

      {/* secret 1회 노출 Dialog */}
      <Dialog
        open={secret !== null}
        onOpenChange={(o) => !o && closeSecretDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>장치 secret이 발급됐어요</DialogTitle>
            <DialogDescription>
              <span className="text-destructive font-semibold">
                지금만 볼 수 있어요.
              </span>{" "}
              창을 닫으면 다시 확인할 수 없으니 장치 앱에 안전하게 저장해
              주세요.
            </DialogDescription>
          </DialogHeader>
          {secret ? (
            <div className="flex flex-col gap-4 text-sm">
              <div className="bg-muted flex flex-col gap-3 rounded-lg p-3">
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">장치</span>
                  <span className="font-medium">{secret.device.name}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    deviceId
                  </span>
                  <code className="font-mono text-xs break-all">
                    {secret.deviceId}
                  </code>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">secret</span>
                  <code className="font-mono text-xs break-all">
                    {secret.secret}
                  </code>
                </div>
              </div>
              <Button
                type="button"
                variant="tint"
                className="w-full"
                onClick={copySecret}
              >
                {copied ? (
                  <>
                    <Check /> 복사했어요
                  </>
                ) : (
                  <>
                    <Copy /> secret 복사하기
                  </>
                )}
              </Button>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">서명 방식</span>
                <span className="text-muted-foreground">
                  {secret.algorithm}
                </span>
                <span className="text-muted-foreground text-xs whitespace-pre-wrap">
                  {secret.signingRecipe}
                </span>
              </div>

              <div className="border-border flex flex-col gap-3 border-t pt-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[13px] font-semibold">
                    간편 수집 토큰(단축어·MacroDroid용)
                  </span>
                  <span className="text-muted-foreground text-xs">
                    서명 계산이 어려운 자동화 앱은 이 토큰을{" "}
                    <code className="bg-muted rounded px-1 py-0.5">
                      Authorization: Bearer
                    </code>{" "}
                    헤더로 보내면 돼요. secret과 별개로 동작해요.
                  </span>
                </div>
                <div className="bg-muted flex flex-col gap-1 rounded-lg p-3">
                  <code className="font-mono text-xs break-all">
                    {secret.collectToken}
                  </code>
                </div>
                <Button
                  type="button"
                  variant="tint"
                  className="w-full"
                  onClick={copyCollectToken}
                >
                  {tokenCopied ? (
                    <>
                      <Check /> 복사했어요
                    </>
                  ) : (
                    <>
                      <Copy /> 수집 토큰 복사하기
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : null}
          <DialogFooter className="flex-col sm:flex-col">
            <Button className="h-11 w-full" onClick={closeSecretDialog}>
              안전하게 저장했어요
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
