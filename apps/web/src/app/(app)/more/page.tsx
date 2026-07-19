"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 더보기 (/more)
 *
 * 데일리 목적지(홈/거래/예산)와 AI는 하단 탭에 두고, 저빈도 관리 화면(가족·장치)은
 * 여기로 모은다. 각 항목은 원형 아이콘 + 제목/설명 + chevron 리스트 행으로,
 * 오늘의집 설정 허브 톤을 따른다.
 * 앱 설정(생체인식 잠금) 행은 마운트 후 생체인식 가용성이 확인된 기기에서만
 * 나타난다 — 프리렌더 HTML과의 하이드레이션 불일치를 피하려고 렌더 시점
 * 분기 대신 effect 이후 상태로 가른다(웹/미지원 기기에서는 영구 숨김).
 * ------------------------------------------------------------------------- */
import {
  Activity,
  ChevronRight,
  CreditCard,
  Fingerprint,
  Smartphone,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  authenticateBiometric,
  getBiometricPref,
  isBiometryAvailable,
  setBiometricPref,
} from "@/lib/biometric";
import { useHousehold } from "@/lib/household-context";

interface MoreItem {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

const ITEMS: ReadonlyArray<MoreItem> = [
  {
    href: "/household",
    icon: Users,
    title: "가족 관리",
    description: "구성원 초대·역할, 대기 중인 초대를 관리해요",
  },
  {
    href: "/cards",
    icon: CreditCard,
    title: "결제 카드",
    description: "카드를 등록하면 문자 내역이 자동으로 연결돼요",
  },
  {
    href: "/devices",
    icon: Smartphone,
    title: "연결한 기기",
    description: "카드 문자를 보내는 휴대폰을 등록·관리해요",
  },
  {
    href: "/categories",
    icon: Tags,
    title: "카테고리 관리",
    description: "우리 가족만의 지출 카테고리를 만들고 정리해요",
  },
];

const OPERATIONS_ITEM: MoreItem = {
  href: "/ai-operations",
  icon: Activity,
  title: "AI 파이프라인 운영",
  description: "큐·지연·오류·토큰·학습 품질을 확인해요",
};

/**
 * 생체인식 잠금 토글 행(네이티브 전용 섹션).
 * 켜기는 본인 확인을 통과해야 하고, 끄기는 즉시 반영한다.
 */
function BiometricToggleRow() {
  // null = 로딩/미지원(행 숨김), 그 외 = 토글 상태.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!(await isBiometryAvailable())) return;
      setEnabled((await getBiometricPref()) === "on");
    })();
  }, []);

  if (enabled === null) return null;

  async function onToggle(next: boolean) {
    setBusy(true);
    try {
      if (next) {
        const gate = await authenticateBiometric(
          "생체인식 잠금을 켜려면 본인 확인이 필요해요",
        );
        if (gate !== "ok") {
          if (gate === "unsupported") {
            toast.error("이 기기에서는 생체인식을 사용할 수 없어요.");
          } else if (gate === "failed") {
            toast.error("본인 확인에 실패했어요.");
          }
          return;
        }
        await setBiometricPref("on");
        setEnabled(true);
        toast.success("생체인식 잠금을 켰어요.");
      } else {
        await setBiometricPref("off");
        setEnabled(false);
        toast.success("생체인식 잠금을 껐어요.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex items-center gap-3 px-4 py-4">
        <span className="bg-accent text-accent-foreground flex size-10 shrink-0 items-center justify-center rounded-full">
          <Fingerprint className="size-5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-medium">생체인식 잠금</span>
          <span className="text-muted-foreground text-[13px]">
            앱을 열 때 Face ID·지문으로 본인을 확인해요
          </span>
        </span>
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={(next) => void onToggle(next)}
          aria-label="생체인식 잠금"
        />
      </div>
    </Card>
  );
}

export default function MorePage() {
  const { activeMembership } = useHousehold();
  const canViewOperations =
    activeMembership?.role === "owner" || activeMembership?.role === "admin";
  const items = canViewOperations ? [...ITEMS, OPERATIONS_ITEM] : ITEMS;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">더보기</h1>
        <p className="text-muted-foreground text-sm">
          {activeMembership?.name ?? ""} · 가족과 기기를 관리해요.
        </p>
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        {items.map((item, i) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`hover:bg-muted flex items-center gap-3 px-4 py-4 transition-colors active:scale-[0.99] ${
                i > 0 ? "border-t" : ""
              }`}
            >
              <span className="bg-accent text-accent-foreground flex size-10 shrink-0 items-center justify-center rounded-full">
                <Icon className="size-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-medium">{item.title}</span>
                <span className="text-muted-foreground text-[13px]">
                  {item.description}
                </span>
              </span>
              <ChevronRight className="text-muted-foreground/50 size-4 shrink-0" />
            </Link>
          );
        })}
      </Card>

      <BiometricToggleRow />
    </div>
  );
}
