/**
 * 가계부 기간·조건 칩(2026-11-05 PO 재설계). 드롭다운을 쌓은 '필터' 패널 대신
 * `2026년 11월 ▾ ‹ ›` + 칩 한 줄이고, 고른 값이 칩에 바로 보인다.
 * 달 머리는 공용 MonthNav다(HIG 검수 3·4단계) — 이번 달을 목록에 보태므로 시계를 고정한다.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TransactionFilterChoices,
  TransactionFilterValues,
} from "./filter-summary";
import { TransactionFilters } from "./transaction-filters";

const empty: TransactionFilterValues = {
  categoryId: "",
  cardId: "",
  memberId: "",
  type: "",
  status: "",
  reviewOnly: false,
  excludedOnly: false,
  sharedOnly: false,
};
const choices: TransactionFilterChoices = {
  categoryId: [{ value: "cafe", label: "카페" }],
  cardId: [{ value: "card-1", label: "생활비 카드" }],
  memberId: [{ value: "m1", label: "수빈" }],
  type: [{ value: "cancellation", label: "취소" }],
  status: [{ value: "cancelled", label: "취소" }],
};
const monthOptions = [
  { value: "2026-11", label: "2026년 11월" },
  { value: "2026-10", label: "2026년 10월" },
];

function render(values: TransactionFilterValues, month = "2026-11") {
  return renderToStaticMarkup(
    <TransactionFilters
      month={month}
      monthOptions={monthOptions}
      values={values}
      choices={choices}
      onMonthChange={() => undefined}
      onChange={() => undefined}
      onClear={() => undefined}
      onClearAll={() => undefined}
      onToggleReview={() => undefined}
    >
      <input aria-label="거래 검색" />
    </TransactionFilters>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // 서울 2026-11-05 정오 — 이번 달은 2026-11.
  vi.setSystemTime(new Date("2026-11-05T03:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

// 버튼 태그 하나를 통째로 잡는다 — 속성 순서(disabled가 aria-label 앞에 올 수 있음)와
// 무관하게 그 버튼이 잠겼는지 확인하려고. React는 속성 값의 '>'를 &gt;로 바꾸므로 태그 끝이 분명하다.
// class의 'disabled:opacity-40' 같은 변형 이름이 아니라 disabled 속성만 본다.
const DISABLED_ATTR = /\sdisabled=""/;
function buttonTag(html: string, label: string): string | undefined {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

describe("가계부 기간·조건", () => {
  it("달은 이름을 눌러 고르고 ‹ ›로 한 달씩 넘긴다 — 마지막 달에서는 다음이 막힌다", () => {
    const html = render(empty);
    expect(html).toContain('aria-label="기간: 2026년 11월"');
    const prev = buttonTag(html, "이전 달");
    const next = buttonTag(html, "다음 달");
    expect(prev).toBeDefined();
    expect(prev).not.toMatch(DISABLED_ATTR);
    expect(next).toBeDefined();
    expect(next).toMatch(DISABLED_ATTR);
  });

  it("전체 기간이면 이름만 보이고 화살표는 없다", () => {
    const html = render(empty, "");
    expect(html).toContain('aria-label="기간: 전체 기간"');
    expect(html).not.toContain("이전 달");
  });

  it("목록 첫 달에서는 이전이 막히고 다음은 열린다", () => {
    const html = render(empty, "2026-10");
    expect(html).toContain('aria-label="기간: 2026년 10월"');
    const prev = buttonTag(html, "이전 달");
    const next = buttonTag(html, "다음 달");
    expect(prev).toBeDefined();
    expect(prev).toMatch(DISABLED_ATTR);
    expect(next).toBeDefined();
    expect(next).not.toMatch(DISABLED_ATTR);
  });

  it("조건은 칩 한 줄이고, 고른 값이 칩에 보이며, 조건이 있을 때만 '초기화'가 나온다", () => {
    const idle = render(empty);
    for (const chip of [
      "확인할 거래",
      "카테고리 고르기",
      "구성원 고르기",
      "카드 고르기",
      "취소·환불 고르기",
    ]) {
      expect(idle).toContain(chip);
    }
    expect(idle).not.toContain("초기화");
    expect(idle).not.toContain("<select");
    expect(idle).not.toContain("필터 닫기");
    // 기간 + 카테고리·구성원·카드·취소·환불 = 드롭다운 버튼 5개(시트가 아니다). 확인할 거래는 켜고 끄는 칩.
    expect(idle.match(/aria-haspopup="menu"/g)).toHaveLength(5);
    expect(idle).not.toContain('aria-haspopup="dialog"');
    // 칩 줄은 손가락 가로 팬을 받는다 — 세로 페이지 스크롤에 가로 제스처를 뺏기지 않게(SOO-46).
    expect(idle).toMatch(
      /aria-label="조건"[^>]*class="[^"]*\btouch-pan-x\b[^"]*"/
    );
    expect(idle).toMatch(
      /aria-label="조건"[^>]*class="[^"]*\boverscroll-x-contain\b[^"]*"/
    );

    const filtered = render({
      ...empty,
      categoryId: "cafe",
      status: "cancelled",
    });
    expect(filtered).toContain('aria-label="카테고리: 카페"');
    expect(filtered).toContain('aria-label="취소·환불: 취소된 결제"');
    expect(filtered).toContain("초기화");

    // 취소로 생긴 기록은 '환불' — 고른 이름이 칩에 그대로 보인다.
    const refunds = render({ ...empty, type: "cancellation" });
    expect(refunds).toContain('aria-label="취소·환불: 환불 기록"');
    expect(refunds).toContain(">환불 기록<");
  });

  it("링크로만 켜지는 조건은 ×로 끄는 칩으로 보인다 — 이름은 '합계 제외 거래'", () => {
    const html = render({ ...empty, excludedOnly: true });
    expect(html).toContain('aria-label="합계 제외 거래 조건 해제"');
    expect(html).not.toContain("합계에서 뺀 거래");
  });

  it("'확인할 거래'를 켜면 색 말고도 체크가 붙고, 할 일에 남은 문자를 쉬운 말로 알린다", () => {
    const off = render(empty);
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain("lucide-check");
    expect(off).not.toContain("할 일에 있어요");

    const on = render({ ...empty, reviewOnly: true });
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("lucide-check");
    expect(on).toContain(
      "아직 거래로 반영되지 않은 문자는 여기 없고 할 일에 있어요."
    );
    expect(on).not.toContain("처리 대기");
  });
});
