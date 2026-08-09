"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 할 일 (/todo)  [C-8]
 *
 * 매일 생기는 **처리 작업** 3종을 한 화면에 모은다:
 *  1) 결제 실패(미해결) — `declined`는 거래로 승격되지 않아 어떤 집계에도 안 잡힌다
 *  2) 확인이 필요한 거래 — 확인필요 · 중복의심
 *  3) 읽지 못한 문자 — 파싱 실패 · LLM 격리
 *
 * **왜 이 화면이 따로 필요한가**: 홈은 '확인이 필요한 문자'를 최근 3일만 보여준다.
 * 홈을 깔끔하게 유지하려는 결정이었지만, 그 결과 처리되지 않은 문자가 3일 뒤 조용히
 * 사라졌다(드리프트 D-7). 문자 한 통이 거래 한 건이고, 사라지면 지출 합계가 영구히
 * 틀린다. 그래서 이 화면은 **기간 제한 없이** 전 기간 백로그를 보여준다.
 *
 * 새 백엔드는 없다 — 세 소스 모두 홈이 이미 호출하던 쿼리이고, `useTodoCounts()`가
 * 같은 queryKey를 공유하므로 홈↔여기를 오가도 요청이 늘지 않는다.
 *
 * **진입점**: 하단 탭 '할 일'(IA 개편에서 '더보기' 자리를 받았다 — 이유는
 * `(app)/layout.tsx` 상단 주석)과 홈 '할 일' 카드, 둘 다다. 탭 배지는 이 화면과
 * 같은 `useTodoCounts().total`을 쓴다 — 배지와 목록이 다른 수를 세면 안 된다.
 *
 * '처리 완료 이력' 섹션은 로드맵 와이어프레임에 있지만 **소스가 없다** — 확정한
 * 문자·거래에 "누가 언제 처리했는지"를 남기는 테이블이 없다(결제 실패만 해결/확인
 * 여부를 갖고 있어 `/declines`가 그 역할을 한다). 없는 이력을 지어내지 않는다.
 * ------------------------------------------------------------------------- */
import { AlertTriangle, CheckCircle2, CircleAlert, MailWarning } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import type { CardSmsEventSummary, TransactionSummary } from "@family/contracts";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ListRow,
  Money,
  ReviewInboxDialog,
  StatusBadge,
  declineReasonHint,
  pendingCountText,
  useTodoCounts,
} from "@/components/widgets";
import { transactionDetailHref } from "@/lib/deep-link";
import { formatDate, formatMoney, formatRelativeTime, formatWon } from "@/lib/format";

