"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 거래 내역 페이지
 *
 * 기간(달 이동)·검색 + 조건 칩 한 줄(transaction-filters.tsx) + 무한 스크롤(useInfiniteQuery).
 * '확인할 거래' 칩은 켜면 전체 기간으로 바꾸고 끄면 켜기 전 달로 돌아간다(review-period.ts).
 * 목록은 날짜별 그룹("7월 17일" 헤더 + 원화 승인 소계) + ListRow(카테고리 아이콘 · 가맹점 ·
 * 카드/구성원/카테고리 · 금액 · 상태 칩). 행 클릭 → 상세 바텀 시트에서
 * 카테고리 변경(applyRule)/공개 범위/메모/정상·중복 표시/취소연결을 처리한다.
 * 줄을 누르려 하면 상세가 쓸 하위 데이터를 미리 받고(스크롤 터치는 거른다, press-prefetch.ts), 열 때 아직이면
 * 잠깐만 기다린다(detail-prefetch.ts).
 * 상세 줄에서 고른 값은 그 자리에서 저장되고, 진행 표시·오류도 그 줄에만 보인다(detail-save.ts).
 * 상태 이름은 목록과 상세가 같다 — 취소됨·부분 취소·환불·합계 제외·확인 필요·중복 의심(list-status.ts).
 *
 * - 모든 계산/집계는 서버(SQL)에서 끝났다고 가정 — 여기선 표시/편집만 담당한다.
 * - 타인 summary_only(masked) 항목은 가맹점을 '(비공개)'로 표기하고 편집을 막는다.
 * - 권한은 서버(서비스 계층)가 강제하며, 실패하면 상세에서는 그 줄·동작 아래에, 상세를 닫은 뒤면 목록 위에 알린다.
 * ------------------------------------------------------------------------- */
import {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  notifyManager,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CardSummary,
  CardVisibility,
  MemberColor,
  TransactionSummary,
  TransactionUpdateRequest,
} from "@family/contracts";
import { DEFAULT_TIMEZONE } from "@family/shared";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Receipt,
  Search,
  SearchX,
  X,
} from "lucide-react";

import { ReviewRequestAction } from "@/components/review-request-action";
import { AmountInput } from "@/components/ui/amount-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { PickerMenu } from "@/components/ui/picker-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EmptyState,
  ErrorState,
  Fab,
  InlineNotice,
  ListLoading,
  ListRow,
  Money,
  StatusChip,
} from "@/components/widgets";
import {
  OverflowMenu,
  type OverflowAction,
} from "@/components/widgets/overflow-menu";
import { toast } from "sonner";
import {
  merchantLabel,
  merchantSearchTerm,
  transactionOccurredAt as occurredAt,
} from "@/lib/transaction-display";
import { FieldList, FieldRow } from "./detail-fields";
import { MerchantHistory } from "./merchant-history";
import { useDuplicatePair } from "./duplicate-pair";
import { LedgerHeader } from "@/components/ledger-header";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { categoryIcon } from "@/lib/category-icon";
import { cardIdentityLabel } from "@/lib/card-identity-label";
import {
  formatMoney,
  formatMonth,
  formatMonthDay,
  formatMonthDayTime,
  currentMonth,
} from "@/lib/format";
import { monthRange, recentMonths } from "@/lib/month";
import { memberColorClass, sharedColorClass } from "@/lib/member-color";
import {
  attributedMemberId,
  attributedMemberName,
  sharedCardIdSet,
} from "@/lib/transaction-attribution";
import { useHousehold } from "@/lib/household-context";
import {
  invalidateTransactionScope,
  queryKeys,
  useAnalyticsMonths,
  useCardList,
  useCategoryList,
  useCreateCategory,
  useHouseholdMembers,
  useHouseholdSummary,
  useInfiniteTransactions,
  useTransactions,
} from "@/lib/queries";
import {
  detailFallbackCopy,
  detailFallbackReason,
} from "@/lib/transaction-detail-fallback";
import { cn } from "@/lib/utils";
import {
  createTransactionEditSession,
  validateTransactionEdit,
  type TransactionEditErrors,
  type TransactionEditPatch,
} from "@/lib/transaction-edit";
import {
  cancelTransactionReads,
  transactionDetailKey,
  writeTransactionResult,
} from "@/lib/transaction-detail-cache";
import {
  registerTransactionDetailBack,
  type TransactionDetailBackSource,
} from "@/lib/transaction-detail-back";
import { AddTransactionDialog } from "./add-transaction-dialog";
import {
  TransactionFxDetails,
  foreignAmountLabel,
} from "@/components/transaction-fx-details";
import { TransactionFilters } from "./transaction-filters";
import {
  hasTransactionConditions,
  type ActiveTransactionFilter,
  type TransactionFilterKey,
} from "./filter-summary";
import {
  initialTransactionMonth,
  transactionReviewPeriodQuery,
} from "@/lib/transaction-review-filter";
import { matchesCandidateSearch, retainSelection } from "./candidate-search";
import {
  decisionOffersExclude,
  reviewDecision,
  type ReviewDecisionAction,
} from "./decision-copy";
import {
  amountInputToMinor,
  clearDetailErrors,
  detailSavesFor,
  minorToAmountInput,
  savedToast,
  settleDetailSave,
  startDetailSave,
  type DetailField,
  type DetailSaves,
  type DetailSaveView,
} from "./detail-save";
import {
  countsInDayTotal,
  dayTotalNote,
  transactionChips,
  type TransactionChip,
} from "./list-status";
import {
  initialRestoreMonth,
  leaveReviewPeriod,
  pickReviewMonth,
  toggleReviewPeriod,
  type ReviewPeriodState,
} from "./review-period";
import {
  transactionsEmptyCopy,
  type TransactionsEmptyAction,
} from "./empty-state-copy";
import { DEVICE_TIME_ZONE_NOTE, deviceMatchesSeoulTime } from "./device-time";
import {
  createDetailOpenGate,
  prefetchTransactionDetail,
  resolveDetailFallback,
  seedTransactionDetail,
  type DetailPrefetchContext,
} from "./detail-prefetch";
import {
  pressPrefetchHandlers,
  usePressPrefetch,
  type PressPrefetch,
} from "./press-prefetch";

/* -------------------------------------------------------------------------- */
/* Local types                                                                */
/* -------------------------------------------------------------------------- */

/** select 옵션(값/라벨). */
type Option = { value: string; label: string };

/** 날짜별 그룹(헤더 라벨 + 해당 날짜 거래 + 원화 승인 소계). */
type DayGroup = {
  key: string;
  label: string;
  total: number;
  /** 소계에 더한 줄 수. 0이면 소계를 그리지 않는다 — 환불·외화만 있는 날에 '0원'이 뜨지 않게. */
  counted: number;
  items: TransactionSummary[];
};

/* -------------------------------------------------------------------------- */
/* Constants / labels                                                         */
/* -------------------------------------------------------------------------- */

const PAGE_SIZE = 20;

/** 검색 입력 → 쿼리 반영 지연(ms). 타이핑마다 요청하면 한 단어에 대여섯 번 나간다. */
const SEARCH_DEBOUNCE_MS = 300;

/** 검색어 최대 길이(서버 절삭 기준과 동일). */
const SEARCH_MAX_LENGTH = 100;

/** 상세에서 카드 연결을 해제('카드 미연결')하기 위한 메뉴 값(빈 값 금지). */
const CARD_NONE = "__none__";

/** 공개범위 라벨 — 카드 화면(cards/card-fields.tsx)과 같은 이름이다(같은 개념은 같은 말). */
const VISIBILITY_LABELS: Readonly<Record<CardVisibility, string>> = {
  private: "나만 보기",
  household: "가족 공개",
  summary_only: "금액만 공개",
};

/**
 * 유형 필터 옵션. 칩은 '취소·환불' 하나로 고르고(filter-summary.ts), 이 이름은 URL로 들어온 값을
 * 칩에 보일 때 쓴다 — 취소로 생긴 기록은 '환불 기록'(앱 전체 이름 규칙).
 */
const TYPE_OPTIONS: ReadonlyArray<Option> = [
  { value: "approval", label: "결제" },
  { value: "cancellation", label: "환불 기록" },
];

/** 상태 필터 옵션(DB txnStatus 5종). 원래 결제는 '취소된 결제'·'부분 취소된 결제'. */
const STATUS_OPTIONS: ReadonlyArray<Option> = [
  { value: "approved", label: "승인" },
  { value: "partially_cancelled", label: "부분 취소된 결제" },
  { value: "cancelled", label: "취소된 결제" },
  { value: "pending_review", label: "확인 필요" },
  { value: "duplicate_suspected", label: "중복 의심" },
];

/** 공개범위 편집 옵션. */
const VISIBILITY_OPTIONS: ReadonlyArray<Option> = (
  ["private", "household", "summary_only"] as const
).map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }));

/* -------------------------------------------------------------------------- */
/* Row mutation dispatch                                                      */
/* -------------------------------------------------------------------------- */

/** 행 단위 뮤테이션 액션(단일 useMutation으로 분기 처리). */
type RowAction =
  | { kind: "update"; id: string; body: TransactionUpdateRequest }
  | { kind: "markDuplicate"; id: string }
  | { kind: "markValid"; id: string }
  | { kind: "exclude"; id: string }
  | { kind: "include"; id: string }
  | { kind: "linkCancellation"; id: string; approvalTransactionId: string }
  // 카드가 애매한 '확인 필요' 결제에서 카드를 고르면 연결과 확인을 한 번에 한다.
  | { kind: "resolveCard"; id: string; cardId: string };

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

// monthRange/recentMonths는 `@/lib/month`로 승격했다(홈·예산 월 스위처가 같은 규칙을
// 써야 하므로 — ADR-0026). 동작은 동일하다.

/** ApiError면 서버 메시지를, 아니면 일반 메시지를 반환한다. */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "작업에 실패했어요. 잠시 후 다시 시도해 주세요.";
}

/** 상태 칩 줄 — 이름·색은 list-status.ts가 정한다(목록과 상세가 같은 말). */
function TxnChips({ chips }: { chips: readonly TransactionChip[] }) {
  return (
    <>
      {chips.map((chip) => (
        <StatusChip key={chip.label} tone={chip.tone}>
          {chip.label}
        </StatusChip>
      ))}
    </>
  );
}

/**
 * 거래 목록 한 줄. memo — 상세를 열고 닫거나(detailId·openingId) 저장 상태가 바뀌어 페이지가 다시 그려져도
 * 바뀌지 않은 줄은 건너뛴다. 100줄을 다시 그리면 맥(node)에서 약 5ms, 폰에서는 그 몇 배라 시트가 올라오는 첫 프레임을
 * 늦췄다(2026-11-06 측정). 넘기는 값은 글자·불리언과 페이지가 고정해 둔 함수뿐이다.
 */
const TransactionRow = memo(function TransactionRow({
  txn,
  categoryName,
  iconClassName,
  subtitle,
  pressed,
  busy,
  press,
  onPrefetch,
  onOpen,
}: Readonly<{
  txn: TransactionSummary;
  categoryName: string | null;
  /** 아이콘 원의 색(구성원·공용 색, 비공개·합계 제외는 회색). */
  iconClassName: string;
  subtitle: string;
  /** 상세를 열려고 하위 데이터를 기다리는 중 — 손을 뗀 뒤에도 눌린 모양으로 둔다. */
  pressed: boolean;
  /** 이 거래를 저장하는 중. */
  busy: boolean;
  /** 목록 전체가 함께 쓰는 누름 판별(바뀌지 않는 값) — 스크롤하려고 댄 손가락에는 미리 받지 않는다. */
  press: PressPrefetch;
  onPrefetch: (txn: TransactionSummary) => void;
  onOpen: (txn: TransactionSummary, viaKeyboard: boolean) => void;
}>) {
  // ListRow는 click 이벤트를 넘겨주지 않는다 — 감싼 요소가 먼저(capture) 보고 키보드로 누른 click(detail 0)인지 적어 둔다.
  const viaKeyboard = useRef(false);
  const Icon = categoryIcon(categoryName);
  const isCancellation = txn.transactionType === "cancellation";
  const excluded = txn.excludedAt != null;
  const chips = transactionChips(txn);
  const totalNote = dayTotalNote(txn);
  return (
    // contents: 상자를 만들지 않아 줄 배치는 그대로다. 줄 버튼의 포인터 이벤트가 여기로 올라와, 누르려는 손가락이면
    // 미리 받기를 시작한다(press-prefetch.ts — 스크롤하려고 댄 손가락에는 요청을 보내지 않는다).
    <div
      className="contents"
      {...(txn.masked
        ? {}
        : pressPrefetchHandlers(press, () => onPrefetch(txn)))}
      onClickCapture={(event) => {
        viaKeyboard.current = event.detail === 0;
      }}
    >
      <ListRow
        icon={<Icon aria-hidden="true" />}
        iconClassName={cn("rounded-control", iconClassName)}
        title={
          txn.masked ? (
            <span className="text-muted-foreground">{merchantLabel(txn)}</span>
          ) : (
            merchantLabel(txn)
          )
        }
        subtitle={subtitle}
        value={
          <span
            className={cn(
              "flex min-w-0 max-w-full flex-col items-end",
              excluded && "line-through opacity-60"
            )}
          >
            {isCancellation ? (
              <Money amount={-txn.amount} currency={txn.currency} muted />
            ) : (
              <Money amount={txn.netAmount} currency={txn.currency} />
            )}
            {txn.originalCurrency && txn.originalAmount != null ? (
              <span className="text-muted-foreground text-micro max-w-full font-normal">
                {foreignAmountLabel(txn.originalAmount, txn.originalCurrency)}
              </span>
            ) : null}
          </span>
        }
        valueSub={
          // 승인은 기본 상태라 표시하지 않는다(§5 가계부). 소계에서 빠지는 줄은 이유를 글자로 붙인다.
          chips.length > 0 || totalNote ? (
            <span className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
              <TxnChips chips={chips} />
              {totalNote ? <span>{totalNote}</span> : null}
            </span>
          ) : undefined
        }
        onClick={
          txn.masked ? undefined : () => onOpen(txn, viaKeyboard.current)
        }
        className={cn(
          "rounded-control py-3 hover:bg-muted/60 active:bg-muted",
          pressed && "bg-muted",
          busy && "pointer-events-none opacity-60"
        )}
      />
    </div>
  );
});

