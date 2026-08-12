"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 관리 허브 (/more)
 *
 * 매일 오는 목적지(홈·거래·예산·할 일)와 AI는 하단 탭이 갖고, 여기는 **가끔 오는
 * 화면**을 모은다. 진입점은 헤더 아바타 1탭이다(IA 개편에서 '더보기' 탭이 여기로
 * 올라왔다 — 이유는 `(app)/layout.tsx` 상단 주석).
 *
 * **묶는 기준은 "언제 오는가"이지 기능 분류가 아니다.** 평평한 10줄 목록에서는
 * 사용자가 매번 처음부터 읽어야 했다. 세 묶음의 방문 이유가 서로 다르다:
 *  - 가계 설정 — 가족의 돈을 어떻게 기록할지. 처음에 몰아서 하고 가끔 손본다.
 *  - 수집     — 문자가 잘 들어오고 있는지. 뭔가 안 맞을 때 온다.
 *  - 내 계정   — 나 개인의 것(동의·알림·비밀번호·로그아웃). 드물게 온다.
 * 운영자 도구는 owner/admin에게만 보이고, 개발자 화면이라 일반 목록과 섞지 않는다.
 *
 * 앱 설정(생체인식 잠금) 행은 마운트 후 생체인식 가용성이 확인된 기기에서만
 * 나타난다 — 프리렌더 HTML과의 하이드레이션 불일치를 피하려고 렌더 시점
 * 분기 대신 effect 이후 상태로 가른다(웹/미지원 기기에서는 영구 숨김).
 * ------------------------------------------------------------------------- */
import {
  Activity,
  AlertTriangle,
  Bell,
  ChevronRight,
  CreditCard,
  Fingerprint,
  KeyRound,
  LogOut,
  Repeat,
  ShieldCheck,
  Smartphone,
  Store,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
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

interface MoreGroup {
  key: string;
  title: string;
  items: ReadonlyArray<MoreItem>;
}

const GROUPS: ReadonlyArray<MoreGroup> = [
  {
    key: "household",
    title: "가계 설정",
    items: [
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
        href: "/categories",
        icon: Tags,
        title: "카테고리 관리",
        description: "우리 가족만의 지출 카테고리를 만들고 정리해요",
      },
      {
        href: "/more/merchants",
        icon: Store,
        title: "가맹점 정리",
        description: "같은 가게가 여러 이름으로 나뉘어 있으면 하나로 묶어요",
      },
      {
        href: "/more/recurring",
        icon: Repeat,
        title: "정기 지출",
        description: "매달 빠져나가는 결제를 찾아 확인해요",
      },
    ],
  },
  {
    key: "collection",
    title: "수집",
    items: [
      {
        href: "/devices",
        icon: Smartphone,
        title: "연결한 기기",
        description: "카드 문자를 보내는 휴대폰을 등록·관리해요",
      },
      {
        // 처리는 '할 일' 탭이 갖는다 — 여기는 **해결된 것까지 남는 기록**이다.
        // 링크를 지우지 않는 이유: 지난 실패를 볼 수 있는 상시 경로가 여기뿐이다.
        href: "/declines",
        icon: AlertTriangle,
        title: "실패한 결제 기록",
        description: "해결된 것까지 모두 남아 있어요 · 처리는 할 일 탭에서 해요",
      },
    ],
  },
  {
    key: "account",
    title: "내 계정",
    items: [
      {
        href: "/more/privacy",
        icon: ShieldCheck,
        title: "개인정보",
        description: "무엇에 동의했고 무엇이 수집·보관되는지 확인해요",
      },
      {
        href: "/more/notifications",
        icon: Bell,
        title: "알림 설정",
        description: "푸시 알림·최소 금액·무음 시간대를 조절해요",
      },
      {
        href: "/more/password",
        icon: KeyRound,
        title: "비밀번호 변경",
        description: "바꾸면 모든 기기에서 다시 로그인해야 해요",
      },
    ],
  },
];

/** owner·admin에게만 보이는 개발자 화면. 일반 목록과 섞지 않는다. */
const OPERATIONS_GROUP: MoreGroup = {
  key: "operations",
  title: "운영자 도구",
  items: [
    {
      href: "/ai-operations",
      icon: Activity,
      title: "AI 파이프라인 운영",
      description: "큐·지연·오류·토큰·학습 품질을 확인해요",
    },
  ],
};

/** 목록 행 1개(원형 아이콘 + 제목/설명 + chevron). 높이 72px → 터치 타깃 충족. */
function MoreRow({ item, divided }: Readonly<{ item: MoreItem; divided: boolean }>) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`hover:bg-muted flex items-center gap-3 px-4 py-4 transition-colors active:scale-[0.99] ${
        divided ? "border-t" : ""
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
}

function MoreSection({
  group,
  children,
}: Readonly<{ group: MoreGroup; children?: ReactNode }>) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-muted-foreground px-1 text-[13px] font-semibold">
        {group.title}
      </h2>
      <Card className="gap-0 overflow-hidden p-0">
        {group.items.map((item, i) => (
          <MoreRow key={item.href} item={item} divided={i > 0} />
        ))}
        {children}
      </Card>
    </section>
  );
}

/**
 * 생체인식 잠금 토글 행(네이티브 전용).
 * 켜기는 본인 확인을 통과해야 하고, 끄기는 즉시 반영한다.
 * '내 계정' 묶음 안에 든다 — 이 기기의 내 잠금이지 가족 설정이 아니다.
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
    <div className="flex items-center gap-3 border-t px-4 py-4">
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
  );
}

/**
 * 로그아웃 — 예전에는 헤더 아바타 드롭다운에 있었다. 아바타가 `/more`로 가는 링크가
 * 되면서 이리로 내려왔고, 계정 묶음의 마지막 행이 자연스러운 자리다.
 */
function LogoutRow() {
  const router = useRouter();
  const { logout } = useAuth();
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
    <button
      type="button"
      disabled={busy}
      onClick={() => void onLogout()}
      className="hover:bg-muted flex w-full items-center gap-3 border-t px-4 py-4 text-left transition-colors active:scale-[0.99] disabled:opacity-60"
    >
      <span className="bg-destructive/10 text-destructive flex size-10 shrink-0 items-center justify-center rounded-full">
        <LogOut className="size-5" />
      </span>
      <span className="text-destructive text-[15px] font-medium">
        {busy ? "로그아웃하는 중…" : "로그아웃"}
      </span>
    </button>
  );
}

export default function MorePage() {
  const { activeMembership } = useHousehold();
  const { user } = useAuth();
  const canViewOperations =
    activeMembership?.role === "owner" || activeMembership?.role === "admin";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* 누구로 로그인해 있는지 — 예전에는 아바타 드롭다운에만 있던 정보다.
          아바타가 링크가 되면서 이 화면이 그 자리를 대신한다. */}
      <div>
        <h1 className="sr-only">내 계정과 관리</h1>
        <p className="text-[15px] font-semibold">{user?.name ?? "사용자"}</p>
        <p className="text-muted-foreground text-sm">
          {user?.email ?? ""}
          {activeMembership ? ` · ${activeMembership.name}` : ""}
        </p>
      </div>

      {GROUPS.map((group) =>
        group.key === "account" ? (
          <MoreSection key={group.key} group={group}>
            <BiometricToggleRow />
            <LogoutRow />
          </MoreSection>
        ) : (
          <MoreSection key={group.key} group={group} />
        ),
      )}

      {canViewOperations ? <MoreSection group={OPERATIONS_GROUP} /> : null}
    </div>
  );
}
