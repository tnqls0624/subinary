/**
 * 자산·주택 입력 창(2026-11-05 HIG 검수 4단계).
 * - 고칠 수 없는 기록은 칸이 꺼진 폼이 아니라 읽기 전용 시트(이름·금액·기준일·주인, 닫기만).
 * - 폼에는 출처·공개 범위 상자가 없고, 삭제는 맨 아래 위험 글자 버튼 '삭제하기'.
 * 창(Dialog·BottomSheet)은 포털이라 서버 렌더에 나오지 않아, 껍데기만 단순한 상자로 바꿔 내용을 읽는다.
 */
import type { ReactNode } from "react";
import type { ManualAsset, ManualHousingPlanResponse } from "@family/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authedFetch: vi.fn(), user: { id: "me" } }),
}));
vi.mock("@/lib/queries", () => ({
  useHouseholdMembers: () => ({
    data: [
      { userId: "spouse", name: "지민" },
      { userId: "me", name: "수빈" },
    ],
  }),
}));
vi.mock("@/lib/manual-finance-client", () => ({
  manualFinanceApi: {},
  useManualFinanceRefresh: () => vi.fn(),
}));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  RecordSheet: ({
    title,
    children,
  }: {
    title: string;
    children: ReactNode;
  }) => (
    <section data-record-sheet="">
      <h2>{title}</h2>
      {children}
    </section>
  ),
  RecordDialog: ({
    title,
    description,
    children,
    footer,
  }: {
    title: string;
    description: string;
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <div data-record-dialog="">
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
      <footer>{footer}</footer>
    </div>
  ),
}));

const { AssetEditor } = await import("./asset-editor");
const { PlanEditor } = await import("./plan-editor");

const asset: ManualAsset = {
  id: "8f3c2b8e-7a51-4f0e-9a51-0c9e2f1b7d10",
  householdId: "4d1f3c22-1e6b-4b5f-8a3e-2a9b6c7d8e90",
  ownerUserId: "spouse",
  version: 3,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  canEdit: false,
  kind: "account",
  label: "합성 생활비 통장",
  visibility: "household",
  currency: "KRW",
  amount: "1234000",
  asOfDate: `${new Date().getFullYear()}-11-01`,
  source: "manual",
  legalOwnerLabel: null,
  note: null,
};

