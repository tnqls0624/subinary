"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 거래 목록/관리 페이지 (Phase 5 §6.2 P7)
 *
 * 필터 바(기간 month / 구성원 / 카드 / 카테고리 / 타입 / 상태) + cursor 페이지네이션
 * 테이블(가맹점 / 금액 / 카테고리 / 구성원 / 카드 / 상태 / 공개범위 / 작업).
 * 행 작업: 카테고리 변경(select, 툴바 applyRule 토글), 공개범위 변경,
 * mark-duplicate / mark-valid, 메모(모달), 취소연결(모달).
 *
 * - 모든 계산/집계는 서버(SQL)에서 끝났다고 가정 — 여기선 표시/편집만 담당한다.
 * - 타인 summary_only(masked) 항목은 가맹점을 '(비공개)'로 표기하고 편집을 막는다.
 * - 권한은 서버(서비스 계층)가 강제하며, 실패 시 배너로 메시지를 노출한다.
 * ------------------------------------------------------------------------- */
import { useMemo, useState, type ChangeEvent } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type {
  CardVisibility,
  TransactionSummary,
  TransactionUpdateRequest,
} from "@family/contracts";

import {
  Button,
  Modal,
  Money,
  Select,
  StatusBadge,
  Table,
  type SelectOption,
  type TableColumn,
} from "@/components";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { formatDate, formatKRW, formatMonth, currentMonth } from "@/lib/format";
import { useHousehold } from "@/lib/household-context";
import {
  useCardList,
  useCategoryList,
  useHouseholdMembers,
  useTransactions,
} from "@/lib/queries";

/* -------------------------------------------------------------------------- */
/* Constants / labels                                                         */
/* -------------------------------------------------------------------------- */

const PAGE_SIZE = 20;

/** 거래 유형 라벨(승인/취소). */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  approval: "승인",
  cancellation: "취소",
};

/** 공개범위 라벨. */
const VISIBILITY_LABELS: Readonly<Record<CardVisibility, string>> = {
  private: "비공개",
  household: "가족 공개",
  summary_only: "요약만",
};

/** 유형 필터 옵션. */
const TYPE_OPTIONS: ReadonlyArray<SelectOption> = [
  { value: "approval", label: "승인" },
  { value: "cancellation", label: "취소" },
];

/** 상태 필터 옵션(DB txnStatus 5종). */
const STATUS_OPTIONS: ReadonlyArray<SelectOption> = [
  { value: "approved", label: "승인" },
  { value: "partially_cancelled", label: "부분취소" },
  { value: "cancelled", label: "취소" },
  { value: "pending_review", label: "확인필요" },
  { value: "duplicate_suspected", label: "중복의심" },
];

