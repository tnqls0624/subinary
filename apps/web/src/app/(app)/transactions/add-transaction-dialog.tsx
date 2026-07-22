"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 거래 추가 다이얼로그
 *
 * 두 모드로 유실 거래를 등록한다:
 *  - 문자 붙여넣기: 복사한 카드 알림/문자를 붙여넣으면 서버가 파싱(미리보기) → 등록
 *    시 일반 수집 파이프라인으로 태워 자동 승격(카드연결/카테고리/중복/예산/알림).
 *  - 직접 입력: 금액·가맹점·날짜·카테고리·카드를 폼으로 입력해 즉시 등록(동기).
 *
 * 파싱 로직/스키마는 서버(@family/card-parsers, ManualEntryService)가 정본이며,
 * 여기선 입력 수집·미리보기 표시·상태 안내만 담당한다.
 * ------------------------------------------------------------------------- */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api-client";
import { formatMoney } from "@/lib/format";
import {
  useCardList,
  useCategoryList,
  useManualFieldsEntry,
  useManualTextEntry,
  useParsePreview,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Select에서 "선택 안 함"을 표현하는 sentinel(Radix는 빈 문자열 value 금지). */
const NONE = "__none__";

type Mode = "text" | "fields";

/** datetime-local 기본값(현재 시각, 로컬). `YYYY-MM-DDTHH:mm`. */
function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "요청을 처리하지 못했어요";
}

