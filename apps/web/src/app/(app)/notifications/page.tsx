"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 알림함 (/notifications, 토스 스타일 알림 센터)
 *
 * 최근 30일 알림을 최신순으로 모아 본다. 진입하면 전체가 자동 읽음 처리되고(헤더 벨
 * 뱃지 0), 화면은 진입 당시 스냅샷 기준으로 "새 알림"(그때 안읽음)/"지난 알림"(읽음)을
 * 나눠 보여준다. 항목 탭 → 해당 화면으로 딥링크 이동. 커서 무한스크롤.
 * ------------------------------------------------------------------------- */
import {
  ChartColumn,
  CircleAlert,
  CircleCheck,
  CreditCard,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/widgets";
import { formatRelativeTime } from "@/lib/format";
import {
  useMarkAllNotificationsRead,
  useNotifications,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { NotificationItem, NotificationKind } from "@family/contracts";

/** 알림 유형별 아이콘 + 원형 배경색. */
const KIND_META: Record<NotificationKind, { icon: LucideIcon; className: string }> = {
  transaction: { icon: CreditCard, className: "bg-primary/15 text-primary" },
  budget: { icon: CircleAlert, className: "bg-warning/15 text-warning" },
  reminder: { icon: CircleCheck, className: "bg-accent text-accent-foreground" },
  summary: { icon: ChartColumn, className: "bg-primary/15 text-primary" },
};

export default function NotificationsPage() {
  const router = useRouter();
  const query = useNotifications();
  const markAll = useMarkAllNotificationsRead();

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const unreadItems = items.filter((i) => !i.readAt);
  const readItems = items.filter((i) => i.readAt);

  // 진입 시 1회 전체 읽음(안읽음이 있을 때만). markAll은 목록 캐시를 건드리지 않아
  // 위 unreadItems 스냅샷은 화면에 그대로 유지되고, 헤더 벨 뱃지만 0이 된다.
  const markedRef = useRef(false);
  const loaded = !query.isLoading && !query.isError;
  const hasUnread = unreadItems.length > 0;
  useEffect(() => {
    if (loaded && hasUnread && !markedRef.current) {
      markedRef.current = true;
      markAll.mutate();
    }
  }, [loaded, hasUnread, markAll]);

  function renderRow(item: NotificationItem, isUnread: boolean) {
    const meta = KIND_META[item.kind];
    const Icon = meta.icon;
    return (
      <ListRow
        key={item.id}
        icon={<Icon />}
        iconClassName={meta.className}
        title={
          <span className={cn(isUnread && "font-semibold")}>{item.title}</span>
        }
        subtitle={item.body}
        value={
          <span className="text-muted-foreground text-[13px] font-normal">
            {formatRelativeTime(item.createdAt)}
          </span>
        }
        onClick={() => {
          if (item.deepLink) router.push(item.deepLink);
        }}
        className={cn(isUnread && "bg-primary/5")}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">알림</h1>

      {query.isLoading ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-muted/50 h-16 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : query.isError ? (
        <p className="text-destructive py-10 text-center text-sm">
          알림을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
        </p>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center">
          <span className="text-4xl">🔔</span>
          <p className="text-sm">최근 30일간 도착한 알림이 없어요</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {unreadItems.length > 0 ? (
            <section className="flex flex-col gap-1">
              <h2 className="text-muted-foreground px-2 text-[13px] font-medium">
                새 알림
              </h2>
              {unreadItems.map((item) => renderRow(item, true))}
            </section>
          ) : null}

          {readItems.length > 0 ? (
            <section className="flex flex-col gap-1">
              <h2 className="text-muted-foreground px-2 text-[13px] font-medium">
                지난 알림
              </h2>
              {readItems.map((item) => renderRow(item, false))}
            </section>
          ) : null}

          {query.hasNextPage ? (
            <Button
              variant="tint"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? "불러오는 중…" : "더 보기"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
