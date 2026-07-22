"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 알림 설정 (/more/notifications)
 *
 * user 스코프 알림 선호(notification_preferences)를 편집한다. 백엔드/계약은 완비돼
 * 있어(GET/PUT preferences) 이 화면은 폼만 담당한다. 저장은 전체 대체(PUT).
 * 무음 시간대는 분(0~1439)으로 저장하고 UI에서는 HH:MM으로 다룬다. 켜려면 시작·끝
 * 둘 다, 끄려면 둘 다 null(contracts refine과 동일 규칙).
 * ------------------------------------------------------------------------- */
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageBackHeader } from "@/components/widgets";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from "@/lib/queries";

/** 분(0~1439) → "HH:MM". */
function minuteToTime(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "HH:MM" → 분(0~1439). 유효하지 않으면 null. */
function timeToMinute(v: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export default function NotificationSettingsPage() {
  const { data, isLoading, isError } = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();

  const [pushEnabled, setPushEnabled] = useState(true);
  const [minAmount, setMinAmount] = useState<string>(""); // 빈 문자열 = 제한 없음(null)
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("07:00");

  // 서버 값 → 폼 초기화(최초 로드).
  useEffect(() => {
    if (!data) return;
    setPushEnabled(data.pushEnabled);
    setMinAmount(data.minAmount != null ? String(data.minAmount) : "");
    const hasQuiet =
      data.quietStartMinute != null && data.quietEndMinute != null;
    setQuietEnabled(hasQuiet);
    if (hasQuiet) {
      setQuietStart(minuteToTime(data.quietStartMinute as number));
      setQuietEnd(minuteToTime(data.quietEndMinute as number));
    }
  }, [data]);

  function onSave() {
    const trimmed = minAmount.trim();
    const parsedMin = trimmed === "" ? null : Number(trimmed);
    if (parsedMin !== null && (!Number.isInteger(parsedMin) || parsedMin < 0)) {
      toast.error("최소 금액은 0 이상의 정수여야 해요.");
      return;
    }

    let startMin: number | null = null;
    let endMin: number | null = null;
    if (quietEnabled) {
      startMin = timeToMinute(quietStart);
      endMin = timeToMinute(quietEnd);
      if (startMin === null || endMin === null) {
        toast.error("무음 시간대 형식이 올바르지 않아요.");
        return;
      }
    }

    update.mutate(
      {
        pushEnabled,
        // 본인 수집 거래도 항상 수신(설정에서 끄지 않는 정책) — 계약 필드는 true 고정.
        notifyOwnCollected: true,
        minAmount: parsedMin,
        quietStartMinute: startMin,
        quietEndMinute: endMin,
      },
      {
        onSuccess: () => toast.success("알림 설정을 저장했어요."),
        onError: () => toast.error("저장에 실패했어요. 잠시 후 다시 시도해 주세요."),
      },
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageBackHeader title="알림 설정" />

      {isLoading ? (
        <p className="text-muted-foreground text-sm">불러오는 중…</p>
      ) : isError ? (
        <p className="text-destructive text-sm">
          설정을 불러오지 못했어요. 새로고침해 주세요.
        </p>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-col gap-5">
              {/* 푸시 전체 on/off */}
              <div className="flex items-center justify-between gap-3">
                <span className="flex flex-col gap-0.5">
                  <span className="text-[15px] font-medium">푸시 알림</span>
                  <span className="text-muted-foreground text-[13px]">
                    끄면 이 기기로 어떤 알림도 오지 않아요
                  </span>
                </span>
                <Switch
                  checked={pushEnabled}
                  onCheckedChange={setPushEnabled}
                  aria-label="푸시 알림"
                />
              </div>

              {/* 최소 금액 */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="minAmount">최소 알림 금액</Label>
                <Input
                  id="minAmount"
                  inputMode="numeric"
                  placeholder="예: 10000 (비우면 제한 없음)"
                  value={minAmount}
                  disabled={!pushEnabled}
                  onChange={(e) =>
                    setMinAmount(e.target.value.replace(/[^\d]/g, ""))
                  }
                />
                <span className="text-muted-foreground text-[13px]">
                  이 금액 미만 결제는 알림을 보내지 않아요(거래 알림에만 적용)
                </span>
              </div>
            </CardContent>
          </Card>

          {/* 무음 시간대 */}
          <Card>
            <CardContent className="flex flex-col gap-5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex flex-col gap-0.5">
                  <span className="text-[15px] font-medium">무음 시간대</span>
                  <span className="text-muted-foreground text-[13px]">
                    지정한 시간에는 알림을 보내지 않아요(자정 넘김 가능)
                  </span>
                </span>
                <Switch
                  checked={quietEnabled}
                  onCheckedChange={setQuietEnabled}
                  disabled={!pushEnabled}
                  aria-label="무음 시간대"
                />
              </div>
              {quietEnabled ? (
                <div className="flex items-center gap-3">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="quietStart">시작</Label>
                    <Input
                      id="quietStart"
                      type="time"
                      value={quietStart}
                      disabled={!pushEnabled}
                      onChange={(e) => setQuietStart(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="quietEnd">끝</Label>
                    <Input
                      id="quietEnd"
                      type="time"
                      value={quietEnd}
                      disabled={!pushEnabled}
                      onChange={(e) => setQuietEnd(e.target.value)}
                    />
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Button onClick={onSave} disabled={update.isPending}>
            {update.isPending ? "저장 중…" : "저장"}
          </Button>
        </>
      )}
    </div>
  );
}
