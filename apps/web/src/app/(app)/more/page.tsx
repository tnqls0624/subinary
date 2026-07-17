"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 더보기 (/more)
 *
 * 데일리 목적지(홈/거래/예산)와 AI는 하단 탭에 두고, 저빈도 관리 화면(가족·장치)은
 * 여기로 모은다. 각 항목은 원형 아이콘 + 제목/설명 + chevron 리스트 행으로,
 * 오늘의집 설정 허브 톤을 따른다.
 * ------------------------------------------------------------------------- */
import {
  ChevronRight,
  CreditCard,
  Smartphone,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
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
];

export default function MorePage() {
  const { activeMembership } = useHousehold();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">더보기</h1>
        <p className="text-muted-foreground text-sm">
          {activeMembership?.name ?? ""} · 가족과 기기를 관리해요.
        </p>
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        {ITEMS.map((item, i) => {
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
    </div>
  );
}
