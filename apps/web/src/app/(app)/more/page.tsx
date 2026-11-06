"use client";
/**
 * 전체 탭(ADR-0037): 가계부 · 가족·연결 · 알림·화면 · 계정(docs/ux-renewal-2026-11.md §5 설정).
 *
 * 다른 탭에 이미 있는 행은 두지 않는다 — 결제 카드는 자산 탭, 정기 지출은 가계부에 있다.
 * 운영자 화면(`/ai-operations`)은 메뉴에서 뺐다: 서버가 운영자 허용 목록으로만 열어 주므로
 * 메뉴에 두면 거의 모든 사람에게 "접근할 수 없어요"로 끝나는 행이 된다(주소로는 그대로 열린다).
 * 메뉴 이름은 누른 뒤 뜨는 화면 제목과 같다('가족' → 가족 화면).
 */
import {
  Bell,
  CalendarDays,
  ChevronRight,
  Fingerprint,
  KeyRound,
  Link2,
  LogOut,
  ShieldCheck,
  Smartphone,
  Store,
  Sparkles,
  Tags,
  Users,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ThemeSettingRow } from "@/components/theme-toggle";
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
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import {
  authenticateBiometric,
  getBiometricPref,
  isBiometryAvailable,
  setBiometricPref,
} from "@/lib/biometric";
import { useMerchantLabelCandidates } from "@/lib/queries";

import { ruleReviewLeftText } from "./menu-counts";

interface MoreItem {
  href: string;
  icon: LucideIcon;
  title: string;
}

interface MoreGroup {
  key: string;
  title: string;
  items: ReadonlyArray<MoreItem>;
}

/**
 * 전체 탭(ADR-0037). 행은 아이콘 · 제목 · 화살표 한 줄이다 — 설명 문구를 붙이지 않는다
 * (docs/ux-renewal-2026-11.md §5 설정). 할 일·실패한 결제는 가계부 '할 일'에 있으므로 여기서 뺐다.
 * 화면 모드·생체인식·로그아웃처럼 링크가 아닌 행은 아래 `MorePage`가 그룹 끝에 붙인다.
 */
const GROUPS: ReadonlyArray<MoreGroup> = [
  {
    key: "ledger",
    title: "가계부",
    items: [
      { href: "/ledger/weekly-review", icon: CalendarDays, title: "주간 가계 돌아보기" },
      { href: "/ai", icon: Sparkles, title: "AI 도우미" },
      { href: "/categories", icon: Tags, title: "카테고리" },
      { href: "/more/category-rules", icon: Wand2, title: "자동 분류 규칙" },
      { href: "/more/merchants", icon: Store, title: "가맹점 정리" },
    ],
  },
  {
    key: "household",
    title: "가족 · 연결",
    items: [
      { href: "/household", icon: Users, title: "가족" },
      { href: "/devices", icon: Smartphone, title: "문자 연동" },
      { href: "/more/connections", icon: Link2, title: "은행·증권 연결" },
    ],
  },
  {
    key: "display",
    title: "알림 · 화면",
    items: [{ href: "/more/notifications", icon: Bell, title: "알림 설정" }],
  },
  {
    key: "account",
    title: "계정",
    items: [
      { href: "/more/privacy", icon: ShieldCheck, title: "개인정보" },
      { href: "/more/password", icon: KeyRound, title: "비밀번호 변경" },
    ],
  },
];

const ROW_CLASS =
  "hover:bg-muted/60 active:bg-muted focus-visible:ring-ring flex min-h-14 w-full items-center gap-4 px-5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset";

/**
 * 아이콘(배경 없음) · 제목 · (남은 일 수) · 화살표.
 * ›는 눌리는 줄 표시라 바탕 대비 3:1 이상(/70)으로 둔다 — 목록 줄(`ListRow`)의 ›와 같다.
 */
function MoreRow({ item, value }: Readonly<{ item: MoreItem; value?: string | null }>) {
  const Icon = item.icon;
  return (
    <Link href={item.href} className={ROW_CLASS}>
      <Icon className="text-muted-foreground size-6 shrink-0" strokeWidth={1.7} aria-hidden="true" />
      <span className="text-body min-w-0 flex-1">{item.title}</span>
      {value ? <span className="text-body text-muted-foreground shrink-0 tabular-nums">{value}</span> : null}
      <ChevronRight className="text-muted-foreground/70 size-5 shrink-0" aria-hidden="true" />
    </Link>
  );
}

function MoreSection({
  group,
  values,
  children,
}: Readonly<{ group: MoreGroup; values?: Readonly<Record<string, string | null>>; children?: ReactNode }>) {
  return (
    // 제목을 섹션 안에 둔다 — 밖에 두면 회색 띠가 제목과 목록 사이를 가른다(§8).
    <section className="finance-panel min-w-0 overflow-hidden pt-4 pb-1">
      <h2 className="text-caption text-muted-foreground px-5 pb-1 font-semibold">{group.title}</h2>
      {group.items.map((item) => (
        <MoreRow key={item.href} item={item} value={values?.[item.href]} />
      ))}
      {children}
    </section>
  );
}

