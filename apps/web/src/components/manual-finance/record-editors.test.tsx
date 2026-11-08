/**
 * 자산·주택 입력 창(2026-11-05 HIG 검수 4단계).
 * - 고칠 수 없는 기록은 칸이 꺼진 폼이 아니라 읽기 전용 시트(이름·금액·기준일·주인, 닫기만).
 * - 폼에는 출처·공개 범위 상자가 없고, 삭제는 맨 아래 위험 글자 버튼 '삭제하기'.
 * - 주택은 고칠 수 있어도 상세 시트가 먼저(2026-11-08 '보기 먼저'), 입력 폼은 '수정하기'로 연다.
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
const { PlanEditor, PlanForm } = await import("./plan-editor");

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

const editable = {
  ...plan,
  item: { ...plan.item, canEdit: true, ownerUserId: "me" },
};

describe("주택 상세 시트 — 보기 먼저", () => {
  it("가족의 주택은 읽기 전용 시트 — 남은 금액 요약, 일정은 'M월 D일 예정', 수정하기 없음", () => {
    const html = render(
      <PlanEditor
        householdId={asset.householdId}
        initial={plan}
        onClose={() => {}}
      />
    );
    expect(html).toContain("data-record-sheet");
    expect(html).not.toContain("data-record-dialog");
    expect(html).toContain("2028년 입주");
    expect(html).toContain("남은 금액");
    expect(html).toContain("총 30,000,000원 중 0원 냈어요");
    expect(html).toContain("다음 납부 11월 20일 · 중도금 2회차 30,000,000원");
    expect(html).toContain("아파트 분양대금");
    expect(html).toContain("중도금 2회차");
    expect(html).toContain("11월 20일 예정");
    expect(html).toContain("지민님이 등록했어요. 등록한 사람만 고칠 수 있어요.");
    expect(html).not.toContain("수정하기");
    // 고칠 수 없고 연결도 없으면 수자인 줄 자체가 없다.
    expect(html).not.toContain("수자인");
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // 일정 줄마다 붙던 출처·기준 시각·'낸 금액 출처'는 지웠다.
    for (const gone of ["출처", "신축 조회", "아직 안 냄", "미납", "상태 미확인"])
      expect(html).not.toContain(gone);
  });

  it("고칠 수 있는 주택도 먼저 상세 시트 — 입력 칸 없이 '수정하기'와 수자인 가져오기 줄", () => {
    const html = render(
      <PlanEditor
        householdId={asset.householdId}
        initial={editable}
        onClose={() => {}}
      />
    );
    expect(html).toContain("data-record-sheet");
    expect(html).not.toContain("data-record-dialog");
    expect(html).toMatch(/<button(?=[^>]*type="button")[^>]*>수정하기<\/button>/);
    expect(html).toContain("수자인에서 일정 가져오기");
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/<form\b/);
    expect(html).not.toContain("등록한 사람만 고칠 수 있어요");
  });

  it("옵션은 계약 제목으로 묶고 줄 이름만, 금액을 모르는 일정이 있으면 '확인된 금액 기준'", () => {
    const html = render(
      <PlanEditor
        householdId={asset.householdId}
        initial={{
          ...plan,
          payments: [
            ...plan.payments,
            {
              id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
              planId: plan.item.id,
              kind: "option",
              installment: null,
              label: "발코니 확장 외 2 · 계약금",
              dueDate: null,
              amount: null,
              paidAmount: null,
              paidDate: null,
            },
          ],
        }}
        onClose={() => {}}
      />
    );
    expect(html).toContain(">옵션</h3>");
    expect(html).toContain(">발코니 확장 외 2</h4>");
    expect(html).toContain(">계약금</span>");
    expect(html).toContain("금액 미입력");
    expect(html).toContain("확인 필요");
    expect(html).toContain(
      "확인된 금액 기준 · 예정 금액을 모르는 일정 1개는 뺐어요"
    );
  });

  it("직접 만든 주택(이미 낸 금액을 비워 둠)은 남은 금액 대신 할 일 한 줄 — '확인 필요' 칩과 겹쳐 말하지 않는다", () => {
    const html = render(
      <PlanEditor
        householdId={asset.householdId}
        initial={{
          ...editable,
          payments: editable.payments.map((payment) => ({
            ...payment,
            paidAmount: null,
          })),
        }}
        onClose={() => {}}
      />
    );
    expect(html).toContain(
      "이미 낸 금액(없으면 0)을 적으면 남은 금액을 계산해요"
    );
    expect(html).toContain("낸 금액을 모르는 일정이 1개 있어요");
    expect(html).toContain("11월 20일 예정 · 낸 금액 미확인");
    expect(html).toContain("30,000,000원");
    for (const gone of ["확인된 금액이 없어요", "확인 필요", "금액을 모르는 일정 1개는 뺐어요"])
      expect(html).not.toContain(gone);
  });
});

describe("주택 입력 폼", () => {
  it("'수정하기'로 여는 폼 — 공개 범위·수자인 없음, 접힌 일정은 한 줄, 맨 아래 '삭제하기'", () => {
    const html = render(
      <PlanForm
        householdId={asset.householdId}
        initial={editable}
        onSaved={() => {}}
        onDismiss={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain("data-record-dialog");
    expect(html).not.toContain("공개 범위");
    expect(html).toContain("중도금 2회차 · 30,000,000원 · 11월 20일");
    expect(html).toContain('value="30,000,000"');
    expect(html).toContain("삭제하기");
    expect(html).not.toContain("계획 삭제");
    // 여는 버튼('주택 추가하기')·목록과 같은 이름 — '주택 계획'이라고 부르지 않는다.
    expect(html).toContain("<h2>주택 수정</h2>");
    expect(html).toContain("주택 이름");
    expect(html).not.toContain("주택 계획");
    // 수자인 연결·가져오기는 상세 시트로 옮겼다 — 폼은 <form> 하나, submit은 '저장하기' 하나.
    // (주택 이름 예시 '풍무수자인'은 남는다 — 수자인 연결 칸·줄만 없다.)
    for (const gone of ["sujain-login", "수자인에서", "수자인 ·", "연결 저장", "신축 조회", "출처", "남은 금액 미확인"])
      expect(html).not.toContain(gone);
    expect(html.match(/<form\b/g)?.length ?? 0).toBe(1);
    expect(html.match(/type="submit"/g)?.length ?? 0).toBe(1);
    expect(html).toMatch(
      /<button(?=[^>]*type="submit")[^>]*>저장하기<\/button>/
    );
  });

  it("새 주택은 지금처럼 폼이 바로 열린다(수자인 연결은 저장 뒤 상세 시트에서)", () => {
    const html = render(
      <PlanEditor householdId={asset.householdId} onClose={() => {}} />
    );
    expect(html).toContain("data-record-dialog");
    expect(html).toContain("<h2>주택 추가</h2>");
    expect(html).not.toContain("data-record-sheet");
    expect(html).not.toContain("sujain-login");
    expect(html).not.toContain("수자인에서");
    expect(html).not.toContain("주택을 먼저 저장한 뒤");
    expect(html).not.toContain("삭제하기");
  });
});