export default function TodoPage() {
  // 폴링하지 않는다 — 여기는 "보는" 화면이 아니라 "처리하는" 화면이고, 확정·제외
  // 뮤테이션이 캐시를 무효화하므로 목록은 처리 직후 스스로 갱신된다. 포커스 리페치가
  // 백그라운드에서 온 새 문자를 마저 채운다.
  const todo = useTodoCounts();
  // 문자는 요약에 원문이 없어 상세를 따로 받아야 한다 → 고른 **한 건만** 넘긴다.
  const [selectedSms, setSelectedSms] = useState<CardSmsEventSummary | null>(
    null,
  );

  const loading =
    todo.declinesLoading || todo.reviewsLoading || todo.smsLoading;
  const anyError = todo.declinesError || todo.reviewsError || todo.smsError;
  // 빈 상태는 **다 읽어낸 뒤에만** 보여준다. 못 읽은 것을 "할 일 없음"으로 쓰면
  // 사용자는 처리할 게 없다고 믿는다.
  const showEmpty = !loading && !anyError && todo.total === 0;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      {/* 탭 루트가 된 뒤로 뒤로가기 화살표를 뗐다 — 하단 탭으로 직접 오는 화면에
          "뒤로"는 갈 곳이 없고, 홈으로 되돌리는 화살표는 탭을 되돌리는 것처럼 읽힌다.
          제목은 탭 라벨('할 일')과 중복이라 스크린리더용으로만 남긴다. */}
      <div>
        <h1 className="sr-only">할 일</h1>
        <p className="text-muted-foreground text-sm">
          확인이 필요한 것들을 기간 제한 없이 모아뒀어요
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
      ) : null}

      {showEmpty ? (
        <Card className="p-8 text-center">
          <CheckCircle2 className="text-muted-foreground mx-auto mb-3 size-8" />
          <p className="text-sm font-medium">지금은 처리할 게 없어요</p>
          <p className="text-muted-foreground mt-1 text-sm">
            확인이 필요한 거래·문자나 실패한 결제가 생기면 여기에 모아드려요
          </p>
        </Card>
      ) : null}

      {/* 1) 결제 실패 — 가장 위에 둔다. 셋 중 유일하게 **돈이 나가지 않은** 사고라
          방치하면 서비스가 끊긴다(정기결제 수단 미갱신 → 멤버십 종료). */}
      <Section
        show={todo.declinesError || todo.declines.length > 0}
        title="결제가 계속 실패하고 있어요"
        countText={pendingCountText(
          todo.declinesLoading,
          todo.declinesError,
          todo.declines.length,
          false,
        )}
        error={todo.declinesError}
        errorText="실패한 결제를 불러오지 못했어요"
        footer={
          <FooterLink href="/declines">
            해결됐거나 확인한 실패도 보기
          </FooterLink>
        }
      >
        {todo.declines.map((d) => {
          const hint = declineReasonHint(d.reason);
          return (
            <ListRow
              // 묶음은 조회 시점 집계라 id가 없다 — (가맹점, 금액)이 묶음의 키다.
              key={`${d.merchant}-${d.amount}`}
              href="/declines"
              icon={<AlertTriangle />}
              iconClassName="bg-destructive/10 text-destructive"
              title={d.merchant ?? "확인 안 된 가맹점"}
              subtitle={`${
                d.amount === null ? "금액 미확인" : formatWon(d.amount)
              } · ${d.attempts}번 거절${hint ? ` · ${hint}` : ""}`}
              value={
                <span className="text-destructive text-[13px] font-medium">
                  {formatRelativeTime(d.lastAttemptAt)}
                </span>
              }
              chevron
            />
          );
        })}
      </Section>

      {/* 2) 확인이 필요한 거래 — 탭하면 그 건의 상세가 바로 열린다(목록으로 보내면
          사용자가 방금 누른 건을 다시 찾아야 한다). */}
      <Section
        show={todo.reviewsError || todo.reviews.length > 0}
        title="확인이 필요한 거래"
        countText={pendingCountText(
          todo.reviewsLoading,
          todo.reviewsError,
          todo.reviews.length,
          todo.reviewsTruncated,
        )}
        error={todo.reviewsError}
        errorText="거래를 불러오지 못했어요"
        footer={
          todo.reviewsTruncated ? (
            <FooterLink href="/transactions?status=pending_review">
              거래 화면에서 이어서 보기
            </FooterLink>
          ) : null
        }
      >
        {todo.reviews.map((t) => (
          <ListRow
            key={t.id}
            href={transactionDetailHref(t.id)}
            icon={<CircleAlert />}
            iconClassName="bg-warning/15 text-warning"
            title={merchantLabel(t)}
            subtitle={formatDate(t.approvedAt)}
            value={<Money amount={t.netAmount} currency={t.currency} />}
            valueSub={<StatusBadge status={t.status} />}
            chevron
          />
        ))}
      </Section>

      {/* 3) 읽지 못한 문자 — **전 기간**. 홈의 3일 창이 여기서는 적용되지 않는다. */}
      <Section
        show={todo.smsError || todo.sms.length > 0}
        title="읽지 못한 문자"
        description="탭하면 원문을 보고 바로 확정할 수 있어요"
        countText={pendingCountText(
          todo.smsLoading,
          todo.smsError,
          todo.sms.length,
          todo.smsTruncated,
        )}
        error={todo.smsError}
        errorText="문자를 불러오지 못했어요"
        footer={
          todo.smsTruncated ? (
            <p className="text-muted-foreground px-4 py-3 text-xs">
              한 번에 {todo.sms.length}건까지 보여드려요. 처리하면 그다음 문자가
              이어서 나타나요.
            </p>
          ) : null
        }
      >
        {todo.sms.map((e) => (
          <ListRow
            key={e.id}
            onClick={() => setSelectedSms(e)}
            icon={<MailWarning />}
            iconClassName="bg-warning/15 text-warning"
            title={e.sender}
            subtitle={smsSubtitle(e)}
            value={
              <span className="text-muted-foreground text-[13px]">
                {formatRelativeTime(e.receivedAt)}
              </span>
            }
            chevron
          />
        ))}
      </Section>

      <ReviewInboxDialog
        open={selectedSms != null}
        events={selectedSms ? [selectedSms] : []}
        onClose={() => setSelectedSms(null)}
        // 확정하면 그 문자는 목록에서 빠진다 — 열려 있는 폼이 이미 처리한 건을
        // 계속 보여주지 않도록 닫는다.
        onReviewed={() => setSelectedSms(null)}
      />
    </div>
  );
}

/** 섹션 1개(제목 + 건수 + 행 목록). `show`가 false면 아무것도 렌더하지 않는다. */
function Section({
  show,
  title,
  description,
  countText,
  error,
  errorText,
  footer,
  children,
}: Readonly<{
  show: boolean;
  title: string;
  description?: string;
  countText: string;
  error: boolean;
  errorText: string;
  footer?: ReactNode;
  children: ReactNode;
}>) {
  if (!show) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <span className="text-muted-foreground text-[13px] tabular-nums">
          {countText}
        </span>
      </div>
      {description ? (
        <p className="text-muted-foreground px-1 text-[13px]">{description}</p>
      ) : null}
      <Card className="divide-border divide-y overflow-hidden p-0">
        {error ? (
          <p className="text-muted-foreground px-4 py-6 text-center text-sm">
            {errorText}
          </p>
        ) : (
          <div className="flex flex-col px-2 py-1">{children}</div>
        )}
        {footer}
      </Card>
    </section>
  );
}

/** 섹션 하단의 보조 링크(전체 보기 등). */
function FooterLink({
  href,
  children,
}: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <Link
      href={href}
      className="text-accent-foreground hover:bg-muted/70 block px-4 py-3 text-[13px] font-medium transition-colors"
    >
      {children} ›
    </Link>
  );
}

/** 마스킹/미확인을 고려한 가맹점 표시명(거래 목록과 동일 규칙). */
function merchantLabel(t: TransactionSummary): string {
  if (t.masked) return "(비공개)";
  return t.merchantNormalized ?? t.merchantRaw ?? "미확인 가맹점";
}

/**
 * 문자 한 줄 부제.
 * `quarantined`는 LLM이 값을 이미 뽑아 둔 상태라 **확인만** 하면 되고,
 * `parse_failed`는 값이 비어 있어 사용자가 직접 채워야 한다 — 그 차이를 알려 준다.
 */
function smsSubtitle(e: CardSmsEventSummary): string {
  if (e.parseStatus === "quarantined") {
    const amount =
      e.amount === null ? null : formatMoney(e.amount, e.currency ?? "KRW");
    const merchant = e.merchantRaw ?? "가맹점 미상";
    return `${merchant}${amount ? ` ${amount}` : ""} · 확인만 하면 돼요`;
  }
  return "자동으로 읽지 못했어요 · 원문을 보고 확정해 주세요";
}
