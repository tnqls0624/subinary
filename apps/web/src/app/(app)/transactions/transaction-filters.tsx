"use client";
/**
 * 가계부 목록 위 기간·검색·조건(2026-11-05, PO 관점으로 다시 짰다).
 *
 * 이 화면에서 사용자가 하는 일은 셋이다 — 달을 넘겨 보기, 가맹점 찾기, 조건으로 좁히기.
 * - 달: `2026년 11월 ▾`(눌러서 고르기, 전체 기간 포함) + `‹ ›`로 한 달씩. 가장 자주 하므로 한 번에 닿게 둔다.
 *   이 머리는 가계부 세 탭이 함께 쓰도록 공용 `MonthNav`로 올렸다(2026-11-05 HIG 검수 3·4단계).
 * - 검색: 늘 보이는 검색칸(`children`).
 * - 조건: 가로로 넘기는 칩 한 줄. 칩을 누르면 그 자리 아래로 드롭다운이 펼쳐지고, 고른 값이 칩에 바로 보인다.
 *   칩 순서는 쓰는 빈도 — 확인할 거래(할 일) · 카테고리 · 구성원(가족 앱) · 카드 · 취소·환불.
 *
 * 예전에는 '필터' 버튼 → 라벨 붙은 드롭다운 5개를 쌓은 패널 → '필터 닫기' 순서였고, 적용된 조건은
 * 패널 밖 칩 줄에 한 번 더 보여 같은 정보가 두 군데 있었다. 유형·상태는 '취소·환불' 하나로 합쳤다
 * (`filter-summary.ts`). '초기화'는 기간과 검색어를 남기고 조건만 지운다.
 * 이름은 앱 전체 규칙을 따른다 — 링크로 켜지는 조건 '합계 제외 거래', 취소 선택지 '취소된 결제·부분 취소된 결제·환불 기록'.
 * 값 고르기는 시트가 아니라 드롭다운이다(`components/ui/sheet-layout.ts` 표).
 */
import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { PickerMenu } from "@/components/ui/picker-menu";
import { FilterChip, FilterClearChip } from "@/components/widgets/filter-chip";
import { MonthNav } from "@/components/widgets/month-nav";
import {
  CANCELLATION_FILTER_OPTIONS,
  TRANSACTION_FILTER_LABELS,
  cancellationFilterChange,
  cancellationFilterLabel,
  cancellationFilterValue,
  filterValueLabel,
  hasTransactionConditions,
  type ActiveTransactionFilter,
  type TransactionFilterChoices,
  type TransactionFilterKey,
  type TransactionFilterOption,
  type TransactionFilterValues,
} from "./filter-summary";

/** 드롭다운의 '전체' 값(빈 문자열은 선택 비교에 쓰기 애매하다). */
const ALL = "__all__";

/** 칩이 바꾸는 조건 — 순서가 곧 화면 순서다. */
const PICKER_CHIPS: ReadonlyArray<"categoryId" | "memberId" | "cardId"> = [
  "categoryId",
  "memberId",
  "cardId",
];