export function AddTransactionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>("text");

  // 문자 붙여넣기 상태
  const [content, setContent] = useState("");

  // 직접 입력 상태
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [occurredAt, setOccurredAt] = useState(nowLocalInput);
  const [categoryId, setCategoryId] = useState<string>(NONE);
  const [cardId, setCardId] = useState<string>(NONE);

  const preview = useParsePreview();
  const textEntry = useManualTextEntry();
  const fieldsEntry = useManualFieldsEntry();
  const categories = useCategoryList();
  const cards = useCardList();

  // 다이얼로그 열릴 때마다 초기화.
  useEffect(() => {
    if (!open) return;
    setMode("text");
    setContent("");
    setAmount("");
    setMerchant("");
    setOccurredAt(nowLocalInput());
    setCategoryId(NONE);
    setCardId(NONE);
    preview.reset();
    textEntry.reset();
    fieldsEntry.reset();
    // 초기화는 open 토글에만 반응(뮤테이션 identity는 안정적).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 문자 입력 디바운스 → 파싱 미리보기.
  useEffect(() => {
    const text = content.trim();
    if (mode !== "text" || text.length < 4) {
      preview.reset();
      return;
    }
    const timer = setTimeout(() => preview.mutate({ content: text }), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, mode]);

  const previewData = preview.data;
  const canRegisterText = Boolean(previewData?.parseable);

  const submitting = textEntry.isPending || fieldsEntry.isPending;

  /** 미리보기 결과를 직접 입력 폼에 채우고 폼 모드로 전환. */
  function switchToFieldsPrefilled() {
    if (previewData) {
      if (previewData.amount != null) setAmount(String(previewData.amount));
      if (previewData.merchantRaw) setMerchant(previewData.merchantRaw);
      if (previewData.occurredAt) {
        const d = new Date(previewData.occurredAt);
        if (!Number.isNaN(d.getTime())) {
          const pad = (n: number) => String(n).padStart(2, "0");
          setOccurredAt(
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
              d.getDate(),
            )}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
          );
        }
      }
    }
    setMode("fields");
  }

  async function handleTextRegister() {
    try {
      const res = await textEntry.mutateAsync({ content: content.trim() });
      const status = res.detail.parseStatus;
      if (status === "parsed" || status === "pending_review") {
        toast.success("거래가 등록됐어요");
        onOpenChange(false);
      } else if (status === "parse_failed") {
        toast.error("자동 인식에 실패했어요. 직접 입력으로 등록해 주세요");
        switchToFieldsPrefilled();
      } else {
        // 폴링 시간 내 미완료(드묾) — 곧 목록에 반영됨.
        toast.message("등록 처리 중이에요. 잠시 후 목록에 반영됩니다");
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function handleFieldsRegister() {
    const amountInt = Number(amount.replace(/[,\s]/g, ""));
    if (!Number.isInteger(amountInt) || amountInt <= 0) {
      toast.error("금액을 올바르게 입력해 주세요");
      return;
    }
    if (merchant.trim().length === 0) {
      toast.error("가맹점을 입력해 주세요");
      return;
    }
    const occurred = new Date(occurredAt);
    if (Number.isNaN(occurred.getTime())) {
      toast.error("날짜/시각을 올바르게 입력해 주세요");
      return;
    }
    try {
      await fieldsEntry.mutateAsync({
        amount: amountInt,
        currency: "KRW",
        merchantRaw: merchant.trim(),
        occurredAt: occurred.toISOString(),
        transactionType: "approval",
        cardId: cardId === NONE ? undefined : cardId,
        categoryId: categoryId === NONE ? undefined : categoryId,
      });
      toast.success("거래가 등록됐어요");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const categoryOptions = categories.data ?? [];
  const cardOptions = useMemo(
    () => (cards.data ?? []).filter((c) => c.status === "active"),
    [cards.data],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>거래 추가</DialogTitle>
          <DialogDescription>
            놓친 카드 결제를 문자 붙여넣기나 직접 입력으로 등록하세요.
          </DialogDescription>
        </DialogHeader>

        {/* 모드 탭 */}
        <div className="bg-muted flex gap-1 rounded-xl p-1">
          {(
            [
              ["text", "문자 붙여넣기"],
              ["fields", "직접 입력"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={cn(
                "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "text" ? (
          <div className="flex flex-col gap-3">
            <Label htmlFor="paste-content">카드 알림/문자 원문</Label>
            <textarea
              id="paste-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              placeholder={
                "예) 13,380원 결제\n공룡통장 카드 | 쿠팡(쿠페이)\n잔액 126,713원"
              }
              className="border-input bg-background focus-visible:ring-ring w-full resize-none rounded-xl border px-3 py-2 text-sm whitespace-pre-wrap focus-visible:ring-2 focus-visible:outline-none"
            />

            {/* 파싱 미리보기 */}
            {preview.isPending ? (
              <p className="text-muted-foreground text-sm">인식 중…</p>
            ) : previewData ? (
              <div className="bg-muted/50 flex flex-col gap-2 rounded-xl p-3 text-sm">
                {previewData.parseable ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">금액</span>
                      <span className="font-semibold">
                        {formatMoney(previewData.amount ?? 0, previewData.currency ?? "KRW")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">가맹점</span>
                      <span>{previewData.merchantRaw ?? "—"}</span>
                    </div>
                    {previewData.issuer && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">카드사</span>
                        <span>{previewData.issuer}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-muted-foreground">
                      금액을 인식하지 못했어요
                      {previewData.merchantRaw
                        ? ` (가맹점: ${previewData.merchantRaw})`
                        : ""}
                      .
                    </p>
                    <Button
                      type="button"
                      variant="tint"
                      size="sm"
                      onClick={switchToFieldsPrefilled}
                    >
                      직접 입력으로 전환
                    </Button>
                  </div>
                )}
              </div>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                취소
              </Button>
              <Button
                type="button"
                onClick={handleTextRegister}
                disabled={!canRegisterText || submitting}
              >
                {textEntry.isPending ? "등록 중…" : "등록"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-amount">금액 (원)</Label>
              <Input
                id="f-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="13380"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-merchant">가맹점</Label>
              <Input
                id="f-merchant"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                placeholder="쿠팡(쿠페이)"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-occurred">날짜/시각</Label>
              <Input
                id="f-occurred"
                type="datetime-local"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-category">카테고리 (선택)</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="f-category">
                  <SelectValue placeholder="선택 안 함" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>선택 안 함</SelectItem>
                  {categoryOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-card">카드 (선택)</Label>
              <Select value={cardId} onValueChange={setCardId}>
                <SelectTrigger id="f-card">
                  <SelectValue placeholder="선택 안 함" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>선택 안 함</SelectItem>
                  {cardOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.alias}
                      {c.maskedNumber ? ` (${c.maskedNumber})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                취소
              </Button>
              <Button
                type="button"
                onClick={handleFieldsRegister}
                disabled={submitting}
              >
                {fieldsEntry.isPending ? "등록 중…" : "등록"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
