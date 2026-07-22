import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 하위 페이지 공통 헤더 — 좌측 뒤로가기(←) + 제목(+선택 부제/우측 액션).
 * 더보기(/more) 하위 페이지들이 일관된 뒤로가기 버튼을 갖도록 한 곳으로 모은다.
 * `backHref` 기본은 `/more`(대부분 더보기에서 진입).
 */
export function PageBackHeader({
  title,
  subtitle,
  action,
  backHref = "/more",
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  backHref?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Link
        href={backHref}
        className="hover:bg-muted -ml-2 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors"
        aria-label="뒤로"
      >
        <ArrowLeft className="size-5" />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