export function TransactionFilters({
  month,
  monthOptions,
  values,
  choices,
  onMonthChange,
  onChange,
  onClear,
  onClearAll,
  onToggleReview,
  children,
}: {
  month: string;
  monthOptions: ReadonlyArray<TransactionFilterOption>;
  values: TransactionFilterValues;
  choices: TransactionFilterChoices;
  onMonthChange: (value: string) => void;
  onChange: (key: TransactionFilterKey, value: string) => void;
  onClear: (key: ActiveTransactionFilter["key"]) => void;
  onClearAll: () => void;
  onToggleReview: () => void;
  children?: ReactNode;
}) {
  // 달 이름은 MonthNav가 formatMonth로 직접 만든다(page.tsx가 주는 label도 같은 formatMonth다).
  // 한 달씩 이동·정렬·이번 달/보고 있는 달 보충·전체 기간일 때 화살표 숨김도 MonthNav가 맡는다.
  const months = monthOptions.map((option) => option.value);

  const cancellationLabel = cancellationFilterLabel(values, choices);

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="거래 필터">
      <MonthNav
        month={month}
        months={months}
        onChange={onMonthChange}
        allowAll
      />

      {children}

      {/*
        칩은 가로로 넘긴다. '초기화'는 넘기는 영역 밖 오른쪽에 고정한다 — 조건을 여러 개 골라도 늘 보이고,
        조건이 생길 때 칩이 옆으로 밀리지 않는다.
        touch-pan-x: 칩이 전부 버튼·드롭다운이라 세로 페이지 스크롤이 가로 제스처를 가로채기 쉽다(SOO-46).
        브라우저에 이 줄은 가로 팬이라고 알려 손가락으로 넘기게 한다. 드롭다운은 공용 부품이 손을 뗄 때
        열고, 손가락이 움직이면 열지 않는다.
      */}
      <div className="flex min-w-0 items-center gap-1">
        <div
          role="group"
          aria-label="조건"
          className="-ml-1 flex min-w-0 flex-1 touch-pan-x items-center gap-2 overflow-x-auto overscroll-x-contain pl-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {values.excludedOnly ? (
            <FilterClearChip
              label="합계 제외 거래"
              onClear={() => onClear("excludedOnly")}
            />
          ) : null}
          {values.sharedOnly ? (
            <FilterClearChip
              label="공용 카드 거래"
              onClear={() => onClear("sharedOnly")}
            />
          ) : null}
          {/* 켜고 끄는 칩은 켜졌을 때 체크를 붙인다 — 색만 바뀌면 색을 구분하기 어려운 사람에게 상태가 안 보인다. */}
          <FilterChip
            active={values.reviewOnly}
            aria-pressed={values.reviewOnly}
            onClick={onToggleReview}
          >
            {values.reviewOnly ? (
              <Check
                aria-hidden="true"
                className="mr-1 inline-block size-3.5 align-middle"
              />
            ) : null}
            확인할 거래
          </FilterChip>
          {PICKER_CHIPS.map((key) => {
            const name = TRANSACTION_FILTER_LABELS[key];
            const valueLabel = filterValueLabel(key, values, choices);
            return (
              <PickerMenu
                key={key}
                label={name}
                options={[
                  { value: ALL, label: `전체 ${name}` },
                  ...choices[key],
                ]}
                value={values[key] || ALL}
                onSelect={(value) => onChange(key, value === ALL ? "" : value)}
                trigger={
                  <FilterChip
                    menu
                    active={valueLabel != null}
                    aria-label={
                      valueLabel ? `${name}: ${valueLabel}` : `${name} 고르기`
                    }
                  >
                    {valueLabel ?? name}
                  </FilterChip>
                }
              />
            );
          })}
          <PickerMenu
            label="취소·환불"
            options={[
              { value: ALL, label: "전체" },
              ...CANCELLATION_FILTER_OPTIONS,
            ]}
            value={cancellationFilterValue(values) || ALL}
            onSelect={(value) => {
              const change = cancellationFilterChange(
                value === ALL ? "" : value
              );
              onChange("type", change.type);
              onChange("status", change.status);
            }}
            trigger={
              <FilterChip
                menu
                active={cancellationLabel != null}
                aria-label={
                  cancellationLabel
                    ? `취소·환불: ${cancellationLabel}`
                    : "취소·환불 고르기"
                }
              >
                {cancellationLabel ?? "취소·환불"}
              </FilterChip>
            }
          />
        </div>
        {hasTransactionConditions(values) ? (
          <button
            type="button"
            onClick={onClearAll}
            className="text-caption text-muted-foreground hover:text-foreground min-h-11 shrink-0 px-2 font-medium whitespace-nowrap active:text-foreground"
          >
            초기화
          </button>
        ) : null}
      </div>
      {/* 서버의 review 필터는 거래만 센다. 아직 거래가 되지 않은 문자(읽지 못함·환율 대기)는 할 일 화면에 있다. */}
      {values.reviewOnly ? (
        <p className="text-caption text-muted-foreground">
          아직 거래로 반영되지 않은 문자는 여기 없고 할 일에 있어요.
        </p>
      ) : null}
    </section>
  );
}
