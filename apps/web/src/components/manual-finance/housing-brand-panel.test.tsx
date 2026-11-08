/**
 * 주택 상세 시트의 수자인 줄(2026-11-08 PO 재설계). 연결 뒤에는 한 줄 + '새로 가져오기'만, 연결 폼은 누를 때만 펼치고,
 * 가져온 결과는 사람 말로 처음부터 모두 골라 둔다. 서버 렌더라 처음 상태만 보이므로, 폼과 결과는 부품을 직접 그린다.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  HousingBrandConnection,
  ManualHousingPlanResponse,
} from "@family/contracts";
import {
  BrandConnectForm,
  BrandSyncResults,
  HousingBrandPanel,
} from "./housing-brand-panel";
import { previewChanges } from "./plan-summary";

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authedFetch: async () => { throw new Error("unused"); } }),
}));

const year = new Date().getFullYear();
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const HOUSEHOLD = "33333333-3333-4333-8333-333333333333";
const PAYMENT_ID = "44444444-4444-4444-8444-444444444444";

const connection = (
  status: HousingBrandConnection["status"],
  over: Partial<HousingBrandConnection> = {}
): HousingBrandConnection => ({
  id: "11111111-1111-4111-8111-111111111111",
  planId: PLAN_ID,
  brand: "sujain",
  status,
  statusMessage: status === "failed" ? "수자인 조회를 끝내지 못했어요." : null,
  credentialsStored: true,
  version: 1,
  lastFetchAt: null,
  lastSuccessAt: `${year}-11-08T14:27:00.000Z`,
  canManage: true,
  ...over,
});

const plan = (
  brandConnection: HousingBrandConnection | null
): ManualHousingPlanResponse => ({
  item: {
    id: PLAN_ID,
    householdId: HOUSEHOLD,
    ownerUserId: "me",
    version: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    canEdit: true,
    label: "합성 아파트 59",
    visibility: "household",
    occupancyYear: 2028,
    contractStage: null,
    fundingNote: null,
  },
  payments: [
    {
      id: PAYMENT_ID,
      planId: PLAN_ID,
      kind: "interim",
      installment: 3,
      dueDate: `${year}-11-20`,
      amount: "3000000",
      paidAmount: "0",
      paidDate: null,
    },
  ],
  brandConnection,
});

const panel = (brand: HousingBrandConnection | null, canEdit = true) =>
  renderToStaticMarkup(
    <HousingBrandPanel
      householdId={HOUSEHOLD}
      plan={plan(brand)}
      canEdit={canEdit}
      onConnectionChange={() => undefined}
      onApplied={() => undefined}
      onReload={async () => true}
    />
  );

describe("수자인 줄", () => {
  it("연결 뒤에는 '수자인 · 11월 8일 오후 11:27 기준' 한 줄과 '새로 가져오기'만 — 칸·설명·상태 줄을 펼치지 않는다", () => {
    const html = panel(connection("connected"));
    expect(html).toContain("수자인 · 11월 8일 오후 11:27 기준");
    expect(html).toMatch(/<button(?=[^>]*type="button")[^>]*>새로 가져오기<\/button>/);
    expect(html).toContain(">연결 정보 바꾸기</button>");
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/<form\b/);
    for (const gone of ["신축 조회", "연동 상태", "브랜드", "확인 목록", "호반", "password123"])
      expect(html).not.toContain(gone);
  });

  it("연결이 없으면 '수자인에서 일정 가져오기' 한 줄 — 누르면 그 자리에서 펼친다(창을 열지 않는다)", () => {
    const html = panel(null);
    expect(html).toMatch(/<button(?=[^>]*aria-expanded="false")[^>]*>수자인에서 일정 가져오기/);
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("<input");
  });

  it("고칠 권한이 없으면 글자만, 연결도 없으면 줄 자체가 없다", () => {
    const html = panel(connection("connected"), false);
    expect(html).toContain("수자인 · 11월 8일 오후 11:27 기준");
    expect(html).not.toContain("<button");
    expect(panel(null, false)).toBe("");
  });

  it("한 번도 못 가져왔으면 그렇게 말한다", () => {
    expect(panel(connection("connected", { lastSuccessAt: null }))).toContain(
      "수자인 · 아직 가져오지 않았어요"
    );
  });

  it("실패면 줄 아래 서버 문구 한 번과 '다시 가져오기'", () => {
    const html = panel(connection("failed"));
    const needle = "수자인 조회를 끝내지 못했어요.";
    expect(html.split(needle)).toHaveLength(2);
    expect(html).toContain('role="alert"');
    expect(html).toContain(">다시 가져오기</button>");
    expect(html).not.toContain("새로 가져오기");
    expect(html).not.toContain("공식 페이지에서 추가 인증");
  });

  it("가져온 뒤 반영 전(needs_confirmation)이어도 고를 목록이 없으면 '골라 주세요'를 그리지 않는다", () => {
    const at = `${year}-11-08T14:27:00.000Z`;
    const html = panel(
      connection("needs_confirmation", {
        statusMessage: "가져온 납부·옵션을 확인한 뒤 반영할 항목을 골라 주세요.",
        lastFetchAt: at,
        lastSuccessAt: at,
      })
    );
    expect(html).toContain("수자인 · 11월 8일 오후 11:27 기준");
    expect(html).toContain(">가져온 내용을 아직 반영하지 않았어요</p>");
    expect(html).toMatch(/<button(?=[^>]*type="button")[^>]*>새로 가져오기<\/button>/);
    expect(html).not.toContain("골라 주세요");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });

  it("고칠 권한이 없으면 반영 전이어도 할 일 줄 없이 글자만", () => {
    const at = `${year}-11-08T14:27:00.000Z`;
    const html = panel(
      connection("needs_confirmation", {
        statusMessage: "가져온 납부·옵션을 확인한 뒤 반영할 항목을 골라 주세요.",
        lastFetchAt: at,
        lastSuccessAt: at,
      }),
      false
    );
    expect(html).not.toContain("골라 주세요");
    expect(html).not.toContain("아직 반영하지 않았어요");
    expect(html).not.toContain("<button");
  });

  it("추가 인증 때문에 못 가져온 needs_confirmation 은 실패처럼 — 서버 문구 한 번과 '다시 가져오기'", () => {
    const needle = "추가 인증이 필요해요. 공식 수자인 페이지에서 이어서 확인해 주세요.";
    const html = panel(
      connection("needs_confirmation", {
        statusMessage: needle,
        lastFetchAt: `${year}-11-08T15:00:00.000Z`,
      })
    );
    expect(html.split(needle)).toHaveLength(2);
    expect(html).toContain('role="alert"');
    expect(html).toContain(">다시 가져오기</button>");
    expect(html).not.toContain("새로 가져오기");
    expect(html).not.toContain("아직 반영하지 않았어요");
  });
});

describe("연결 폼", () => {
  const form = (error: string | null = null, busy = false) =>
    renderToStaticMarkup(
      <BrandConnectForm
        brandLabel="수자인"
        busy={busy}
        error={error}
        onSubmit={() => undefined}
        onClose={() => undefined}
      />
    );

  it("아이디·비밀번호 두 칸 + '연결하고 가져오기' + '닫기', 설명은 한 줄, 브랜드 고르기 없음", () => {
    const html = form();
    expect(html).toContain(
      ">수자인 사이트 아이디로 이 주택의 분양대금과 옵션을 가져와요. 비밀번호는 다시 보여 주지 않아요.</p>"
    );
    expect(html).toContain(">수자인 아이디</label>");
    expect(html).toContain(">수자인 비밀번호</label>");
    // 브라우저에 저장된 자격 증명 연결을 지키려고 칸 이름·자동 완성은 예전 그대로다.
    expect(html).toMatch(/<input(?=[^>]*name="sujain-login")(?=[^>]*autocomplete="off")[^>]*>/i);
    expect(html).toMatch(
      /<input(?=[^>]*name="sujain-password")(?=[^>]*type="password")(?=[^>]*autocomplete="new-password")[^>]*>/i
    );
    expect(html).toMatch(/<button(?=[^>]*type="submit")[^>]*>연결하고 가져오기<\/button>/);
    expect(html).toMatch(/<button(?=[^>]*type="button")[^>]*>닫기<\/button>/);
    expect(html.match(/<input\b/g)).toHaveLength(2);
    expect(html).not.toMatch(/<select\b/);
    expect(html).not.toContain("브랜드");
  });

  it("다른 일을 하는 중이면 글자는 그대로 두고 칸과 버튼만 막는다", () => {
    const html = renderToStaticMarkup(
      <BrandConnectForm
        brandLabel="수자인"
        busy={false}
        disabled
        error={null}
        onSubmit={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(html).toContain(">연결하고 가져오기</button>");
    expect(html.match(/disabled=""/g)?.length).toBe(4);
  });

  it("실패는 폼 안에 한 줄, 연결하는 중에는 칸과 버튼을 막는다", () => {
    expect(form("수자인 연결을 저장하지 못했어요. 아이디와 비밀번호를 확인해 주세요.")).toContain(
      "수자인 연결을 저장하지 못했어요. 아이디와 비밀번호를 확인해 주세요."
    );
    const busy = form(null, true);
    expect(busy).toContain("연결하는 중…");
    expect(busy.match(/disabled=""/g)?.length).toBe(4);
  });
});

describe("가져온 결과", () => {
  const items = [
    {
      key: "55555555-5555-4555-8555-555555555555",
      kind: "interim" as const,
      installment: 3,
      label: null,
      scheduledAmount: "3100000",
      dueDate: null,
      paidAmount: null,
      paidDate: null,
      actualPaidDate: null,
      matchedPaymentId: PAYMENT_ID,
      changedFields: ["scheduledAmount" as const],
      unreadFields: [],
    },
    {
      key: "66666666-6666-4666-8666-666666666666",
      kind: "option" as const,
      installment: null,
      label: "발코니 확장 외 2 · 계약금",
      scheduledAmount: "1000000",
      dueDate: `${year}-11-20`,
      paidAmount: null,
      paidDate: null,
      actualPaidDate: null,
      matchedPaymentId: null,
      changedFields: ["scheduledAmount" as const, "dueDate" as const, "label" as const],
      unreadFields: [],
    },
  ];
  const changes = previewChanges(items, plan(null).payments);
  const results = (unchecked: ReadonlySet<string> = new Set(), unreadLine: string | null = null) =>
    renderToStaticMarkup(
      <BrandSyncResults
        changes={changes}
        unreadLine={unreadLine}
        unchecked={unchecked}
        busy={false}
        canApply
        onToggle={() => undefined}
        onApply={() => undefined}
        onClose={() => undefined}
      />
    );

  it("달라진 내용을 사람 말로, 처음부터 모두 골라 둔다 — 'N건 반영하기'와 '닫기'", () => {
    const html = results(new Set(), "읽지 못한 칸이 1개 있어요 · 금액 칸을 읽지 못했어요.");
    expect(html).toContain(">달라진 내용 2건</h3>");
    expect(html).toContain("중도금 3회차");
    expect(html).toContain(" · 예정 금액 3,000,000원 → 3,100,000원");
    expect(html).toContain("새 일정");
    expect(html).toContain(" · 발코니 확장 외 2 계약금 1,000,000원 · 11월 20일");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain(">2건 반영하기</button>");
    expect(html).toMatch(/<button(?=[^>]*type="button")[^>]*>닫기<\/button>/);
    expect(html).toContain("읽지 못한 칸이 1개 있어요 · 금액 칸을 읽지 못했어요.");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).not.toMatch(/scheduledAmount|dueDate|changedFields/);
    expect(html).not.toContain("실제 납부 실행 버튼");
    expect(html).not.toContain("신축 조회");
  });

  it("뺀 항목은 세지 않고, 모두 빼면 반영 버튼이 꺼진다", () => {
    expect(results(new Set([items[0]!.key]))).toContain(">1건 반영하기</button>");
    const none = results(new Set(items.map((item) => item.key)));
    expect(none).toMatch(/<button(?=[^>]*disabled="")[^>]*>0건 반영하기<\/button>/);
  });

  it("바뀐 게 없으면 한 줄만", () => {
    const html = renderToStaticMarkup(
      <BrandSyncResults
        changes={[]}
        unreadLine={null}
        unchecked={new Set()}
        busy={false}
        canApply
        onToggle={() => undefined}
        onApply={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(html).toContain(">바뀐 내용이 없어요</p>");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});