/** 상세 줄의 값 자리 — 저장하는 동안 값 앞에 작은 진행 표시만 둔다(다른 줄은 그대로). */
function SavingValue({
  saving,
  children,
}: {
  saving: boolean;
  children: ReactNode;
}) {
  if (!saving) return <>{children}</>;
  return (
    <span className="inline-flex max-w-full items-center justify-end gap-1.5">
      <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
      <span className="sr-only">저장 중</span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** ISO 인스턴트 → `<input type="datetime-local">` 로컬 값(`YYYY-MM-DDTHH:mm`). */
function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** Asia/Seoul 기준 날짜 키(YYYY-MM-DD) 포맷터. */
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `useSearchParams`는 Suspense 경계를 요구한다(정적 export 포함) — 거래 화면의
 * 달·필터는 URL이 소유하므로 여기서 경계를 친다. `/login`·`/join`·`/register`가
 * 쓰던 것과 같은 형태로 맞춰, 어떤 화면은 감싸고 어떤 화면은 아닌 상태를 없앤다.
 */
export default function TransactionsPage() {
  return (
    <Suspense fallback={null}>
      <TransactionsView />
    </Suspense>
  );
}

function TransactionsView() {
  const { authedFetch, user } = useAuth();
  const { householdId } = useHousehold();
  const queryClient = useQueryClient();

  // --- 필터 상태 ---
  // 초기값을 URL에서 읽는다(mount 1회). 이전에는 로컬 state만 써서 알림이 만든
  // `?status=pending_review` 딥링크(packages/shared notificationDeepLink)가 그냥
  // 버려졌다 — 탭하면 필터 없는 전체 목록이 열렸다. 변경 시에는 아래 effect가 URL을
  // 되써서 새로고침·공유·뒤로가기가 같은 화면을 재현한다.
  const searchParams = useSearchParams();
  const router = useRouter();
  const initial = (key: string): string => searchParams.get(key) ?? "";

  const [month, setMonth] = useState<string>(() =>
    initialTransactionMonth(searchParams, currentMonth())
  );
  const [memberId, setMemberId] = useState<string>(() => initial("memberId"));
  const [cardId, setCardId] = useState<string>(() => initial("cardId"));
  const [categoryId, setCategoryId] = useState<string>(() =>
    initial("categoryId")
  );
  const [type, setType] = useState<string>(() => initial("type"));
  const [status, setStatus] = useState<string>(() => initial("status"));
  const [reviewOnly, setReviewOnly] = useState(() => initial("review") === "1");
  // '확인할 거래'를 끌 때 돌아갈 달(review-period.ts). 켜면 전체 기간으로 바뀌므로 켜기 전 달을 기억한다.
  const [restoreMonth, setRestoreMonth] = useState<string | null>(() =>
    initialRestoreMonth(searchParams, currentMonth())
  );
  /** 검색 입력값(즉시 반영) — 실제 쿼리는 아래 디바운스된 `q`를 쓴다. */
  const [qInput, setQInput] = useState<string>(() => initial("q"));
  const [q, setQ] = useState<string>(qInput);
  /**
   * 합계에서 뺀 거래만 보기. 분석 화면의 '합계 제외 거래 보기' 링크가 `?excluded=only`로
   * 여기로 들어오고, 해제 칩 이름은 '합계 제외 거래'다(transaction-filters.tsx).
   *
   * 필터 Select에 넣지 않고 URL 전용 + 해제 칩으로 둔 이유: 평소 목록은 제외분을
   * **함께** 보여주고 배지로 구분하는 것이 기본 동작이다(그게 옳다). 여기에 상시
   * 노출되는 3상 Select를 더하면 "제외 포함/제외만/제외 없음" 중 어디에 있는지를
   * 사용자가 늘 확인해야 한다. 이 필터는 특정 질문("내가 뭘 빼놨지")에 답하는
   * 일회성 진입이므로 들어온 사실만 분명히 보여주고 한 번에 풀 수 있게 한다.
   */
  const [excludedOnly, setExcludedOnly] = useState<boolean>(
    () => searchParams.get("excluded") === "only"
  );
  /**
   * 공용 카드 결제만 보기. 홈의 '공용' 행이 `?attribution=shared`로 들어온다.
   *
   * 구성원 Select에 '공용' 항목을 더하지 않는 이유: 공용은 `memberId` 값이 아니라
   * **귀속을 보류한 묶음**이라 같은 Select에 넣으면 성격이 다른 두 값이 한 축에
   * 섞인다(선택 후 상태를 URL로 표현할 때도 memberId가 아니어서 어긋난다).
   * `excludedOnly`와 같은 이유로 URL 전용 + 해제 칩으로 둔다.
   */
  const [sharedOnly, setSharedOnly] = useState<boolean>(
    () => searchParams.get("attribution") === "shared"
  );
  // 필터는 닫아도 유지한다. 표시 조건만 지울 때 기간·검색은 바꾸지 않는다.
  const filterSetters = {
    categoryId: setCategoryId,
    cardId: setCardId,
    memberId: setMemberId,
    type: setType,
    status: setStatus,
  };
  const changeFilter = (key: TransactionFilterKey, value: string) =>
    filterSetters[key](value);
  // 기간과 '확인할 거래' 칩은 함께 움직인다 — 칩을 끄는 길(칩·초기화·조건 지우기)은 모두 켜기 전 달로 돌아간다.
  const reviewPeriod: ReviewPeriodState = { reviewOnly, month, restoreMonth };
  const applyReviewPeriod = (next: ReviewPeriodState) => {
    setReviewOnly(next.reviewOnly);
    setMonth(next.month);
    setRestoreMonth(next.restoreMonth);
  };
  const changeMonth = (next: string) =>
    applyReviewPeriod(pickReviewMonth(reviewPeriod, next));
  const clearFilter = (key: ActiveTransactionFilter["key"]) => {
    if (key === "reviewOnly") applyReviewPeriod(leaveReviewPeriod(reviewPeriod));
    else if (key === "excludedOnly") setExcludedOnly(false);
    else if (key === "sharedOnly") setSharedOnly(false);
    else changeFilter(key, "");
  };
  const clearConditions = () => {
    for (const setter of Object.values(filterSetters)) setter("");
    applyReviewPeriod(leaveReviewPeriod(reviewPeriod));
    setExcludedOnly(false);
    setSharedOnly(false);
  };
  const toggleReview = () => {
    if (!reviewOnly) {
      // 확인할 거래는 상태로 고르는 조건이라 '취소·환불'·'합계 제외' 조건과 함께 두지 않는다.
      setStatus("");
      setExcludedOnly(false);
    }
    applyReviewPeriod(toggleReviewPeriod(reviewPeriod));
  };

  /** 칩 줄과 빈 상태가 함께 보는 조건 값(기간·검색어는 뺀다). */
  const filterValues = {
    categoryId,
    cardId,
    memberId,
    type,
    status,
    reviewOnly,
    excludedOnly,
    sharedOnly,
  };

  // 타이핑마다 요청하면 한 단어에 대여섯 번 쿼리가 나간다 → 300ms 디바운스.
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput]);

  // 필터 상태 → URL. 기본값은 파라미터에서 빼 링크를 짧게 유지한다.
  // `txn`(알림 딥링크)은 아래 상세 열기 effect가 소유하므로 여기서 건드리지 않는다.
  useEffect(() => {
    const params = transactionReviewPeriodQuery(
      month,
      reviewOnly,
      currentMonth()
    );
    if (memberId) params.set("memberId", memberId);
    if (cardId) params.set("cardId", cardId);
    if (categoryId) params.set("categoryId", categoryId);
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    if (q) params.set("q", q);
    if (excludedOnly) params.set("excluded", "only");
    if (sharedOnly) params.set("attribution", "shared");
    const selectedTransaction = new URLSearchParams(window.location.search).get(
      "txn"
    );
    if (selectedTransaction) params.set("txn", selectedTransaction);
    const qs = params.toString();
    // replace: 필터를 다섯 번 바꿨다고 뒤로가기를 다섯 번 눌러야 하면 안 된다.
    router.replace(qs ? `/transactions?${qs}` : "/transactions", {
      scroll: false,
    });
  }, [
    month,
    memberId,
    cardId,
    categoryId,
    type,
    status,
    reviewOnly,
    q,
    excludedOnly,
    sharedOnly,
    router,
  ]);

  // --- 참조 목록(필터/표시용) ---
  const membersQuery = useHouseholdMembers();
  const cardsQuery = useCardList();
  const categoriesQuery = useCategoryList();

  const members = membersQuery.data ?? [];
  const cards = cardsQuery.data ?? [];
  const categories = categoriesQuery.data ?? [];

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.memberId, m.name);
    return map;
  }, [members]);

  // 공용 카드 결제의 표시 색(가구 설정). null이면 중립 회색.
  const sharedColor = useHouseholdSummary().data?.sharedColor ?? null;

  // 구성원이 직접 고른 색(memberId → 팔레트 키). 없으면 해시 색 폴백.
  const memberColorById = useMemo(() => {
    const map = new Map<string, MemberColor | null>();
    for (const m of members) map.set(m.memberId, m.color);
    return map;
  }, [members]);

  // 귀속 규칙은 `lib/transaction-attribution`이 단일 출처다 — 홈과 이 화면이 각자
  // 구현했다가 갈렸다(공용 카드 88건이 홈에서 소유자 이름으로 보였다).
  const sharedCardIds = useMemo(() => sharedCardIdSet(cards), [cards]);
  const attributedMemberIdOf = (txn: TransactionSummary): string | null =>
    attributedMemberId(txn, sharedCardIds);

  const cardById = useMemo(() => {
    const map = new Map<string, CardSummary>();
    for (const c of cards) map.set(c.id, c);
    return map;
  }, [cards]);

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  const memberOptions: Option[] = members
    .filter((m) => m.status === "active")
    .map((m) => ({ value: m.memberId, label: m.name }));
  const cardOptions: Option[] = cards.map((c) => ({
    value: c.id,
    label: cardIdentityLabel(c, memberNameById),
  }));
  const categoryFilterOptions: Option[] = categories.map((c) => ({
    value: c.id,
    label: c.name,
  }));
  const monthOptions: Option[] = recentMonths(12).map((m) => ({
    value: m,
    label: formatMonth(m),
  }));
  // 오래된 기간의 딥링크도 현재 선택값이 빈칸으로 보이지 않도록 유지한다.
  if (month && !monthOptions.some((option) => option.value === month)) {
    monthOptions.unshift({ value: month, label: formatMonth(month) });
  }

  // --- 목록 쿼리 ---
  const { from, to } = useMemo(() => monthRange(month), [month]);
  const filters = useMemo(
    () => ({
      memberId: memberId || undefined,
      cardId: cardId || undefined,
      categoryId: categoryId || undefined,
      type: type || undefined,
      status: status || undefined,
      review: reviewOnly ? ("1" as const) : undefined,
      q: q || undefined,
      excluded: excludedOnly ? ("only" as const) : undefined,
      attribution: sharedOnly ? ("shared" as const) : undefined,
      from,
      to,
      limit: PAGE_SIZE,
    }),
    [
      memberId,
      cardId,
      categoryId,
      type,
      status,
      reviewOnly,
      q,
      excludedOnly,
      sharedOnly,
      from,
      to,
    ]
  );
  const listQuery = useInfiniteTransactions(filters);
  // 빈 목록이 '이번 달은 아직'인지 '거래가 하나도 없음'인지 가른다 — 목록과 같은 API로 기간·조건 없이 1건만 부른다.
  // 달별 집계(원화 승인만 센다)로 가르면 외화·취소만 있는 가족에게도 장치 연결을 권했다.
  const anyTransactionQuery = useTransactions({ limit: 1 });
  // '지난달 보기'가 빈 달을 가리키지 않게 거래 있는 달을 본다(홈 월 스위처와 같은 캐시).
  const monthsQuery = useAnalyticsMonths();

  // 무한 스크롤: 모든 페이지의 items를 평탄화한다.
  const items = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data]
  );

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = listQuery;

  // 리스트 하단 sentinel이 뷰포트에 들어오면 다음 페이지를 당겨온다(200px 선로딩).
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // --- 날짜별 그룹(발생일 기준, 서버 정렬 순서 유지) ---
  const groups = useMemo<DayGroup[]>(() => {
    const map = new Map<string, DayGroup>();
    for (const txn of items) {
      const date = new Date(occurredAt(txn));
      const valid = !Number.isNaN(date.getTime());
      const key = valid ? dayKeyFormatter.format(date) : "unknown";
      let group = map.get(key);
      if (!group) {
        // '11월 5일', 올해가 아니면 '2025년 11월 5일'(lib/format — 서울 기준).
        const label = valid ? formatMonthDay(date) : "날짜 미확인";
        group = { key, label, total: 0, counted: 0, items: [] };
        map.set(key, group);
      }
      group.items.push(txn);
      // 합계 제외(excludedAt) 거래는 서버 집계(summary/budget/analytics)와 동일하게
      // 날짜 소계에서도 뺀다 — 같은 행을 '합계 제외'로 표시하면서 소계엔 더하면 모순.
      // amount는 minor units라 통화가 섞이면 소계가 무의미하므로 KRW만 합산한다
      // (외화 건은 개별 행에 자기 통화로 표시됨; 서버 KRW 집계 원칙과 동일).
      // 빠지는 줄에는 이유('소계 제외'·'원래 결제에 반영')를 글자로 붙인다(list-status.ts).
      if (countsInDayTotal(txn)) {
        group.total += txn.netAmount;
        group.counted += 1;
      }
    }
    // 서버 정렬 키와 화면의 날짜(approvedAt ?? cancelledAt ?? createdAt)가 다를 수 있어
    // 첫 등장 순서를 그대로 쓰면 11월 4일 → 2일 → 3일처럼 섞였다. 날짜 키로 다시 정렬한다.
    return [...map.values()]
      .map((group) => ({
        ...group,
        items: [...group.items].sort((a, b) =>
          occurredAt(b).localeCompare(occurredAt(a))
        ),
      }))
      .sort((a, b) =>
        a.key === "unknown"
          ? 1
          : b.key === "unknown"
          ? -1
          : b.key.localeCompare(a.key)
      );
  }, [items]);

  // --- 뮤테이션(행 작업) ---
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // 상세에서 다른 거래(이 가맹점 최근 결제·겹친 결제)로 넘어갔을 때 돌아갈 거래 — 한 단계만 기억한다.
  const [detailBackId, setDetailBackId] = useState<string | null>(null);
  const [memoTarget, setMemoTarget] = useState<TransactionSummary | null>(null);
  const [linkTarget, setLinkTarget] = useState<TransactionSummary | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // 푸시 알림 딥링크(?txn=<id>) → 해당 거래 상세 열기. 목록에 없을 수 있어
  // (다른 월/필터) 단건 조회로 폴백한다. 조회가 실패하면 **조용히 리스트에 머물지
  // 않고** 이유를 말한다(아래 detailFallback) — 예전에는 아무 일도 일어나지 않아
  // 사용자가 앱이 멈춘 줄 알았다. 상세를 연 뒤 URL에서 ?txn을 제거해, 같은 알림을
  // 다시 탭하면(같은 경로 push) effect가 재실행되어 다시 열리게 한다.
  useEffect(() => {
    const txnParam = searchParams.get("txn");
    if (!txnParam) return;
    setDetailId(txnParam);
    setDetailBackId(null);
    if (typeof window !== "undefined") {
      // `txn`만 지운다. 예전엔 pathname으로 통째로 replace해서, 같은 링크에 실려 온
      // 다른 필터(`?status=`)까지 함께 날아갔다.
      const url = new URL(window.location.href);
      url.searchParams.delete("txn");
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
  }, [searchParams]);

  const inList = detailId != null && items.some((t) => t.id === detailId);
  const detailFallbackQuery = useQuery({
    queryKey: transactionDetailKey(householdId, detailId),
    enabled: detailId != null && !inList,
    retry: false,
    queryFn: () =>
      authedFetch((token) => api.transactions.get(token, detailId as string)),
  });

  // 상세 Dialog는 항상 최신 목록의 행을 바라본다(뮤테이션 후 refetch 반영).
  // 목록에 없으면 단건 조회 결과로 폴백. 조회가 실패했을 때 시트와 얼럿 중 무엇을 보일지는 resolveDetailFallback이
  // 하나만 고른다 — 미리 넣은 요약(seedTransactionDetail)이 실패 뒤에도 캐시에 남아 둘이 겹쳐 떴다.
  const detailFallback = resolveDetailFallback(
    detailFallbackQuery.data,
    detailFallbackQuery.isError
      ? detailFallbackReason(detailFallbackQuery.error)
      : null
  );
  const detailTxn = detailId
    ? items.find((t) => t.id === detailId) ?? detailFallback.txn
    : null;
  const detailCard = detailTxn?.cardId
    ? cardById.get(detailTxn.cardId)
    : undefined;

  // 폴백까지 실패한 경우 = 열 수 없는 딥링크. 이유(없음/막힘/오류)를 구분해 알린다.
  const detailFallbackError =
    detailId != null && !inList && detailFallback.failure != null
      ? detailFallbackCopy(detailFallback.failure)
      : null;

  // 상세에서 진행 중이거나 실패한 저장 — 거래·자리(줄 또는 동작)마다 따로 둔다(detail-save.ts).
  // useMutation 상태는 마지막 호출만 기억해서, 한 줄을 저장하는 동안 다른 줄을 고르면 앞 줄의 고른 값·실패가 사라졌다.
  const [detailSaves, setDetailSaves] = useState<DetailSaves>({});
  const saveSeq = useRef(0);

  const mutation = useMutation({
    onMutate: async (action: RowAction) => {
      const seq = ++saveSeq.current;
      setDetailSaves((saves) => startDetailSave(saves, action, seq));
      await cancelTransactionReads(queryClient, householdId, action.id);
      return { seq };
    },
    mutationFn: (action: RowAction): Promise<TransactionSummary> =>
      authedFetch((token) => {
        switch (action.kind) {
          case "update":
            return api.transactions.update(token, action.id, action.body);
          case "markDuplicate":
            return api.transactions.markDuplicate(token, action.id);
          case "markValid":
            return api.transactions.markValid(token, action.id);
          case "exclude":
            return api.transactions.exclude(token, action.id);
          case "include":
            return api.transactions.include(token, action.id);
          case "linkCancellation":
            return api.transactions.linkCancellation(token, action.id, {
              approvalTransactionId: action.approvalTransactionId,
            });
          case "resolveCard":
            // 카드 변경만으로는 '확인 필요'가 풀리지 않는다(서버 update는 status를 건드리지 않는다).
            return api.transactions
              .update(token, action.id, { cardId: action.cardId })
              .then(() => api.transactions.markValid(token, action.id));
          default: {
            const exhaustive: never = action;
            throw new Error(`unknown action: ${JSON.stringify(exhaustive)}`);
          }
        }
      }),
    // 아래 콜백은 호출마다 돈다(mutate의 두 번째 인자와 달리 마지막 호출에만 묶이지 않는다).
    onSuccess: (updated, action, started) => {
      setActionError(null);
      // PATCH's response is authoritative immediately, including off-list deep links.
      writeTransactionResult(queryClient, updated);
      // 진행 표시(고른 값)는 위 캐시 갱신이 화면에 닿은 뒤에 지운다 — 먼저 지우면 그 줄에 옛 값이 잠깐 비친다.
      // 캐시 알림은 notifyManager가 다음 틱에 보내므로 같은 줄 뒤에 세운다.
      notifyManager.schedule(() =>
        setDetailSaves((saves) =>
          settleDetailSave(saves, action, started.seq, null)
        )
      );
      // 거래·집계·예산·인사이트·가맹점후보를 단일 헬퍼로 일괄 무효화(실시간 힌트
      // 경로와 동일 범위 — 조합 불일치/누락 방지).
      invalidateTransactionScope(queryClient);
      // 결과가 화면에 바로 보이지 않는 동작(확인·빼기·다시 넣기·연결)만 토스트로 한 일을 말한다.
      // 줄에서 고친 값은 그 자리에서 바뀌는 것이 확인이라 띄우지 않는다(detail-save.ts).
      const message = savedToast(action.kind, updated.transactionType);
      if (message) toast.success(message);
    },
    onError: (error, action, started) => {
      const message = errorMessage(error);
      setActionError(message);
      setDetailSaves((saves) =>
        settleDetailSave(saves, action, started?.seq, message)
      );
      // 카드 연결은 됐는데 확인이 실패했을 수 있다 — 화면이 바뀐 카드를 놓치지 않게 다시 읽는다.
      if (action.kind === "resolveCard") invalidateTransactionScope(queryClient);
    },
  });

  const busyId = mutation.isPending ? mutation.variables?.id ?? null : null;

  const changeCategory = (txn: TransactionSummary, nextCategoryId: string) => {
    if (nextCategoryId === "" || nextCategoryId === txn.categoryId) return;
    mutation.mutate({
      kind: "update",
      id: txn.id,
      body: { categoryId: nextCategoryId },
    });
  };

  // 카테고리를 바꾼 뒤 '앞으로도 이렇게 분류'를 고르면 같은 분류로 가맹점 규칙만 저장한다
  // (서버가 merchant_category_rules를 upsert, 지난 거래는 그대로). 예전 체크박스는 분류를
  // 고르기 **전에** 켜야만 적용돼, 고른 뒤 켜면 아무 일도 없었다.
  const applyCategoryRule = (txn: TransactionSummary, categoryId: string) =>
    mutation.mutateAsync({
      kind: "update",
      id: txn.id,
      body: { categoryId, applyRule: true },
    });

  // 금액·날짜 수정(변경된 필드만 PATCH). 빈 body면 no-op.
  const editFields = async (
    txn: TransactionSummary,
    body: TransactionEditPatch
  ): Promise<TransactionSummary> => {
    if (body.amount === undefined && body.occurredAt === undefined) return txn;
    return mutation.mutateAsync({ kind: "update", id: txn.id, body });
  };

  // 하드 삭제(되돌리기 불가). 성공 시 상세 닫기 + 목록/집계 무효화.
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.transactions.remove(token, id)),
    onMutate: (id: string) => ({ householdId, id }),
    onSuccess: (_result, id, context) => {
      setActionError(null);
      toast.success("거래를 삭제했어요");
      queryClient.removeQueries({
        queryKey: transactionDetailKey(context?.householdId ?? householdId, id),
      });
      setDetailId((current) => (current === id ? null : current));
      setDetailBackId((back) => (back === id ? null : back));
      invalidateTransactionScope(queryClient);
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  // 알맞은 카테고리가 없을 때: 새 커스텀 카테고리를 만들고 곧바로 이 거래에 지정한다.
  const createCategoryMut = useCreateCategory();
  const handleCreateCategory = async (
    txn: TransactionSummary,
    name: string
  ): Promise<string> => {
    const created = await createCategoryMut.mutateAsync(name);
    changeCategory(txn, created.id);
    return created.id;
  };

  const changeVisibility = (
    txn: TransactionSummary,
    nextVisibility: string
  ) => {
    if (nextVisibility === txn.visibility) return;
    mutation.mutate({
      kind: "update",
      id: txn.id,
      body: { visibility: nextVisibility as CardVisibility },
    });
  };

  // 카드 수동 연결/재지정. 서버는 cardId 설정 시 카드 visibility를 재상속하고,
  // null이면 'household'로 되돌린다(자동연결 미매칭·모호(pending_review) 거래를
  // 사람이 직접 해소하는 경로). 승격의 소급 미적용을 보완한다.
  const changeCard = (txn: TransactionSummary, next: string) => {
    const nextCardId = next === CARD_NONE ? null : next;
    if (nextCardId === (txn.cardId ?? null)) return;
    mutation.mutate({
      kind: "update",
      id: txn.id,
      body: { cardId: nextCardId },
    });
  };

  const saveMemo = (txn: TransactionSummary, memo: string) => {
    mutation.mutate(
      { kind: "update", id: txn.id, body: { memo } },
      {
        onSuccess: () =>
          setMemoTarget((current) => (current?.id === txn.id ? null : current)),
      }
    );
  };

  const confirmLink = (txn: TransactionSummary, approvalId: string) => {
    mutation.mutate(
      {
        kind: "linkCancellation",
        id: txn.id,
        approvalTransactionId: approvalId,
      },
      {
        onSuccess: () =>
          setLinkTarget((current) => (current?.id === txn.id ? null : current)),
      }
    );
  };

  // --- 행 표시용 파생 ---
  const categoryNameOf = (txn: TransactionSummary): string | null =>
    txn.categoryId ? categoryNameById.get(txn.categoryId) ?? null : null;

  const cardLabelOf = (txn: TransactionSummary): string => {
    if (!txn.cardId) return "카드 미연결";
    return cardById.get(txn.cardId)?.alias ?? "카드";
  };

  // 이름과 색은 거래 구성원 기준이다. 연결된 카드 소유자와 혼동하지 않는다.
  /**
   * 아이콘 색. 공용 카드는 사람 색을 쓰지 않는다 — 색이 곧 "누구"를 뜻하므로, 귀속을
   * 보류한 거래에 특정 색을 주면 화면이 이름(공용)과 다른 답을 말한다.
   */
  const sharedIconClass = (txn: TransactionSummary): string => {
    const id = attributedMemberIdOf(txn);
    // 공용은 사람 팔레트에서 **자동 배정하지 않는다** — 자동이면 색을 보고 사람을
    // 떠올린 사용자가 이름에서 '공용'을 읽고 어긋난다. 사용자가 직접 고른 색만
    // 쓰고(가구 설정), 고르지 않았으면 종전 회색 그대로다.
    if (id === null) return sharedColorClass(sharedColor);
    return memberColorClass(id, memberColorById.get(id));
  };

  const memberNameOf = (txn: TransactionSummary): string =>
    attributedMemberName(attributedMemberIdOf(txn), memberNameById);

  const subtitleOf = (txn: TransactionSummary): string => {
    const parts = [
      cardLabelOf(txn),
      memberNameOf(txn),
      categoryNameOf(txn) ?? "미분류",
    ];
    // 1개월은 일시불이다 — `1개월 할부`로 쓰면 할부로 오해한다.
    if (txn.installmentMonths && txn.installmentMonths > 1)
      parts.push(`${txn.installmentMonths}개월 할부`);
    return parts.join(" · ");
  };

  const showLoading = householdId != null && listQuery.isLoading;
  const showError = listQuery.isError;

  const emptyCopy = transactionsEmptyCopy({
    month,
    currentMonth: currentMonth(),
    // '확인할 거래' 칩만 켰는지, 다른 조건과 함께 켰는지에 따라 제목이 다르다.
    hasOtherConditions: hasTransactionConditions({
      ...filterValues,
      reviewOnly: false,
    }),
    reviewOnly,
    query: q,
    hasAnyTransaction: anyTransactionQuery.data
      ? anyTransactionQuery.data.items.length > 0
      : null,
    monthsWithTransactions: monthsQuery.data
      ? monthsQuery.data.items.map((item) => item.month)
      : null,
  });
  const emptyAction = emptyCopy.action;
  // 빈 목록의 버튼은 원인 하나만 지운다 — 칩 줄의 '초기화'처럼 조건만 지우고 기간·검색어는 둔다.
  const runEmptyAction = (action: TransactionsEmptyAction) => {
    if (action.kind === "clearConditions") clearConditions();
    else if (action.kind === "clearSearch") {
      setQInput("");
      setQ("");
    } else if (action.kind === "showMonth") changeMonth(action.month);
  };

  /**
   * 상세를 떠날 때(닫기·다른 거래로 넘어가기) 그 거래에 남은 실패 문구를 지운다 — 같은 거래를 다시 열었을 때
   * 아무것도 하지 않았는데 이미 본 실패가 되살아나지 않게. 진행 중인 저장은 그대로 둔다(끝나면 결과가 그 줄에 남는다).
   */
  const forgetDetailErrors = (id: string | null) => {
    if (id != null) setDetailSaves((saves) => clearDetailErrors(saves, id));
    if (!deleteMutation.isPending) deleteMutation.reset();
  };
  /** 목록에서 연 상세는 돌아갈 거래가 없다. 닫힌 뒤에 끝난 저장의 실패는 목록 위 배너가 이미 말했다. */
  const openDetail = (id: string) => {
    forgetDetailErrors(id);
    setDetailBackId(null);
    setDetailId(id);
  };
  /** 닫으면 상세에 보이던 오류도 함께 지운다(목록 위에 남지 않게). */
  const closeDetail = () => {
    forgetDetailErrors(detailId);
    setDetailId(null);
    setDetailBackId(null);
    setActionError(null);
  };

  // --- 상세 열기: 미리 받기 + 짧게 기다리기(detail-prefetch.ts) ---
  // 시트가 열린 뒤 하위 데이터(최근 결제·짝 결제·가족에게 물어보기)가 따로 도착하면 내용만큼 아래에 붙는 시트의
  // 윗변이 튀었다(2026-11-06 사용자 지적). 줄을 누르려 하면 받기 시작하고, 열 때 아직이면 잠깐만 기다린다.
  const askFamily =
    user != null &&
    members.some(
      (member) => member.status === "active" && member.userId !== user.id
    );
  const prefetchContext: DetailPrefetchContext = {
    householdId,
    authedFetch,
    askFamily,
  };
  // 기다리는 동안 누른 줄을 눌린 모양으로 둔다 — 손을 떼면 active: 표시가 사라진다.
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openGate] = useState(() => createDetailOpenGate(setOpeningId));
  useEffect(() => () => openGate.cancel(), [openGate]);
  const detailIdRef = useRef(detailId);
  useEffect(() => {
    detailIdRef.current = detailId;
  }, [detailId]);
  const prefetchDetail = (txn: TransactionSummary) => {
    void prefetchTransactionDetail(queryClient, txn, prefetchContext);
  };
  // 키보드로 연 상세는 기다리지 않는다. 기다리는 사이 다른 길(닫기·이전 거래·딥링크)로 상세가 바뀌었으면 열지 않는다.
  const openWhenReady = (
    txn: TransactionSummary,
    viaKeyboard: boolean,
    open: () => void
  ) => {
    const from = detailIdRef.current;
    openGate.open(
      txn.id,
      viaKeyboard
        ? null
        : prefetchTransactionDetail(queryClient, txn, prefetchContext),
      () => {
        if (detailIdRef.current === from) open();
      }
    );
  };
  const openFromList = (txn: TransactionSummary, viaKeyboard: boolean) =>
    openWhenReady(txn, viaKeyboard, () => openDetail(txn.id));
  /** 상세 안에서 다른 거래(이 가맹점 최근 결제·짝 결제)로 넘어간다 — '‹ 이전 거래'로 한 단계 돌아온다. */
  const openFromDetail = (
    from: TransactionSummary,
    target: TransactionSummary,
    viaKeyboard: boolean
  ) =>
    openWhenReady(target, viaKeyboard, () => {
      // 목록(이번 달·조건) 밖 거래는 단건 조회가 끝날 때까지 상세가 사라졌다가 다시 올라왔다 — 가진 요약으로 먼저 그린다.
      if (!items.some((item) => item.id === target.id)) {
        seedTransactionDetail(queryClient, householdId, target);
      }
      forgetDetailErrors(from.id);
      setDetailBackId(from.id);
      setDetailId(target.id);
    });
  // 목록 줄은 memo(TransactionRow)라 넘기는 함수가 렌더마다 바뀌지 않게 하고, 부를 때 최신 것을 쓴다.
  // 누름 판별도 목록이 하나를 함께 쓴다 — 손가락은 한 번에 한 줄만 누른다.
  const rowPress = usePressPrefetch();
  const rowHandlers = useRef({ prefetchDetail, openFromList });
  rowHandlers.current = { prefetchDetail, openFromList };
  const onRowPrefetch = useCallback(
    (txn: TransactionSummary) => rowHandlers.current.prefetchDetail(txn),
    []
  );
  const onRowOpen = useCallback(
    (txn: TransactionSummary, viaKeyboard: boolean) =>
      rowHandlers.current.openFromList(txn, viaKeyboard),
    []
  );
  // 메모·원래 결제 고르기 창은 그 거래의 저장 상태만 본다(다른 줄 저장 중에도 막히지 않게).
  const memoSave = memoTarget
    ? detailSavesFor(detailSaves, memoTarget.id).memo
    : undefined;
  const linkSave = linkTarget
    ? detailSavesFor(detailSaves, linkTarget.id).action
    : undefined;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-6">
      <LedgerHeader active="transactions" month={month} />
      <Fab label="거래 추가" onClick={() => setAddOpen(true)}>
        <Plus />
      </Fab>

      <TransactionFilters
        month={month}
        monthOptions={monthOptions}
        values={filterValues}
        choices={{
          categoryId: categoryFilterOptions,
          cardId: cardOptions,
          memberId: memberOptions,
          type: TYPE_OPTIONS,
          status: STATUS_OPTIONS,
        }}
        onMonthChange={changeMonth}
        onChange={changeFilter}
        onClear={clearFilter}
        onClearAll={clearConditions}
        onToggleReview={toggleReview}
      >
        {/* 검색은 기존 가맹점·메모 조건을 그대로 사용한다. */}
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            inputMode="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            maxLength={SEARCH_MAX_LENGTH}
            placeholder="가맹점이나 메모로 찾기"
            aria-label="거래 검색"
            // 기본 Input(회색 채움)을 그대로 쓴다. 예전 bg-card 덮어쓰기는 폰에서 본문 바탕과 같은 색이라 칸 경계가 사라졌다.
            className="pl-11 pr-12"
          />
          {qInput ? (
            <button
              type="button"
              onClick={() => setQInput("")}
              aria-label="검색어 지우기"
              className="text-muted-foreground hover:text-foreground focus-visible:outline-ring absolute top-1/2 right-1 flex size-11 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 active:text-foreground"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </TransactionFilters>

      {/* 상세가 열려 있으면 오류는 상세의 그 줄 아래에 보인다. 여기는 상세를 닫은 뒤 끝난 저장의 실패만 말한다. */}
      {actionError && detailTxn == null ? (
        <InlineNotice tone="error">{actionError}</InlineNotice>
      ) : null}

      {/* 목록 — 날짜별 그룹 + ListRow */}
      <section aria-label="거래 내역" className="min-w-0">
        <div className="flex min-w-0 flex-col gap-6">
          {showLoading ? (
            <div
              className="flex flex-col gap-1"
              role="status"
              aria-live="polite"
            >
              <span className="sr-only">거래를 불러오고 있어요</span>
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="flex min-w-0 items-center gap-2.5 px-1 py-3.5 sm:gap-3 sm:px-2"
                >
                  <Skeleton className="size-9 shrink-0 rounded-full sm:size-10" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-3/4 max-w-32" />
                    <Skeleton className="h-3 w-full max-w-44" />
                  </div>
                  <Skeleton className="h-4 w-16 shrink-0" />
                </div>
              ))}
            </div>
          ) : showError ? (
            <ErrorState
              message={`거래를 불러오지 못했어요: ${errorMessage(
                listQuery.error
              )}`}
              onRetry={() => void listQuery.refetch()}
              retrying={listQuery.isFetching}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={emptyCopy.reason === "noMatch" ? <SearchX /> : <Receipt />}
              title={emptyCopy.title}
              description={emptyCopy.description ?? undefined}
              action={
                emptyAction?.kind === "connectDevice" ? (
                  <Button variant="weak" className="w-full" asChild>
                    <Link href={emptyAction.href}>{emptyAction.label}</Link>
                  </Button>
                ) : emptyAction ? (
                  <Button
                    variant="weak"
                    className="w-full"
                    onClick={() => runEmptyAction(emptyAction)}
                  >
                    {emptyAction.label}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {/* 날짜마다 상자를 나누지 않고 한 섹션 안에 날짜 머리로 구분한다(§8). */}
              <div className="finance-panel flex min-w-0 flex-col px-3 pb-2 sm:px-5">
                {groups.map((group) => (
                  <section
                    key={group.key}
                    className="flex min-w-0 flex-col pt-2"
                  >
                    <div className="flex min-w-0 items-baseline justify-between gap-3 px-1 pt-3 pb-1 sm:px-2">
                      <h2 className="text-caption text-muted-foreground font-semibold">
                        {group.label}
                      </h2>
                      {/* 원화 승인만 더한다. 빠진 줄(환불·외화)에는 그 줄에 이유가 글자로 보인다(list-status.ts). */}
                      {group.counted > 0 ? (
                        <p className="text-caption text-muted-foreground min-w-0 text-right">
                          <span className="sr-only">소계 </span>
                          <Money amount={group.total} />
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-col">
                      {group.items.map((txn) => (
                        <TransactionRow
                          key={txn.id}
                          txn={txn}
                          categoryName={categoryNameOf(txn)}
                          iconClassName={
                            txn.masked || txn.excludedAt != null
                              ? "bg-muted text-muted-foreground"
                              : sharedIconClass(txn)
                          }
                          subtitle={subtitleOf(txn)}
                          pressed={openingId === txn.id}
                          busy={busyId === txn.id}
                          press={rowPress}
                          onPrefetch={onRowPrefetch}
                          onOpen={onRowOpen}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>

              {/* 무한 스크롤 sentinel: 뷰포트 진입 시 자동 로드(관찰 실패 대비 버튼 폴백) */}
              <div
                ref={loadMoreRef}
                className="flex flex-col items-center gap-2 py-2"
              >
                {isFetchingNextPage ? (
                  <span className="text-muted-foreground text-caption">
                    불러오는 중…
                  </span>
                ) : hasNextPage ? (
                  <button
                    type="button"
                    onClick={() => void fetchNextPage()}
                    className="text-accent-foreground hover:bg-muted focus-visible:outline-ring text-caption min-h-11 rounded-control px-5 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 active:bg-muted"
                  >
                    더 보기
                  </button>
                ) : (
                  <span className="text-muted-foreground text-caption">
                    {items.length}건 · 마지막이에요
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {detailTxn ? (
        <TransactionDetailDialog
          key={`${householdId}:${detailTxn.id}`}
          txn={detailTxn}
          saves={detailSavesFor(detailSaves, detailTxn.id)}
          deleting={deleteMutation.isPending}
          deleteError={
            deleteMutation.isError && deleteMutation.variables === detailTxn.id
              ? errorMessage(deleteMutation.error)
              : null
          }
          cardLabel={
            detailCard
              ? cardIdentityLabel(detailCard, memberNameById)
              : detailTxn.cardId
              ? "카드 정보 확인 불가"
              : "카드 미연결"
          }
          memberName={memberNameOf(detailTxn)}
          ownershipMismatch={
            detailCard != null &&
            !detailCard.isShared &&
            detailCard.ownerMemberId !== detailTxn.memberId
          }
          cardOptions={cardOptions}
          categoryOptions={categoryFilterOptions}
          onApplyCategoryRule={(categoryId) =>
            applyCategoryRule(detailTxn, categoryId)
          }
          onOpenTransaction={(target, viaKeyboard) =>
            openFromDetail(detailTxn, target, viaKeyboard)
          }
          onPrefetchTransaction={prefetchDetail}
          openingId={openingId}
          onBack={
            detailBackId != null && detailBackId !== detailTxn.id
              ? () => {
                  forgetDetailErrors(detailTxn.id);
                  setDetailId(detailBackId);
                  setDetailBackId(null);
                }
              : undefined
          }
          onChangeCard={(v) => changeCard(detailTxn, v)}
          onResolveCard={(cardId) =>
            mutation.mutate({ kind: "resolveCard", id: detailTxn.id, cardId })
          }
          onChangeCategory={(v) => changeCategory(detailTxn, v)}
          onCreateCategory={(name) => handleCreateCategory(detailTxn, name)}
          onChangeVisibility={(v) => changeVisibility(detailTxn, v)}
          onEditFields={(body) => editFields(detailTxn, body)}
          onOpenMemo={() => {
            setDetailSaves((saves) =>
              clearDetailErrors(saves, detailTxn.id, "memo")
            );
            setMemoTarget(detailTxn);
          }}
          onOpenLink={() => {
            setDetailSaves((saves) =>
              clearDetailErrors(saves, detailTxn.id, "action")
            );
            setLinkTarget(detailTxn);
          }}
          onMarkValid={() =>
            mutation.mutate({ kind: "markValid", id: detailTxn.id })
          }
          onExclude={() =>
            mutation.mutate({ kind: "exclude", id: detailTxn.id })
          }
          onInclude={() =>
            mutation.mutate({ kind: "include", id: detailTxn.id })
          }
          onDelete={() => deleteMutation.mutate(detailTxn.id)}
          onClose={closeDetail}
        />
      ) : null}

      {/* 열 수 없는 딥링크 — 상세가 열렸어야 할 자리에 이유를 띄운다.
          모달인 이유: 사용자가 방금 "이 거래를 보여줘"를 눌렀고, 그 자리에 답이
          없으면 목록 어딘가의 토스트로는 못 알아챈다. */}
      <AlertDialog
        open={detailFallbackError !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        {/* 사용자가 예상하지 못한 문제를 알리는 창이라 얼럿(가운데)이다 — 확인(액션 시트)과 다르다. */}
        <AlertDialogContent variant="alert">
          <AlertDialogHeader>
            <AlertDialogTitle>{detailFallbackError?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {detailFallbackError?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>닫기</AlertDialogCancel>
            {detailFallbackError?.retryable ? (
              // 일시적 오류만 재시도를 권한다. 없는/막힌 거래는 다시 눌러도 같다.
              <AlertDialogAction
                disabled={detailFallbackQuery.isFetching}
                onClick={(e) => {
                  // preventDefault: 재시도는 다이얼로그를 닫지 않는다(또 실패할 수 있다).
                  e.preventDefault();
                  void detailFallbackQuery.refetch();
                }}
              >
                {detailFallbackQuery.isFetching ? "불러오는 중…" : "다시 시도"}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 메모·원래 결제 고르기는 입력 폼이다. 오류는 창 안에서 말한다(뒤의 상세에 가려지지 않게). */}
      {memoTarget ? (
        <MemoModal
          txn={memoTarget}
          busy={memoSave?.status === "pending"}
          error={memoSave?.status === "error" ? memoSave.message : null}
          onClose={() => setMemoTarget(null)}
          onSave={(memo) => saveMemo(memoTarget, memo)}
        />
      ) : null}

      {linkTarget ? (
        <LinkCancellationModal
          cancellation={linkTarget}
          busy={linkSave?.status === "pending"}
          error={
            linkSave?.status === "error" &&
            linkSave.kind === "linkCancellation"
              ? linkSave.message
              : null
          }
          onClose={() => setLinkTarget(null)}
          onConfirm={(approvalId) => confirmLink(linkTarget, approvalId)}
        />
      ) : null}

      <AddTransactionDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Transaction detail dialog                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 거래 상세 바텀 시트 — 행 클릭 시 열리며 편집 액션(카테고리/공개 범위/메모/
 * 정상·중복 표시/취소연결)을 점진 공개로 모아 보여준다. masked 행은 열리지 않는다.
 * 닫는 길은 손잡이(끌어내리기)와 오른쪽 위 X 둘이다 — 맨 아래 '닫기' 버튼은 세 번째 닫기라 뺐다(HIG 검수 3·4단계).
 */
function TransactionDetailDialog({
  txn,
  saves,
  deleting,
  deleteError,
  cardLabel,
  memberName,
  ownershipMismatch,
  cardOptions,
  categoryOptions,
  onApplyCategoryRule,
  onOpenTransaction,
  onPrefetchTransaction,
  openingId,
  onChangeCard,
  onResolveCard,
  onChangeCategory,
  onCreateCategory,
  onChangeVisibility,
  onEditFields,
  onOpenMemo,
  onOpenLink,
  onMarkValid,
  onExclude,
  onInclude,
  onDelete,
  onBack,
  onClose,
}: Readonly<{
  txn: TransactionSummary;
  /**
   * 이 거래의 자리별 저장 상태 — 진행 표시·고른 값·오류를 그 줄(또는 금액 아래 동작 자리)에만 띄운다.
   * 줄마다 따로라 한 줄을 저장하는 동안 다른 줄을 골라도 앞 줄의 표시와 실패가 남는다(detail-save.ts).
   */
  saves: DetailSaveView;
  /** 삭제가 진행 중. */
  deleting: boolean;
  deleteError: string | null;
  cardLabel: string;
  memberName: string;
  ownershipMismatch: boolean;
  cardOptions: ReadonlyArray<Option>;
  categoryOptions: ReadonlyArray<Option>;
  onApplyCategoryRule: (categoryId: string) => Promise<unknown>;
  /** 다른 거래(최근 결제·짝 결제)로 넘어간다. 키보드로 누른 click이면 `viaKeyboard`가 참이다(기다리지 않는다). */
  onOpenTransaction: (target: TransactionSummary, viaKeyboard: boolean) => void;
  /** 다른 거래 줄에 손가락·마우스가 닿는 순간 — 그 거래 시트의 하위 데이터를 미리 받는다. */
  onPrefetchTransaction: (target: TransactionSummary) => void;
  /** 열려고 하위 데이터를 기다리는 거래 — 누른 줄을 손을 뗀 뒤에도 눌린 모양으로 둔다. */
  openingId: string | null;
  onChangeCard: (cardId: string) => void;
  onResolveCard: (cardId: string) => void;
  onChangeCategory: (categoryId: string) => void;
  onCreateCategory: (name: string) => Promise<string>;
  onChangeVisibility: (visibility: string) => void;
  onEditFields: (body: TransactionEditPatch) => Promise<TransactionSummary>;
  onOpenMemo: () => void;
  onOpenLink: () => void;
  onMarkValid: () => void;
  onExclude: () => void;
  onInclude: () => void;
  onDelete: () => void;
  /** 다른 거래에서 넘어왔으면 그 거래로 돌아간다('‹ 이전 거래'). */
  onBack?: () => void;
  onClose: () => void;
}>) {
  const [editSaving, setEditSaving] = useState(false);
  // '그 결제 보기'에 누르려는 손가락이 닿으면 그 결제의 하위 데이터를 미리 받는다(스크롤 터치는 거른다).
  const pairPress = usePressPrefetch();
  // 줄에서 고른 값이 저장되는 동안은 다른 줄·동작을 잠그거나 흐리게 하지 않는다 — 그 줄의 값 자리에만 진행 표시.
  // 저장 중인 그 줄만은 다시 고를 수 없게 잠근다: 저장 중에 원래 값으로 되돌리면 먼저 보낸 저장이 남아
  // 마지막에 고른 값과 다른 값이 저장됐다.
  // 확인·빼기·연결·삭제·금액 수정처럼 거래 전체에 걸린 동작이 진행 중일 때만 버튼을 잠근다.
  const actionSave = saves.action;
  const busy = actionSave?.status === "pending" || deleting || editSaving;
  const isSaving = (field: DetailField) => saves[field]?.status === "pending";
  /** 저장 중인 값 — 고른 값을 저장이 끝나기 전에 그 줄에 먼저 보인다. 끝나면 같은 값이 그대로 남는다. */
  const pendingBody = (field: DetailField) =>
    isSaving(field) ? saves[field]?.body ?? null : null;
  const rowError = (field: DetailField) => {
    const save = saves[field];
    return save?.status === "error" && save.message ? (
      <InlineNotice tone="error">{save.message}</InlineNotice>
    ) : null;
  };
  // 카드를 고르며 확인하는 동안은 카드 줄을, 카드 줄을 저장하는 동안은 결정 블록의 카드 고르기를 잠근다 — 둘 다 카드를 바꾼다.
  const resolvingCard =
    actionSave?.status === "pending" && actionSave.kind === "resolveCard";
  // 잠긴 줄은 PickerMenu·FieldRow의 disabled로 Radix 트리거까지 잠근다 — 버튼 disabled만으로는 폰(Android WebView)에서
  // 메뉴가 열렸다. 그래도 잠긴 동안 고른 값은 onSelect에서 한 번 더 버린다(먼저 보낸 저장과 겹치지 않게).
  const categoryLocked = deleting || isSaving("category");
  const cardLocked = deleting || isSaving("card") || resolvingCard;
  const visibilityLocked = deleting || isSaving("visibility");
  const pickCardLocked = busy || isSaving("card");
  // 줄이 아닌 동작(확인·빼기·다시 넣기·연결·카드 고르기·삭제)의 오류는 금액 아래 동작 자리에 보인다.
  // 금액·날짜 수정의 오류는 수정 칸이 말한다.
  const generalError =
    deleteError ??
    (actionSave?.status === "error" && actionSave.kind !== "update"
      ? actionSave.message
      : null);
  const isCancellation = txn.transactionType === "cancellation";
  const excluded = txn.excludedAt != null;
  const canLink = isCancellation && txn.parentTransactionId == null;
  // 금액 수정은 취소 연결이 없는 단순 거래만(서버 규칙과 일치). 날짜는 항상 가능.
  const canEditAmount =
    txn.cancelledAmount === 0 && txn.parentTransactionId == null;

  // 금액·날짜 인라인 편집 상태(평소엔 읽기, '수정' 탭 시 편집 모드).
  const [editing, setEditing] = useState(false);
  const initialDate = toDateTimeLocal(occurredAt(txn));
  // 날짜·시간 칸은 기기 시간대로 채워지고 상세 머리는 한국 시간이다 — 둘이 다를 때(해외)만 칸 아래에 기준을 알린다.
  const deviceZoneDiffers = !deviceMatchesSeoulTime(new Date(occurredAt(txn)));
  // 금액 칸은 통화의 주 단위로 주고받는다(USD '12.34'). 서버에는 minor units 정수로 보낸다(detail-save.ts).
  const initialAmount = minorToAmountInput(txn.amount, txn.currency);
  const [editAmount, setEditAmount] = useState(initialAmount);
  const [editDate, setEditDate] = useState(initialDate);
  const [editErrors, setEditErrors] = useState<TransactionEditErrors>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const editSession = useRef(createTransactionEditSession());
  const amountInput = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const backHandler = useRef<(source: TransactionDetailBackSource) => void>(
    () => undefined
  );
  useEffect(() => {
    const unregister = registerTransactionDetailBack(window, (source) =>
      backHandler.current(source)
    );
    return () => {
      unregister();
      editSession.current.invalidate();
    };
  }, []);
  const editDirty =
    (canEditAmount &&
      amountInputToMinor(editAmount, txn.currency) !== String(txn.amount)) ||
    editDate !== initialDate;
  const cancelEdit = () => {
    if (editSession.current.pending || busy) return;
    editSession.current.invalidate();
    setEditAmount(initialAmount);
    setEditDate(initialDate);
    setEditErrors({});
    setEditError(null);
    setEditNotice(null);
    setEditing(false);
  };
  const startEdit = () => {
    setEditAmount(initialAmount);
    setEditDate(initialDate);
    setEditErrors({});
    setEditError(null);
    setEditNotice(null);
    setEditing(true);
  };
  const requestClose = () => {
    if (discardOpen) {
      setDiscardOpen(false);
      return;
    }
    if (deleteConfirmOpen) {
      setDeleteConfirmOpen(false);
      return;
    }
    if (editSession.current.pending || busy) {
      setEditNotice("저장 중이에요. 완료될 때까지 잠시 기다려 주세요.");
      return;
    }
    if (editing && editDirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };
  backHandler.current = (source) => {
    if (source === "browser") {
      // popstate already navigated: do not restore a URL or claim an in-flight
      // write was cancelled. Only discard this dialog's response callbacks.
      editSession.current.invalidate();
      onClose();
      return;
    }
    // 폰의 뒤로 버튼은 머리의 '‹ 이전 거래'와 같다 — 다른 거래에서 넘어왔으면 그 거래로 돌아간다.
    if (onBack && !editing && !discardOpen && !deleteConfirmOpen && !busy) {
      onBack();
      return;
    }
    requestClose();
  };
  const saveEdits = async () => {
    if (editSession.current.pending || busy) return;
    const validation = validateTransactionEdit({
      amount: amountInputToMinor(editAmount, txn.currency),
      date: editDate,
      initialAmount: txn.amount,
      initialDate,
      canEditAmount,
    });
    setEditNotice(null);
    setEditError(null);
    if (!validation.ok) {
      setEditErrors(validation.errors);
      (validation.errors.amount ? amountInput : dateInput).current?.focus();
      return;
    }
    setEditErrors({});
    if (Object.keys(validation.patch).length === 0) {
      setEditing(false);
      return;
    }
    setEditSaving(true);
    await editSession.current.save(
      () => onEditFields(validation.patch),
      () => {
        setEditSaving(false);
        setEditing(false);
      },
      (error) => {
        setEditSaving(false);
        setEditNotice(null);
        setEditError(errorMessage(error));
        // Keep both inputs and focusable actions available for a correction/retry.
        (canEditAmount ? amountInput : dateInput).current?.focus();
      }
    );
  };

  // 카테고리를 이 시트에서 바꾼 뒤에만 '앞으로도 이렇게 분류'를 묻는다.
  const [ruleFor, setRuleFor] = useState<{ id: string; name: string } | null>(
    null
  );
  const [ruleState, setRuleState] = useState<"offered" | "saving" | "applied">(
    "offered"
  );
  // 분류 변경이 저장된 뒤(txn.categoryId가 바뀐 뒤)에만 규칙을 저장할 수 있다.
  const ruleReady = ruleFor != null && txn.categoryId === ruleFor.id;
  const applyRuleForMerchant = async () => {
    if (!ruleFor || !ruleReady || busy || ruleState === "saving") return;
    setRuleState("saving");
    try {
      await onApplyCategoryRule(ruleFor.id);
      setRuleState("applied");
    } catch {
      // 오류 문구는 카테고리 줄 아래(rowError)가 말한다.
      setRuleState("offered");
    }
  };
  // 저장 성공 토스트는 화면(page) 쪽 뮤테이션이 호출마다 띄운다 — 상세가 닫혔거나 다른 줄을 저장 중이어도 놓치지 않게.

  // 인라인 '새 카테고리 만들기' 상태.
  const [creatingCategory, setCreatingCategory] = useState(false);
  // 방금 만든 카테고리 — 카테고리 목록을 다시 읽기 전이라 고르기 목록에 아직 없어서, 그동안 이 이름으로 보인다.
  const [createdCategory, setCreatedCategory] = useState<{
    id: string;
    name: string;
  } | null>(null);
  /** 카테고리를 바꾸면 바로 저장하고, 가맹점 검색어가 있으면 '앞으로도 이렇게 분류'를 묻는다. */
  const selectCategory = (value: string) => {
    onChangeCategory(value);
    if (searchTerm) {
      setRuleFor({
        id: value,
        name:
          categoryOptions.find((o) => o.value === value)?.label ??
          "선택한 분류",
      });
      setRuleState("offered");
    }
  };
  // 저장 중인 줄은 고른 값을 먼저 보여 준다 — 끝나면 같은 값이 그대로 남고, 실패하면 원래 값과 오류가 보인다.
  const pendingCategoryId = pendingBody("category")?.categoryId;
  const shownCategoryId =
    pendingCategoryId !== undefined ? pendingCategoryId : txn.categoryId;
  // 고른 값이 목록에 없으면(방금 만든 카테고리) 만든 이름으로, 그것도 모르면 저장하는 동안은 원래 값으로 둔다.
  // 예전에는 그 사이 '미분류'로 보였다(카드 줄은 이미 이렇게 원래 이름으로 돌아간다).
  const categoryLabel =
    categoryOptions.find((o) => o.value === shownCategoryId)?.label ??
    (createdCategory != null && createdCategory.id === shownCategoryId
      ? createdCategory.name
      : pendingCategoryId !== undefined
      ? categoryOptions.find((o) => o.value === txn.categoryId)?.label
      : undefined);
  const pendingCardId = pendingBody("card")?.cardId;
  const shownCardId =
    pendingCardId !== undefined ? pendingCardId : txn.cardId;
  const shownCardLabel =
    shownCardId === txn.cardId
      ? cardLabel
      : shownCardId == null
      ? "카드 미연결"
      : cardOptions.find((o) => o.value === shownCardId)?.label ?? cardLabel;
  const pendingVisibility = pendingBody("visibility")?.visibility;
  const shownVisibility = pendingVisibility ?? txn.visibility;
  const visibilityLabel =
    VISIBILITY_OPTIONS.find((o) => o.value === shownVisibility)?.label ??
    shownVisibility;
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const submitNewCategory = async () => {
    const name = newCategoryName.trim();
    if (!name || categorySaving) return;
    setCategorySaving(true);
    setCategoryError(null);
    try {
      const createdId = await onCreateCategory(name);
      setCreatedCategory({ id: createdId, name });
      setCreatingCategory(false);
      setNewCategoryName("");
      if (merchantSearchTerm(txn)) {
        setRuleFor({ id: createdId, name });
        setRuleState("offered");
      }
    } catch (err) {
      setCategoryError(
        err instanceof Error ? err.message : "카테고리를 만들지 못했어요."
      );
    } finally {
      setCategorySaving(false);
    }
  };

  const merchant = merchantLabel(txn);
  const searchTerm = merchantSearchTerm(txn);
  // 중복 의심이면 서버가 겹친다고 본 짝 결제를 같은 조건으로 찾는다(duplicate-pair.ts).
  // '이 가맹점 최근 결제'(최신 5건)는 표시용이라 짝이 그 안에 있다는 보장이 없다.
  // 찾는 동안(duplicatePairLoading)은 결정 블록이 안내 줄 자리를 잡아 둔다 — 도착할 때 시트가 커지지 않게.
  const { pair: duplicatePair, loading: duplicatePairLoading } =
    useDuplicatePair(txn);
  // 확인할 거래면 금액 아래에서 무엇이 의심스러운지 묻고 같은 무게의 답을 나란히 둔다(decision-copy.ts).
  const decision = reviewDecision({
    status: txn.status,
    transactionType: txn.transactionType,
    excluded,
    hasCard: txn.cardId != null,
    linked: txn.parentTransactionId != null,
    canPickCard: cardOptions.length > 0,
    duplicatePairAt: duplicatePair
      ? formatMonthDayTime(occurredAt(duplicatePair))
      : null,
  });
  const decisionHandlers: Record<
    Exclude<ReviewDecisionAction, "pickCard">,
    () => void
  > = {
    markValid: onMarkValid,
    exclude: onExclude,
    linkCancellation: onOpenLink,
  };
  // 결정 블록이 이미 빼기를 물으면 메뉴에 같은 동작을 두지 않는다. 환불은 메뉴에 두지 않는다 —
  // 빼기는 원래 결제를 못 찾은 '확인 필요' 환불에서만 결정 블록이 묻는다(연결된 환불은 원래 결제 금액에 반영돼 있다).
  const menuOffersExclude =
    !isCancellation && !excluded && !decisionOffersExclude(decision);
  // 이 거래에서 '합계에서 빼기'를 실제로 할 수 있을 때만 삭제 확인이 그 대안을 말한다.
  // 예전 안내는 '⋯ 메뉴의 합계에서 빼기'를 가리켰는데, 취소 기록·이미 뺀 거래에는 그 항목이 없었다.
  const canExclude = menuOffersExclude || decisionOffersExclude(decision);
  const chips = transactionChips(txn);
  const installment =
    txn.installmentMonths && txn.installmentMonths > 1
      ? txn.installmentMonths
      : null;
  const foreign = txn.originalCurrency != null && txn.originalAmount != null;
  const partiallyCancelled = !isCancellation && txn.netAmount !== txn.amount;
  // 자주 쓰지 않거나 되돌리기 어려운 행동은 ⋯ 메뉴에만 둔다(리뉴얼 §3.3 — 위험 행동은 메뉴 안).
  const overflowActions: OverflowAction[] = [
    { label: "금액·날짜 수정", onSelect: startEdit, disabled: busy },
    // 중복이 아닌 이유로 빼는 경우도 있어 '합계에서 빼기'라고만 부른다.
    ...(menuOffersExclude
      ? [
          {
            label: "합계에서 빼기",
            onSelect: onExclude,
            disabled: busy,
          },
        ]
      : []),
    {
      label: "거래 삭제",
      onSelect: () => setDeleteConfirmOpen(true),
      destructive: true,
      disabled: busy,
    },
  ];

  // 카테고리 줄 아래 — 새 카테고리 입력과 '앞으로도 이렇게 분류'는 그 줄의 일이라 바로 밑에서 펼친다
  // (예전에는 목록 아래에 생겨 고른 줄과 떨어져 있었다). 분류 저장이 실패하면 묻지 않고 오류만 보인다.
  const showRulePrompt =
    ruleFor != null && (ruleReady || isSaving("category"));
  const categoryRowError = rowError("category");
  const categoryNotes =
    creatingCategory || showRulePrompt || categoryRowError ? (
      <div className="flex min-w-0 flex-col gap-2">
        {creatingCategory ? (
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 gap-2">
              <Input
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitNewCategory();
                  }
                }}
                placeholder="새 카테고리 이름"
                aria-label="새 카테고리 이름"
                maxLength={20}
                autoFocus
                disabled={categorySaving}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="weak"
                className="h-12 shrink-0"
                onClick={() => void submitNewCategory()}
                disabled={
                  categorySaving ||
                  newCategoryName.trim() === "" ||
                  isSaving("category")
                }
              >
                {categorySaving ? "추가하는 중…" : "추가하기"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-12 shrink-0 px-3"
                onClick={() => {
                  setCreatingCategory(false);
                  setNewCategoryName("");
                  setCategoryError(null);
                }}
                disabled={categorySaving}
              >
                닫기
              </Button>
            </div>
            {categoryError ? (
              <InlineNotice tone="error">{categoryError}</InlineNotice>
            ) : null}
          </div>
        ) : null}
        {showRulePrompt && ruleFor ? (
          <div
            className="bg-muted text-foreground flex flex-col gap-2 rounded-control p-3"
            role="status"
          >
            {ruleState === "applied" ? (
              <p className="text-caption">
                앞으로 들어오는 {merchant} 결제는 &lsquo;{ruleFor.name}
                &rsquo;(으)로 분류해요.
              </p>
            ) : (
              <>
                <p className="text-caption">
                  앞으로 들어오는 {merchant} 결제도 &lsquo;{ruleFor.name}
                  &rsquo;(으)로 분류할까요? 지난 거래는 그대로예요.
                </p>
                <Button
                  type="button"
                  variant="weak"
                  size="sm"
                  className="self-start"
                  disabled={!ruleReady || busy || ruleState === "saving"}
                  onClick={() => void applyRuleForMerchant()}
                >
                  {ruleState === "saving"
                    ? "저장하는 중…"
                    : "앞으로도 이렇게 분류하기"}
                </Button>
              </>
            )}
          </div>
        ) : null}
        {categoryRowError}
      </div>
    ) : undefined;
  const cardHint = ownershipMismatch ? (
    <span role="status" className="text-warning-strong">
      거래 구성원과 카드 소유자가 달라요. 올바른 카드인지 확인해 주세요.
    </span>
  ) : shownCardId == null || txn.status === "pending_review" ? (
    <span>카드에 연결하면 공개 범위가 카드 설정을 따라가요.</span>
  ) : null;

  const overflowMenu = !editing ? (
    <OverflowMenu label="거래 메뉴" actions={overflowActions} />
  ) : null;

  return (
    <Dialog open onOpenChange={(v) => !v && requestClose()}>
      {/* 상세 보기라 바텀 시트다(사용자 결정 2026-11-05). 다른 창은 기본 모양 — sheet-layout.ts 표. */}
      <DialogContent
        layout="sheet"
        className="grid-cols-[minmax(0,1fr)] gap-5 [&>*]:min-w-0"
      >
        <DialogHeader className="gap-1 text-left">
          {/*
            ⋯는 늘 오른쪽 위 X 바로 왼쪽, 같은 높이에 둔다. 둘 사이는 띄운다(pr-12) — 붙어 있으면 메뉴를 누르려다
            시트가 닫혔다. 최근 결제·겹친 결제에서 넘어왔으면 맨 위 줄이 '‹ 이전 거래 …… ⋯ X'가 되고 제목은 그
            아래에서 전체 폭을 쓴다. 예전에는 ⋯가 제목 줄에 남아 X 없는 자리를 비워 둔 채 어중간하게 떠 있었다
            (사용자 지적 2026-11-09 '... 위치가 이상함').
          */}
          {onBack ? (
            <div className="-mt-3 flex min-w-0 items-center justify-between gap-1 pr-12">
              <button
                type="button"
                onClick={onBack}
                disabled={busy}
                className="text-primary text-body focus-visible:outline-ring -ml-2 inline-flex min-h-11 items-center gap-0.5 rounded-control pr-2 font-medium focus-visible:outline-2 active:opacity-60 disabled:opacity-50"
              >
                <ChevronLeft aria-hidden="true" className="size-5" />
                이전 거래
              </button>
              {overflowMenu ? (
                <div className="shrink-0">{overflowMenu}</div>
              ) : null}
            </div>
          ) : null}
          <div
            className={cn(
              "flex min-w-0 items-start gap-1",
              onBack ? null : "pr-12",
            )}
          >
            <DialogTitle className="text-heading min-w-0 flex-1 break-words">
              {merchant}
            </DialogTitle>
            {!onBack && overflowMenu ? (
              <div className="-my-2 shrink-0">{overflowMenu}</div>
            ) : null}
          </div>
          <DialogDescription className="text-caption break-words">
            {formatMonthDayTime(occurredAt(txn))}
          </DialogDescription>
        </DialogHeader>

        {/* 금액이 먼저 — 무엇을 얼마에 결제했나. 확인이 필요한 거래는 할 일을 바로 아래에 둔다. */}
        {editing ? (
          <section
            aria-labelledby={`${inputId}-heading`}
            className="bg-muted flex min-w-0 flex-col gap-2 rounded-card p-4"
          >
            <h3
              className="text-caption text-muted-foreground"
              id={`${inputId}-heading`}
            >
              금액·날짜 수정
            </h3>
            <Label htmlFor={`${inputId}-amount`}>금액</Label>
            <AmountInput
              id={`${inputId}-amount`}
              ref={amountInput}
              currency={txn.currency}
              aria-invalid={Boolean(editErrors.amount)}
              aria-describedby={
                editErrors.amount ? `${inputId}-amount-error` : undefined
              }
              value={editAmount}
              disabled={busy || !canEditAmount}
              className="bg-background"
              onValueChange={(raw) => {
                setEditAmount(raw);
                setEditErrors((errors) => ({ ...errors, amount: undefined }));
                setEditError(null);
              }}
            />
            {editErrors.amount ? (
              <p
                id={`${inputId}-amount-error`}
                role="alert"
                className="text-destructive text-caption"
              >
                {editErrors.amount}
              </p>
            ) : null}
            <Label htmlFor={`${inputId}-date`}>날짜·시간</Label>
            <Input
              id={`${inputId}-date`}
              ref={dateInput}
              type="datetime-local"
              aria-invalid={Boolean(editErrors.occurredAt)}
              aria-describedby={
                [
                  editErrors.occurredAt ? `${inputId}-date-error` : null,
                  deviceZoneDiffers ? `${inputId}-date-zone` : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              value={editDate}
              disabled={busy}
              className="min-w-0 w-full bg-background"
              onChange={(e) => {
                setEditDate(e.target.value);
                setEditErrors((errors) => ({
                  ...errors,
                  occurredAt: undefined,
                }));
                setEditError(null);
              }}
            />
            {editErrors.occurredAt ? (
              <p
                id={`${inputId}-date-error`}
                role="alert"
                className="text-destructive text-caption"
              >
                {editErrors.occurredAt}
              </p>
            ) : null}
            {deviceZoneDiffers ? (
              <p
                id={`${inputId}-date-zone`}
                className="text-muted-foreground text-caption"
              >
                {DEVICE_TIME_ZONE_NOTE}
              </p>
            ) : null}
            {editError ? (
              <InlineNotice tone="error">{editError}</InlineNotice>
            ) : null}
            {!canEditAmount ? (
              <p className="text-muted-foreground text-caption">
                {isCancellation
                  ? "원래 결제에 연결된 환불은 금액을 바꿀 수 없어요. 날짜만 수정돼요."
                  : "환불이 연결된 결제는 금액을 바꿀 수 없어요. 날짜만 수정돼요."}
              </p>
            ) : null}
            <div
              className="sticky bottom-0 flex justify-end gap-2 bg-muted py-2"
              aria-busy={editSaving}
            >
              <Button
                type="button"
                variant="ghost"
                className="min-w-20"
                disabled={busy}
                onClick={cancelEdit}
              >
                닫기
              </Button>
              <Button
                type="button"
                className="min-w-20"
                disabled={busy || !editDirty}
                onClick={() => void saveEdits()}
              >
                {editSaving ? "저장하는 중…" : "저장하기"}
              </Button>
            </div>
          </section>
        ) : (
          <section
            aria-label={isCancellation ? "환불 금액" : "결제 금액"}
            className="flex min-w-0 flex-col gap-3"
          >
            <p
              className={cn(
                "text-display break-all tabular-nums",
                excluded && "text-muted-foreground line-through"
              )}
            >
              {isCancellation ? (
                <Money amount={-txn.amount} currency={txn.currency} />
              ) : (
                <Money amount={txn.netAmount} currency={txn.currency} />
              )}
            </p>
            {/*
              상태만 칩으로 둔다(목록과 같은 이름 — list-status.ts). 할부·해외 결제는 아래 정보 줄이 금액까지
              더 자세히 말해서 칩으로 되풀이하지 않는다.
            */}
            {chips.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <TxnChips chips={chips} />
              </div>
            ) : null}
            {decision ? (
              <div
                role="group"
                aria-labelledby={`${inputId}-decision`}
                aria-busy={busy || undefined}
                className="bg-muted flex min-w-0 flex-col gap-3 rounded-card p-4"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p
                    id={`${inputId}-decision`}
                    className="text-body font-semibold break-words"
                  >
                    {decision.question}
                  </p>
                  {decision.hint ? (
                    <p className="text-caption text-muted-foreground break-words">
                      {decision.hint}
                    </p>
                  ) : null}
                  {/* 짝 결제로 가는 이동은 답이 아니라 글자 버튼이다 — 아래 두 답과 무게가 다르다. */}
                  {decision.pairLabel && duplicatePair ? (
                    <Button
                      type="button"
                      variant="link"
                      className={cn(
                        "h-11 gap-1 self-start px-0 has-[>svg]:px-0",
                        openingId === duplicatePair.id && "opacity-60"
                      )}
                      disabled={busy}
                      {...pressPrefetchHandlers(pairPress, () =>
                        onPrefetchTransaction(duplicatePair)
                      )}
                      onClick={(event) =>
                        onOpenTransaction(duplicatePair, event.detail === 0)
                      }
                    >
                      {decision.pairLabel}
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  ) : duplicatePairLoading ? (
                    // 짝 결제를 찾는 동안 안내 줄(폰에서 두 줄, 넓은 화면 한 줄)과 '그 결제 보기' 자리를 잡아 둔다 —
                    // 도착할 때 아래 답 버튼이 밀려 내려가며 시트가 커지지 않게. 내용 없는 회색 막대뿐이고, 짝이 없으면 그때 줄어든다.
                    <div aria-hidden="true" className="flex min-w-0 flex-col gap-1">
                      <div className="text-caption flex flex-col">
                        <div className="flex h-lh items-center">
                          <Skeleton className="h-3 w-full" />
                        </div>
                        <div className="flex h-lh items-center sm:hidden">
                          <Skeleton className="h-3 w-2/3" />
                        </div>
                      </div>
                      <div className="flex h-11 items-center">
                        <Skeleton className="h-4 w-20" />
                      </div>
                    </div>
                  ) : null}
                </div>
                {/* 같은 무게의 답은 같은 모양으로 나란히 둔다. 채움 버튼은 두지 않는다(§3.3). */}
                <div
                  className={cn(
                    "grid gap-2",
                    decision.actions.length > 1 && "grid-cols-2"
                  )}
                >
                  {decision.actions.map(({ action, label }) => {
                    const answer = {
                      type: "button" as const,
                      variant: "weak" as const,
                      // 폭이 좁은 폰에서 답이 길면 잘리지 않고 두 줄로 내려간다.
                      className: "h-auto min-h-11 w-full py-2 whitespace-normal",
                      disabled: busy,
                    };
                    return action === "pickCard" ? (
                      <PickerMenu
                        key={action}
                        label="카드"
                        options={cardOptions}
                        value={txn.cardId ?? null}
                        disabled={pickCardLocked}
                        onSelect={(cardId) => {
                          if (!pickCardLocked) onResolveCard(cardId);
                        }}
                        trigger={
                          <Button {...answer} disabled={pickCardLocked}>
                            {label}
                          </Button>
                        }
                      />
                    ) : (
                      <Button
                        key={action}
                        {...answer}
                        onClick={decisionHandlers[action]}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {/*
              확인이 필요한 취소는 위 결정 블록이 '원래 결제 고르기'를 묻는다. 합계에서 뺀 환불은 여기서 연결하지 않는다 —
              연결하면 원래 결제 금액에 반영돼 합계에 잡히는데 이 기록은 '합계 제외'로 남아 화면이 서로 다른 말을 한다.
              아래 '합계에 다시 넣기'로 되돌린 뒤에 원래 결제를 고른다.
            */}
            {canLink && decision == null && !excluded ? (
              <Button
                variant="weak"
                className="w-full"
                disabled={busy}
                onClick={onOpenLink}
              >
                원래 결제와 연결하기
              </Button>
            ) : null}
            {/* 원래 결제를 못 찾아 뺀 환불도 되돌릴 수 있어야 한다. 연결된 환불은 빼는 길이 없어 그대로 둔다. */}
            {(!isCancellation || canLink) && excluded ? (
              <Button
                variant="weak"
                className="w-full"
                disabled={busy}
                onClick={onInclude}
              >
                합계에 다시 넣기
              </Button>
            ) : null}
            {/* 확인·빼기·다시 넣기·연결·삭제가 실패하면 그 버튼 바로 아래에 말한다. */}
            {generalError ? (
              <InlineNotice tone="error">{generalError}</InlineNotice>
            ) : null}
          </section>
        )}

        {editNotice ? (
          <p
            role="status"
            aria-live="polite"
            className="text-muted-foreground text-caption"
          >
            {editNotice}
          </p>
        ) : null}

        {/* 결제 정보 — 문장 대신 훑어보는 키-값 */}
        {/*
          정보·설정 한 목록(2026-11-05 사용자 지적으로 '분류' 칸 묶음을 합쳤다). 바꾸는 줄은 눌러서
          드롭다운을 열고, 고르면 바로 저장된다. 가장 자주 바꾸는 카테고리를 결제자 바로 아래에 둔다.
          저장하는 동안은 그 줄의 값 자리에만 진행 표시가 돌고, 실패하면 그 줄 아래에 오류가 붙는다.
        */}
        <FieldList>
          <FieldRow label="결제자" value={memberName} />
          <FieldRow
            label="카테고리"
            value={
              <SavingValue saving={isSaving("category")}>
                {categoryLabel ?? "미분류"}
              </SavingValue>
            }
            muted={categoryLabel == null}
            disabled={categoryLocked}
            menu={{
              label: "카테고리",
              options: categoryOptions,
              value: shownCategoryId,
              onSelect: (value) => {
                if (!categoryLocked) selectCategory(value);
              },
              footer: {
                label: "+ 새 카테고리 만들기",
                onSelect: () => setCreatingCategory(true),
              },
            }}
          >
            {categoryNotes}
          </FieldRow>
          <FieldRow
            label="카드"
            value={
              <SavingValue saving={isSaving("card")}>
                {shownCardLabel}
              </SavingValue>
            }
            muted={shownCardId == null}
            disabled={cardLocked}
            menu={{
              label: "카드",
              options: [{ value: CARD_NONE, label: "카드 미연결" }, ...cardOptions],
              value: shownCardId ?? CARD_NONE,
              onSelect: (value) => {
                if (!cardLocked) onChangeCard(value);
              },
            }}
          >
            {cardHint || rowError("card") ? (
              <div className="flex min-w-0 flex-col gap-2">
                {cardHint}
                {rowError("card")}
              </div>
            ) : undefined}
          </FieldRow>
          <FieldRow
            label="공개 범위"
            value={
              <SavingValue saving={isSaving("visibility")}>
                {visibilityLabel}
              </SavingValue>
            }
            disabled={visibilityLocked}
            menu={{
              label: "공개 범위",
              options: VISIBILITY_OPTIONS,
              value: shownVisibility,
              onSelect: (value) => {
                if (!visibilityLocked) onChangeVisibility(value);
              },
            }}
          >
            {rowError("visibility") ?? undefined}
          </FieldRow>
          <FieldRow
            label="메모"
            value={
              <SavingValue saving={isSaving("memo")}>
                {txn.memo ? (
                  <span className="line-clamp-2">{txn.memo}</span>
                ) : (
                  "남기기"
                )}
              </SavingValue>
            }
            muted={!txn.memo}
            disabled={deleting || isSaving("memo")}
            onClick={onOpenMemo}
          >
            {rowError("memo") ?? undefined}
          </FieldRow>
          {installment ? (
            <FieldRow label="할부" value={`${installment}개월`}>
              {/*
                할부는 **승인월에 전액** 계상된다. `installmentMonths`는 보관만 되고
                집계·예산·정기지출 어디에서도 월 분할에 쓰이지 않는다
                (`transaction-money.service.ts`의 metadata pass-through).

                실측(2026-07): 표시 총액 752,721원 중 198,290원(26.3%)이 3개월 할부
                전액이었다. 그 사실을 말하지 않으면 카드 명세서와 대조할 때 어느 달도
                맞지 않고, 사용자는 앱이 틀렸다고 판단한다. 실제 월 분할은 금액 계약
                (ADR-0027)을 건드리므로 별건이고, 여기서는 **정직하게 말하는 것**만 한다.
              */}
              이 달 합계에는 전액 {formatMoney(txn.netAmount, txn.currency)}이
              들어가 있어요 (월{" "}
              {formatMoney(
                Math.round(txn.netAmount / installment),
                txn.currency
              )}
              씩).
            </FieldRow>
          ) : null}
          {foreign ? (
            <FieldRow
              label="해외 결제"
              value={foreignAmountLabel(
                txn.originalAmount as number,
                txn.originalCurrency as string
              )}
            >
              <TransactionFxDetails
                currency={txn.originalCurrency as string}
                exchangeRate={txn.exchangeRate}
                fx={txn.fx}
              />
            </FieldRow>
          ) : null}
          {partiallyCancelled ? (
            <FieldRow
              label="취소된 금액"
              value={`${formatMoney(
                txn.cancelledAmount,
                txn.currency
              )} (원래 ${formatMoney(txn.amount, txn.currency)})`}
            />
          ) : null}
          {/* 가족에게 물어보기(확인 요청) — 자기 훅을 쓰는 독립 컴포넌트가 이 목록의 한 줄을 그린다 */}
          <ReviewRequestAction txn={txn} disabled={deleting} />
        </FieldList>

        {searchTerm ? (
          <MerchantHistory
            txn={txn}
            searchTerm={searchTerm}
            disabled={busy || editing}
            openingId={openingId}
            onOpen={onOpenTransaction}
            onPrefetch={onPrefetchTransaction}
          />
        ) : null}

        {/* 하드 삭제(되돌리기 불가) — ⋯ 메뉴에서 열고 액션 시트로 한 번 더 확인한다 */}
        <AlertDialog
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>거래를 삭제할까요?</AlertDialogTitle>
              <AlertDialogDescription>
                {merchant} {formatMoney(txn.amount, txn.currency)} 거래를
                삭제하면 되돌릴 수 없어요.
                {/* 빼기를 실제로 할 수 있는 거래에서만 대안을 말하고, 그 버튼을 이 자리에 둔다. */}
                {canExclude ? " 기록은 남기고 합계에서만 뺄 수도 있어요." : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>닫기</AlertDialogCancel>
              {canExclude ? (
                <Button
                  type="button"
                  variant="weak"
                  onClick={() => {
                    setDeleteConfirmOpen(false);
                    onExclude();
                  }}
                >
                  합계에서 빼기
                </Button>
              ) : null}
              <AlertDialogAction
                variant="destructive"
                onClick={onDelete}
              >
                삭제하기
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
          <AlertDialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (canEditAmount ? amountInput : dateInput).current?.focus();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>수정 내용을 버릴까요?</AlertDialogTitle>
              <AlertDialogDescription>
                아직 저장하지 않은 금액과 날짜가 있어요.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              {/* 닫을지 묻는 확인에서 남는 쪽을 '닫기'라고 하면 뜻이 거꾸로 읽힌다 — '계속 수정하기'. */}
              <AlertDialogCancel>계속 수정하기</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  editSession.current.invalidate();
                  setDiscardOpen(false);
                  onClose();
                }}
              >
                버리기
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Memo modal                                                                 */
/* -------------------------------------------------------------------------- */

/** Nested transaction dialogs take native back before the detail behind them. */
function useTransactionModalBack(onClose: () => void, busy: boolean) {
  const handler = useRef<(source: TransactionDetailBackSource) => void>(
    () => undefined
  );
  handler.current = (source) => {
    if (source === "browser" || !busy) onClose();
  };
  useEffect(
    () =>
      registerTransactionDetailBack(window, (source) =>
        handler.current(source)
      ),
    []
  );
}

function MemoModal({
  txn,
  busy,
  error,
  onClose,
  onSave,
}: Readonly<{
  txn: TransactionSummary;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (memo: string) => void;
}>) {
  useTransactionModalBack(onClose, busy);
  const [memo, setMemo] = useState(txn.memo ?? "");
  const memoInput = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent
        // 칸이 하나뿐인 창이라 열리면 바로 그 칸에 커서를 둔다 — 창에 포커스가 가면 한 번 더 눌러야 키보드가 떴다.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = memoInput.current;
          if (!input) return;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }}
      >
        <DialogHeader>
          <DialogTitle>메모 남기기</DialogTitle>
          <DialogDescription>
            {merchantLabel(txn)} 거래에 기억할 내용을 적어 주세요
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="memo-input" className="sr-only">
            메모
          </Label>
          <Textarea
            id="memo-input"
            ref={memoInput}
            rows={4}
            maxLength={1000}
            value={memo}
            placeholder="예: 아이 생일 케이크, 부모님 선물이었어요"
            aria-invalid={error ? true : undefined}
            onChange={(e) => setMemo(e.target.value)}
          />
          {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            variant="default"
            className="w-full"
            onClick={() => onSave(memo)}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? "저장하는 중…" : "저장하기"}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={onClose}
            disabled={busy}
          >
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Link-cancellation modal                                                    */
/* -------------------------------------------------------------------------- */

function LinkCancellationModal({
  cancellation,
  busy,
  error,
  onClose,
  onConfirm,
}: Readonly<{
  cancellation: TransactionSummary;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (approvalTransactionId: string) => void;
}>) {
  useTransactionModalBack(onClose, busy);
  const { authedFetch } = useAuth();
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");

  /*
   * 후보는 **서버가 좁혀 준다**(통화 · 잔액 ≥ 취소액 · 취소보다 앞선 승인 · 공개범위).
   *
   * 이전에는 `list({ type:"approval", limit:100 })`로 최근 100건을 받아 여기서 걸렀다.
   * 서버의 `MAX_LIMIT=100`이 상한이라 limit을 올려 우회할 수도 없어서, **승인이 100건을
   * 넘긴 뒤로는 오래된 결제에 연결할 방법이 아예 없었다**(실측 136건). 자격 조건을
   * 클라이언트에 다시 두지 않는 이유도 같다 — 규칙이 두 벌이면 "보이는데 저장하면
   * 거부되는" 후보가 생긴다.
   */
  const candidatesQuery = useQuery({
    queryKey: ["cancellation-candidates", cancellation.id],
    queryFn: () =>
      authedFetch((token) =>
        api.transactions.cancellationCandidates(token, cancellation.id)
      ),
  });

  const candidates = candidatesQuery.data?.items ?? [];

  // 표시용 좁히기(자격 판정이 아니다). 후보가 많아도 사용자가 금액·가맹점·날짜로 찾을
  // 수 있어야 한다 — 목록만 길게 뿌리면 100건 상한과 실질적으로 같아진다.
  // 날짜는 화면에 보이는 글자('8월 3일')로 찾는다.
  const visible = candidates.filter((a) =>
    matchesCandidateSearch(
      {
        merchant: merchantLabel(a),
        amount: a.amount,
        remaining: a.amount - a.cancelledAmount,
        dateLabel: formatMonthDay(a.approvedAt ?? a.createdAt),
      },
      search
    )
  );

  // 고른 뒤 검색어를 바꿔 그 후보가 사라지면 선택을 버린다 — 안 그러면 화면에 보이지
  // 않는 승인에 연결 버튼이 살아 있어 엉뚱한 결제에 취소가 붙는다.
  const effectiveSelected = retainSelection(
    selected,
    visible.map((a) => a.id)
  );
  const refund = formatMoney(cancellation.amount, cancellation.currency);

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>어떤 결제를 취소한 건가요?</DialogTitle>
          <DialogDescription>
            환불 {refund}이 나온 결제를 골라 주세요. 연결하면 그 결제 금액에서
            환불만큼 빠져요.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          {candidatesQuery.isLoading ? (
            <ListLoading rows={3} label="결제를 불러오는 중이에요." />
          ) : candidatesQuery.isError ? (
            /* "불러오지 못했어요"와 "연결할 결제가 없어요"는 다른 사실이다 —
               실패를 빈 목록으로 보여 주면 사용자가 없는 것으로 오해한다. */
            <ErrorState
              message={`결제를 불러오지 못했어요: ${errorMessage(
                candidatesQuery.error
              )}`}
              onRetry={() => void candidatesQuery.refetch()}
              retrying={candidatesQuery.isFetching}
              className="py-6"
            />
          ) : candidates.length === 0 ? (
            <div className="flex flex-col gap-1 py-6 text-center">
              <p className="text-body text-muted-foreground">
                연결할 수 있는 결제가 없어요
              </p>
              {/* 왜 없는지까지 알려 준다 — 조건을 모르면 사용자가 할 수 있는 일이 없다. */}
              <p className="text-caption text-muted-foreground">
                환불 {refund} 이상 남은 결제가 아직 없어요. 원래 결제 문자가
                아직 들어오지 않았을 수도 있어요.
              </p>
            </div>
          ) : (
            <>
              {/* 후보가 많을 때 훑지 않고 찾을 수 있어야 한다. 서버가 상한 없이 전량을
                  주므로 이 입력은 왕복 없이 즉시 좁힌다(자격 판정이 아니다). */}
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="가맹점 · 금액 · 날짜로 찾기"
                  aria-label="결제 찾기"
                  className="pl-11 pr-12"
                />
                {search !== "" ? (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="검색어 지우기"
                    className="text-muted-foreground hover:text-foreground focus-visible:outline-ring absolute top-1/2 right-1 flex size-11 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 active:text-foreground"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>

              {visible.length === 0 ? (
                /* 후보는 있는데 검색어가 걸러 낸 상태. 위의 "후보 0건"과 다른 사실이다. */
                <p className="text-body text-muted-foreground py-4 text-center">
                  검색어와 맞는 결제가 없어요. 검색어를 지우면 결제{" "}
                  {candidates.length}건을 모두 볼 수 있어요.
                </p>
              ) : (
                <>
                  {/*
                    검색칸 → 고르기 창(Select) 두 단계였고, 옵션 한 줄에 '가맹점 · 남은 금액 · 날짜 · 합계 제외됨'을
                    몰아넣어 입력 폼처럼 보였다(HIG 검수 3·4단계). 이제 검색칸 바로 아래 목록에서 한 줄을 누르면
                    고른 줄에 체크가 붙는다 — 가맹점·날짜 / 남은 금액.
                  */}
                  <div
                    role="radiogroup"
                    aria-label="원래 결제"
                    className="divide-border/60 -mx-1 flex max-h-80 min-w-0 flex-col divide-y overflow-y-auto overscroll-contain"
                  >
                    {visible.map((a) => {
                      const checked = a.id === effectiveSelected;
                      const remaining = a.amount - a.cancelledAmount;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          disabled={busy}
                          onClick={() => setSelected(a.id)}
                          className={cn(
                            "focus-visible:outline-ring flex min-h-14 w-full min-w-0 items-center gap-3 rounded-control px-1 py-2 text-left focus-visible:outline-2 active:bg-muted disabled:opacity-50",
                            checked && "bg-primary/10"
                          )}
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-body truncate font-semibold">
                              {merchantLabel(a)}
                            </span>
                            <span className="text-caption text-muted-foreground flex min-w-0 flex-wrap items-center gap-1.5">
                              {formatMonthDay(a.approvedAt ?? a.createdAt)}
                              {a.excludedAt ? (
                                <StatusChip>합계 제외</StatusChip>
                              ) : null}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                            <Money
                              amount={remaining}
                              currency={a.currency}
                              className="text-body font-semibold"
                            />
                            {remaining !== a.amount ? (
                              <span className="text-caption text-muted-foreground">
                                남은 금액
                              </span>
                            ) : null}
                          </span>
                          <Check
                            aria-hidden="true"
                            className={cn(
                              "text-primary size-5 shrink-0",
                              !checked && "invisible"
                            )}
                          />
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-caption text-muted-foreground">
                    {visible.length !== candidates.length
                      ? `결제 ${candidates.length}건 중 ${visible.length}건`
                      : `결제 ${visible.length}건`}
                  </p>
                </>
              )}
            </>
          )}
          {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            variant="default"
            className="w-full"
            onClick={() => onConfirm(effectiveSelected)}
            disabled={busy || effectiveSelected === ""}
            aria-busy={busy || undefined}
          >
            {busy ? "연결하는 중…" : "연결하기"}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={onClose}
            disabled={busy}
          >
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