/**
 * 생체인식 잠금 토글 행(네이티브 전용).
 * 켜기는 본인 확인을 통과해야 하고, 끄기는 즉시 반영한다.
 * '계정' 묶음 안에 든다 — 이 기기의 내 잠금이지 가족 설정이 아니다.
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
          "생체인식 잠금을 켜려면 본인 확인이 필요해요"
        );
        if (gate !== "ok") {
          if (gate === "unsupported") {
            toast.error("이 기기에서는 생체인식을 사용할 수 없어요.");
          } else if (gate === "failed") {
            toast.error("본인 확인에 실패했어요.");
          } else if (gate === "interrupted") {
            // 사용자가 취소한 게 아니라 화면이 프롬프트를 거둔 것이다. 아무 말도
            // 없이 토글이 되돌아가면 "눌러도 안 되는 버튼"으로 읽힌다.
            toast.error("본인 확인 창이 닫혔어요. 다시 눌러 주세요.");
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
    <div className="flex min-h-14 items-center gap-4 px-5 py-3">
      <Fingerprint className="text-muted-foreground size-6 shrink-0" strokeWidth={1.7} aria-hidden="true" />
      <span className="text-body min-w-0 flex-1">생체인식 잠금</span>
      <span className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
        <Switch
          className="relative before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']"
          checked={enabled}
          disabled={busy}
          onCheckedChange={(next) => void onToggle(next)}
          aria-label="생체인식 잠금"
        />
      </span>
    </div>
  );
}

/**
 * 로그아웃 — 예전에는 헤더 아바타 드롭다운에 있었다. 아바타가 `/more`로 가는 링크가
 * 되면서 이리로 내려왔고, 계정 묶음의 마지막 행이 자연스러운 자리다.
 *
 * 한 번 더 묻는다: 로그인은 1년 동안 유지되므로, 잘못 누르면 이메일·비밀번호를 다시
 * 찾아 입력해야 한다(목록 끝 행이라 스크롤하다 누르기 쉽다).
 */
function LogoutRow() {
  const router = useRouter();
  const { logout } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onLogout() {
    setBusy(true);
    try {
      await logout();
    } finally {
      // 보안 저장소 삭제 오류가 나도 메모리 세션은 이미 닫혔으므로 로그인 화면으로 이동한다.
      router.replace("/login");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={ROW_CLASS}
      >
        {/* 위험 색 글자 — 회색이면 눌리지 않는 줄처럼 보였다(2026-11 HIG 검수). */}
        <LogOut className="text-destructive size-6 shrink-0" strokeWidth={1.7} aria-hidden="true" />
        <span className="text-body text-destructive">로그아웃</span>
      </button>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!busy) setConfirming(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>로그아웃할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              다시 들어오려면 이메일과 비밀번호를 입력해야 해요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* 다른 확인 시트와 같은 모양: 위험 색 확인 버튼 + '닫기'. */}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>닫기</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                // 시트가 먼저 닫히면 진행 표시를 보여 줄 자리가 없다.
                event.preventDefault();
                void onLogout();
              }}
            >
              {busy ? "로그아웃하는 중…" : "로그아웃"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function MorePage() {
  const { user } = useAuth();
  // 가맹점 분류 검토는 할 일 숫자에 넣지 않고(미뤄도 되는 정리라 급한 일이 묻힌다, 2026-11-06) 이 줄에
  // 회색으로 남은 수만 둔다. 규칙 화면과 같은 훅·캐시 키라 요청이 늘지 않고, 실패하면 그 화면처럼 숨긴다.
  // '가맹점 정리'는 숫자를 두지 않는다 — 같은 가게 묶음 수는 가맹점 전체 목록을 받아 걸러 세야 한다.
  const ruleCandidates = useMerchantLabelCandidates();
  const ruleReviewLeft = ruleReviewLeftText(
    ruleCandidates.isError ? undefined : ruleCandidates.data
  );

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-1 px-1">
        <h1 className="text-title">전체</h1>
        {/* 누구로 로그인해 있는지 — 계정 확인은 한 줄이면 충분하다. */}
        <p className="text-caption text-muted-foreground truncate">
          {user?.name ?? "사용자"} · {user?.email ?? ""}
        </p>
      </header>

      {GROUPS.map((group) => (
        <MoreSection
          key={group.key}
          group={group}
          values={group.key === "ledger" ? { "/more/category-rules": ruleReviewLeft } : undefined}
        >
          {group.key === "display" ? <ThemeSettingRow /> : null}
          {group.key === "account" ? (
            <>
              <BiometricToggleRow />
              <LogoutRow />
            </>
          ) : null}
        </MoreSection>
      ))}
    </div>
  );
}