/** 공개범위 편집 옵션. */
const VISIBILITY_OPTIONS: ReadonlyArray<SelectOption> = (
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
  | { kind: "linkCancellation"; id: string; approvalTransactionId: string };

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM` → Asia/Seoul 월 경계 [월초, 다음달초)의 ISO 문자열. */
function monthRange(month: string): { from?: string; to?: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return {};
  const year = Number(match[1]);
  const mon = Number(match[2]);
  // Asia/Seoul은 DST 없는 고정 +09:00 → 오프셋을 명시해 안전하게 경계를 만든다.
  const from = `${match[1]}-${match[2]}-01T00:00:00+09:00`;
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const to = `${nextYear}-${String(nextMon).padStart(2, "0")}-01T00:00:00+09:00`;
  return { from, to };
}

/** 현재월부터 과거로 `count`개월(YYYY-MM) 목록. */
function recentMonths(count: number): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(currentMonth());
  if (!match) return [];
  let year = Number(match[1]);
  let mon = Number(match[2]);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`${year}-${String(mon).padStart(2, "0")}`);
    mon -= 1;
    if (mon === 0) {
      mon = 12;
      year -= 1;
    }
  }
  return out;
}

/** 가맹점 표시명(masked → '(비공개)', 미확인 → '미확인 가맹점'). */
function merchantLabel(txn: TransactionSummary): string {
  if (txn.masked) return "(비공개)";
  return txn.merchantNormalized ?? txn.merchantRaw ?? "미확인 가맹점";
}

/** ApiError면 서버 메시지를, 아니면 일반 메시지를 반환한다. */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "작업에 실패했습니다.";
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function TransactionsPage() {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const queryClient = useQueryClient();

  // --- 필터 상태 ---
  const [month, setMonth] = useState<string>(currentMonth());
  const [memberId, setMemberId] = useState("");
  const [cardId, setCardId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  /** 인라인 카테고리 변경 시 merchant_category_rules로 저장할지(applyRule). */
  const [applyRule, setApplyRule] = useState(false);

  // --- cursor 페이지네이션(커서 히스토리 + 현재 인덱스) ---
  const [pageStack, setPageStack] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [pageIndex, setPageIndex] = useState(0);
  const cursor = pageStack[pageIndex];

  const resetPage = () => {
    setPageStack([undefined]);
    setPageIndex(0);
  };

  // 필터 변경 시 항상 첫 페이지로 되돌린다.
  const bindFilter =
    (setter: (value: string) => void) =>
    (event: ChangeEvent<HTMLSelectElement>) => {
      setter(event.target.value);
      resetPage();
    };

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

  const cardById = useMemo(() => {
    const map = new Map<string, { alias: string; issuer: string }>();
    for (const c of cards) map.set(c.id, { alias: c.alias, issuer: c.issuer });
    return map;
  }, [cards]);

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  const memberOptions: SelectOption[] = members
    .filter((m) => m.status === "active")
    .map((m) => ({ value: m.memberId, label: m.name }));
  const cardOptions: SelectOption[] = cards.map((c) => ({
    value: c.id,
    label: `${c.alias} · ${c.issuer}`,
  }));
  const categoryFilterOptions: SelectOption[] = categories.map((c) => ({
    value: c.id,
    label: c.name,
  }));
  const monthOptions: SelectOption[] = recentMonths(12).map((m) => ({
    value: m,
    label: formatMonth(m),
  }));

  // --- 목록 쿼리 ---
  const { from, to } = useMemo(() => monthRange(month), [month]);
  const filters = useMemo(
    () => ({
      memberId: memberId || undefined,
      cardId: cardId || undefined,
      categoryId: categoryId || undefined,
      type: type || undefined,
      status: status || undefined,
      from,
      to,
      limit: PAGE_SIZE,
      cursor: cursor || undefined,
    }),
    [memberId, cardId, categoryId, type, status, from, to, cursor],
  );
  const listQuery = useTransactions(filters);

  const items = listQuery.data?.items ?? [];
  const nextCursor = listQuery.data?.nextCursor ?? null;
  const canPrev = pageIndex > 0;
  const canNext = nextCursor != null;

  const goNext = () => {
    if (nextCursor == null) return;
    setPageStack((prev) => [...prev.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((i) => i + 1);
  };
  const goPrev = () => setPageIndex((i) => Math.max(0, i - 1));

  // --- 뮤테이션(행 작업) ---
  const [actionError, setActionError] = useState<string | null>(null);
  const [memoTarget, setMemoTarget] = useState<TransactionSummary | null>(null);
  const [linkTarget, setLinkTarget] = useState<TransactionSummary | null>(null);

  const mutation = useMutation({
    mutationFn: (action: RowAction): Promise<TransactionSummary> =>
      authedFetch((token) => {
        switch (action.kind) {
          case "update":
            return api.transactions.update(token, action.id, action.body);
          case "markDuplicate":
            return api.transactions.markDuplicate(token, action.id);
          case "markValid":
            return api.transactions.markValid(token, action.id);
          case "linkCancellation":
            return api.transactions.linkCancellation(token, action.id, {
              approvalTransactionId: action.approvalTransactionId,
            });
          default: {
            const exhaustive: never = action;
            throw new Error(`unknown action: ${JSON.stringify(exhaustive)}`);
          }
        }
      }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const busyId = mutation.isPending ? (mutation.variables?.id ?? null) : null;

  const changeCategory = (txn: TransactionSummary, nextCategoryId: string) => {
    if (nextCategoryId === "" || nextCategoryId === txn.categoryId) return;
    mutation.mutate({
      kind: "update",
      id: txn.id,
      body: { categoryId: nextCategoryId, applyRule },
    });
  };

  const changeVisibility = (
    txn: TransactionSummary,
    nextVisibility: string,
  ) => {
    if (nextVisibility === txn.visibility) return;
    mutation.mutate({
      kind: "update",
      id: txn.id,
      body: { visibility: nextVisibility as CardVisibility },
    });
  };

  const saveMemo = (txn: TransactionSummary, memo: string) => {
    mutation.mutate(
      { kind: "update", id: txn.id, body: { memo } },
      { onSuccess: () => setMemoTarget(null) },
    );
  };

  const confirmLink = (txn: TransactionSummary, approvalId: string) => {
    mutation.mutate(
      {
        kind: "linkCancellation",
        id: txn.id,
        approvalTransactionId: approvalId,
      },
      { onSuccess: () => setLinkTarget(null) },
    );
  };

  // --- 테이블 컬럼 ---
  const columns: ReadonlyArray<TableColumn<TransactionSummary>> = [
    {
      key: "merchant",
      header: "가맹점",
      render: (txn) => (
        <div>
          <div className={txn.masked ? "text-subtle" : undefined}>
            {merchantLabel(txn)}
          </div>
          <div className="stat-sub">
            {formatDate(txn.approvedAt ?? txn.cancelledAt ?? txn.createdAt, {
              dateOnly: true,
            })}
            {txn.installmentMonths
              ? ` · ${txn.installmentMonths}개월 할부`
              : ""}
          </div>
        </div>
      ),
    },
    {
      key: "amount",
      header: "금액",
      align: "right",
      render: (txn) =>
        txn.transactionType === "cancellation" ? (
          <span className="money money-muted">-{formatKRW(txn.amount)}</span>
        ) : (
          <div>
            <Money amount={txn.amount} />
            {txn.netAmount !== txn.amount ? (
              <div className="stat-sub">순 {formatKRW(txn.netAmount)}</div>
            ) : null}
          </div>
        ),
    },
    {
      key: "category",
      header: "카테고리",
      render: (txn) => {
        if (txn.masked) {
          return (
            <span className="text-subtle">
              {txn.categoryId
                ? (categoryNameById.get(txn.categoryId) ?? "미분류")
                : "미분류"}
            </span>
          );
        }
        return (
          <Select
            aria-label="카테고리 변경"
            options={categoryFilterOptions}
            placeholder="미분류"
            value={txn.categoryId ?? ""}
            disabled={busyId === txn.id}
            onChange={(e) => changeCategory(txn, e.target.value)}
          />
        );
      },
    },
    {
      key: "member",
      header: "구성원",
      render: (txn) => memberNameById.get(txn.memberId) ?? "구성원",
    },
    {
      key: "card",
      header: "카드",
      render: (txn) => {
        if (!txn.cardId) return <span className="text-subtle">미연결</span>;
        const card = cardById.get(txn.cardId);
        return card ? card.alias : "카드";
      },
    },
    {
      key: "status",
      header: "상태",
      render: (txn) => (
        <div className="row" style={{ gap: 6 }}>
          <span className="text-subtle" style={{ fontSize: "0.78rem" }}>
            {TYPE_LABELS[txn.transactionType] ?? txn.transactionType}
          </span>
          <StatusBadge status={txn.status} />
        </div>
      ),
    },
    {
      key: "visibility",
      header: "공개범위",
      render: (txn) =>
        txn.masked ? (
          <span className="text-subtle">
            {VISIBILITY_LABELS[txn.visibility]}
          </span>
        ) : (
          <Select
            aria-label="공개범위 변경"
            options={VISIBILITY_OPTIONS}
            value={txn.visibility}
            disabled={busyId === txn.id}
            onChange={(e) => changeVisibility(txn, e.target.value)}
          />
        ),
    },
    {
      key: "actions",
      header: "작업",
      render: (txn) => {
        if (txn.masked) return <span className="text-subtle">—</span>;
        const rowBusy = busyId === txn.id;
        const isPending =
          txn.status === "pending_review" ||
          txn.status === "duplicate_suspected";
        const canLink =
          txn.transactionType === "cancellation" &&
          txn.parentTransactionId == null;
        return (
          <div className="row" style={{ gap: 6 }}>
            <Button
              size="sm"
              variant="ghost"
              disabled={rowBusy}
              onClick={() => setMemoTarget(txn)}
            >
              메모
            </Button>
            {isPending ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={rowBusy}
                onClick={() =>
                  mutation.mutate({ kind: "markValid", id: txn.id })
                }
              >
                정상
              </Button>
            ) : null}
            {txn.status !== "duplicate_suspected" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={rowBusy}
                onClick={() =>
                  mutation.mutate({ kind: "markDuplicate", id: txn.id })
                }
              >
                중복
              </Button>
            ) : null}
            {canLink ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={rowBusy}
                onClick={() => setLinkTarget(txn)}
              >
                취소연결
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  const showLoading = householdId != null && listQuery.isLoading;
  const showError = listQuery.isError;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 className="section-title" style={{ marginBottom: 0 }}>
          거래
        </h1>
      </div>

      {/* 필터 바 */}
      <div className="panel">
        <div
          className="row"
          style={{ alignItems: "flex-end", gap: 12 }}
        >
          <label className="field" style={{ gap: 4 }}>
            <span className="field-label">기간</span>
            <Select
              aria-label="기간(월)"
              options={monthOptions}
              placeholder="전체 기간"
              value={month}
              onChange={bindFilter(setMonth)}
            />
          </label>
          <label className="field" style={{ gap: 4 }}>
            <span className="field-label">구성원</span>
            <Select
              aria-label="구성원"
              options={memberOptions}
              placeholder="전체 구성원"
              value={memberId}
              onChange={bindFilter(setMemberId)}
            />
          </label>
          <label className="field" style={{ gap: 4 }}>
            <span className="field-label">카드</span>
            <Select
              aria-label="카드"
              options={cardOptions}
              placeholder="전체 카드"
              value={cardId}
              onChange={bindFilter(setCardId)}
            />
          </label>
          <label className="field" style={{ gap: 4 }}>
            <span className="field-label">카테고리</span>
            <Select
              aria-label="카테고리"
              options={categoryFilterOptions}
              placeholder="전체 카테고리"
              value={categoryId}
              onChange={bindFilter(setCategoryId)}
            />
          </label>
          <label className="field" style={{ gap: 4 }}>
            <span className="field-label">유형</span>
            <Select
              aria-label="유형"
              options={TYPE_OPTIONS}
              placeholder="전체 유형"
              value={type}
              onChange={bindFilter(setType)}
            />
          </label>
          <label className="field" style={{ gap: 4 }}>
            <span className="field-label">상태</span>
            <Select
              aria-label="상태"
              options={STATUS_OPTIONS}
              placeholder="전체 상태"
              value={status}
              onChange={bindFilter(setStatus)}
            />
          </label>
        </div>
        <label
          className="row"
          style={{ gap: 6, marginTop: 12, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={applyRule}
            onChange={(e) => setApplyRule(e.target.checked)}
          />
          <span className="text-muted" style={{ fontSize: "0.85rem" }}>
            카테고리 변경을 이후 거래 규칙으로 저장(applyRule)
          </span>
        </label>
      </div>

      {actionError ? <p className="form-error">{actionError}</p> : null}

      {/* 목록 */}
      {showLoading ? (
        <div className="loader" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>거래를 불러오는 중…</span>
        </div>
      ) : showError ? (
        <p className="form-error">
          거래를 불러오지 못했습니다: {errorMessage(listQuery.error)}
        </p>
      ) : (
        <>
          <Table
            columns={columns}
            rows={items}
            rowKey={(txn) => txn.id}
            emptyLabel="조건에 맞는 거래가 없습니다"
          />
          <div
            className="row"
            style={{ justifyContent: "space-between", gap: 12 }}
          >
            <span className="text-subtle" style={{ fontSize: "0.85rem" }}>
              {items.length}건 표시 · {pageIndex + 1}페이지
            </span>
            <div className="row" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="secondary"
                disabled={!canPrev || listQuery.isFetching}
                onClick={goPrev}
              >
                이전
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!canNext || listQuery.isFetching}
                onClick={goNext}
              >
                다음
              </Button>
            </div>
          </div>
        </>
      )}

      {memoTarget ? (
        <MemoModal
          txn={memoTarget}
          busy={mutation.isPending}
          onClose={() => setMemoTarget(null)}
          onSave={(memo) => saveMemo(memoTarget, memo)}
        />
      ) : null}

      {linkTarget ? (
        <LinkCancellationModal
          cancellation={linkTarget}
          busy={mutation.isPending}
          onClose={() => setLinkTarget(null)}
          onConfirm={(approvalId) => confirmLink(linkTarget, approvalId)}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Memo modal                                                                 */
/* -------------------------------------------------------------------------- */

function MemoModal({
  txn,
  busy,
  onClose,
  onSave,
}: Readonly<{
  txn: TransactionSummary;
  busy: boolean;
  onClose: () => void;
  onSave: (memo: string) => void;
}>) {
  const [memo, setMemo] = useState(txn.memo ?? "");
  return (
    <Modal
      open
      title="메모"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => onSave(memo)}
            disabled={busy}
          >
            저장
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{merchantLabel(txn)}</span>
        <textarea
          className="field-input"
          rows={4}
          maxLength={1000}
          value={memo}
          placeholder="이 거래에 대한 메모(선택)"
          onChange={(e) => setMemo(e.target.value)}
        />
      </label>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Link-cancellation modal                                                    */
/* -------------------------------------------------------------------------- */

function LinkCancellationModal({
  cancellation,
  busy,
  onClose,
  onConfirm,
}: Readonly<{
  cancellation: TransactionSummary;
  busy: boolean;
  onClose: () => void;
  onConfirm: (approvalTransactionId: string) => void;
}>) {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const [selected, setSelected] = useState("");

  // 취소액을 커버할 수 있는 잔액이 남은 승인 거래 후보를 조회한다.
  const approvalsQuery = useQuery({
    queryKey: ["link-approvals", householdId, cancellation.id],
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) =>
        api.transactions.list(token, {
          householdId: householdId as string,
          type: "approval",
          limit: 100,
        }),
      ),
  });

  const candidates = (approvalsQuery.data?.items ?? []).filter(
    (a) =>
      (a.status === "approved" || a.status === "partially_cancelled") &&
      a.amount - a.cancelledAmount >= cancellation.amount,
  );

  const options: SelectOption[] = candidates.map((a) => ({
    value: a.id,
    label: `${merchantLabel(a)} · 잔액 ${formatKRW(
      a.amount - a.cancelledAmount,
    )} · ${formatDate(a.approvedAt, { dateOnly: true })}`,
  }));

  return (
    <Modal
      open
      title="취소 거래 연결"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(selected)}
            disabled={busy || selected === ""}
          >
            연결
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <p className="text-muted" style={{ margin: 0, fontSize: "0.88rem" }}>
          이 취소 거래({formatKRW(cancellation.amount)})를 연결할 승인 거래를
          선택하세요. 연결하면 승인 거래의 순지출이 재계산됩니다.
        </p>
        {approvalsQuery.isLoading ? (
          <div className="loader" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>승인 거래를 불러오는 중…</span>
          </div>
        ) : approvalsQuery.isError ? (
          <p className="form-error">
            승인 거래를 불러오지 못했습니다: {errorMessage(approvalsQuery.error)}
          </p>
        ) : options.length === 0 ? (
          <p className="empty">연결 가능한 승인 거래가 없습니다.</p>
        ) : (
          <label className="field">
            <span className="field-label">승인 거래</span>
            <Select
              options={options}
              placeholder="선택하세요"
              value={selected}
              style={{ width: "100%" }}
              onChange={(e) => setSelected(e.target.value)}
            />
          </label>
        )}
      </div>
    </Modal>
  );
}