const render = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("자산 입력 창", () => {
  it("가족의 자산은 읽기 전용 시트 — 칸·저장 버튼 없이 이름·금액·기준일·주인", () => {
    const html = render(
      <AssetEditor
        householdId={asset.householdId}
        item={asset}
        onChanged={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain("data-record-sheet");
    expect(html).not.toContain("data-record-dialog");
    expect(html).toContain("합성 생활비 통장");
    expect(html).toContain("1,234,000원");
    expect(html).toContain("11월 1일");
    expect(html).toContain("지민");
    expect(html).toContain("등록한 사람만 고칠 수 있어요.");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("저장하기");
    expect(html).not.toContain("입력해 주세요");
  });

  it("내 기록이지만 권한이 보기뿐이면 그렇게 말한다", () => {
    const html = render(
      <AssetEditor
        householdId={asset.householdId}
        item={{ ...asset, ownerUserId: "me" }}
        onChanged={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain("지금 가족 권한으로는 고칠 수 없어요.");
  });

  it("고칠 수 있는 자산은 폼 — 출처·공개 범위 상자 없음, 금액은 AmountInput, 맨 아래 '삭제하기'", () => {
    const html = render(
      <AssetEditor
        householdId={asset.householdId}
        item={{ ...asset, canEdit: true, ownerUserId: "me" }}
        onChanged={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain("data-record-dialog");
    expect(html).not.toContain("출처:");
    expect(html).not.toContain("공개 범위");
    expect(html).not.toContain("가족과 공유");
    expect(html).toContain('value="1,234,000"');
    expect(html).toContain(">원<");
    expect(html).toContain("저장하기");
    expect(html).toContain("삭제하기");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("자산 삭제");
    // 설명 문단은 하나(창 설명) — '금액 입력 기준' 접힘 두 문단은 없앴다.
    expect(html).not.toContain("금액 입력 기준");
    // placeholder와 도움말이 같은 말을 되풀이하지 않는다.
    expect(html.match(/모르면 비워/g)?.length ?? 0).toBe(1);
  });

  it("새 자산 추가 폼에는 삭제가 없다", () => {
    const html = render(
      <AssetEditor
        householdId={asset.householdId}
        onChanged={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain("자산 추가");
    expect(html).not.toContain("삭제하기");
  });
});

const plan: ManualHousingPlanResponse = {
  item: {
    id: "c6a5d4e3-2b1a-4f9e-8d7c-6b5a4e3d2c1b",
    householdId: asset.householdId,
    ownerUserId: "spouse",
    version: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    canEdit: false,
    label: "합성 아파트 59",
    visibility: "household",
    occupancyYear: 2028,
    contractStage: null,
    fundingNote: null,
  },
  payments: [
    {
      id: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      planId: "c6a5d4e3-2b1a-4f9e-8d7c-6b5a4e3d2c1b",
      kind: "interim",
      installment: 2,
      dueDate: `${new Date().getFullYear()}-11-20`,
      amount: "30000000",
      paidAmount: "0",
      paidDate: null,
    },
  ],
};

describe("주택 계획 입력 창", () => {
  it("가족의 계획은 읽기 전용 시트 — 일정은 'M월 D일'", () => {
    const html = render(
      <PlanEditor
        householdId={asset.householdId}
        initial={plan}
        onChanged={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain("data-record-sheet");
    expect(html).toContain("중도금 2회차");
    expect(html).toContain("30,000,000원");
    expect(html).toContain("예정일 11월 20일");
    expect(html).toContain("아직 안 냄");
    expect(html).toContain("지민");
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("고칠 수 있는 계획은 폼 — 공개 범위 상자 없음, 예정일은 'M월 D일', 맨 아래 '삭제하기'", () => {
    const editable = {
      ...plan,
      item: { ...plan.item, canEdit: true, ownerUserId: "me" },
    };
    const html = render(
      <PlanEditor
        householdId={asset.householdId}
        initial={editable}
        onChanged={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain("data-record-dialog");
    expect(html).not.toContain("공개 범위");
    expect(html).toContain("예정일 11월 20일");
    expect(html).toContain('value="30,000,000"');
    expect(html).toContain("삭제하기");
    expect(html).not.toContain("계획 삭제");
    // 여는 버튼('주택 추가하기')·목록과 같은 이름 — '주택 계획'이라고 부르지 않는다.
    expect(html).toContain("<h2>주택 수정</h2>");
    expect(html).toContain("주택 이름");
    expect(html).not.toContain("주택 계획");
    expect(html).toContain("저장하기");
  });

  it("수자인 연결 저장은 주택 폼 submit이 아니라 패널 전용 버튼이다", () => {
    const editable = {
      ...plan,
      item: { ...plan.item, canEdit: true, ownerUserId: "me" },
    };
    const html = render(
      <PlanEditor
        householdId={asset.householdId}
        initial={editable}
        onChanged={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain("수자인 신축 조회");
    expect(html).toContain("수자인 연결 저장");
    // One housing-plan <form>; brand panel must not nest another or use type=submit.
    expect(html.match(/<form\b/g)?.length ?? 0).toBe(1);
    expect(html).toMatch(
      /<button(?=[^>]*type="button")[^>]*>수자인 연결 저장<\/button>/
    );
    expect(html).toMatch(
      /<button(?=[^>]*type="submit")[^>]*>저장하기<\/button>/
    );
    const brandPanel = html.match(
      /aria-label="수자인 신축 조회"[\s\S]*?<\/section>/
    )?.[0];
    expect(brandPanel).toBeTruthy();
    expect(brandPanel).not.toMatch(/<select\b/);
    expect(brandPanel).toContain(">수자인</p>");
  });
});
