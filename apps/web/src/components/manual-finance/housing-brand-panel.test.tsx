import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HousingBrandConnection } from "@family/contracts";
import { HousingBrandPanel } from "./housing-brand-panel";

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authedFetch: async () => { throw new Error("unused"); } }),
}));

const connection = (status: HousingBrandConnection["status"]): HousingBrandConnection => ({
  id: "11111111-1111-4111-8111-111111111111",
  planId: "22222222-2222-4222-8222-222222222222",
  brand: "sujain",
  status,
  statusMessage: status === "failed" ? "수자인 조회를 끝내지 못했어요." : null,
  credentialsStored: true,
  version: 1,
  lastFetchAt: null,
  lastSuccessAt: null,
  canManage: true,
});

describe("HousingBrandPanel", () => {
  it("stays on the housing schedule form with sujain-only brand and masked password field", () => {
    const html = renderToStaticMarkup(
      <HousingBrandPanel
        householdId="33333333-3333-4333-8333-333333333333"
        planId="22222222-2222-4222-8222-222222222222"
        planVersion={1}
        connection={connection("connected")}
        canEdit
        onConnectionChange={() => undefined}
        onApplied={() => undefined}
      />
    );
    expect(html).toContain("수자인 신축 조회");
    expect(html).toContain("연동 상태 · 연결됨");
    expect(html).toContain("수자인");
    expect(html).toContain('type="password"');
    expect(html).toContain("저장됨 · 다시 보이지 않아요");
    expect(html).toContain("확인");
    expect(html).not.toContain("호반");
    expect(html).not.toContain("SYNTHETIC");
    expect(html).not.toContain("password123");
  });

  it("does not nest a form or submit button that would bubble into the housing-plan editor", () => {
    const html = renderToStaticMarkup(
      <HousingBrandPanel
        householdId="33333333-3333-4333-8333-333333333333"
        planId="22222222-2222-4222-8222-222222222222"
        planVersion={1}
        connection={null}
        canEdit
        onConnectionChange={() => undefined}
        onApplied={() => undefined}
      />
    );
    // PlanEditor already wraps this panel in <form>. A nested form + type=submit
    // bubbles into editor.save() and closes the housing editor with no toast.
    expect(html).not.toMatch(/<form\b/);
    expect(html).toMatch(
      /<button(?=[^>]*type="button")[^>]*>수자인 연결 저장<\/button>/
    );
    expect(html).not.toMatch(
      /<button(?=[^>]*type="submit")[^>]*>[^<]*연결 저장/
    );
  });

  it("shows 수자인 as fixed brand text, not a disabled dropdown", () => {
    const html = renderToStaticMarkup(
      <HousingBrandPanel
        householdId="33333333-3333-4333-8333-333333333333"
        planId="22222222-2222-4222-8222-222222222222"
        planVersion={1}
        connection={null}
        canEdit
        onConnectionChange={() => undefined}
        onApplied={() => undefined}
      />
    );
    expect(html).toContain("브랜드");
    expect(html).toContain("수자인");
    expect(html).not.toMatch(/<select\b/);
  });

  it("asks to save the housing before connecting on a new plan", () => {
    const html = renderToStaticMarkup(
      <HousingBrandPanel
        householdId="33333333-3333-4333-8333-333333333333"
        planId={null}
        planVersion={null}
        connection={null}
        canEdit
        requiresSavedPlan
        onConnectionChange={() => undefined}
        onApplied={() => undefined}
      />
    );
    expect(html).toContain("주택을 먼저 저장한 뒤");
    expect(html).not.toContain("수자인 연결 저장");
  });

  it("renders the persisted connection status message instead of a hardcoded extra-auth line", () => {
    const html = renderToStaticMarkup(
      <HousingBrandPanel
        householdId="33333333-3333-4333-8333-333333333333"
        planId="22222222-2222-4222-8222-222222222222"
        planVersion={1}
        connection={connection("failed")}
        canEdit
        onConnectionChange={() => undefined}
        onApplied={() => undefined}
      />
    );
    expect(html).toContain("수자인 조회를 끝내지 못했어요.");
    expect(html).not.toContain("공식 페이지에서 추가 인증");
  });

  it("keeps every brand-dependent string and the saved-credential field names exactly as before", () => {
    // 글자는 HOUSING_BRAND_INFO 에서 오지만 수자인은 예전 글자와 한 글자도 다르지 않아야 한다(한 텍스트 노드).
    const edit = renderToStaticMarkup(
      <HousingBrandPanel
        householdId="33333333-3333-4333-8333-333333333333"
        planId="22222222-2222-4222-8222-222222222222"
        planVersion={1}
        connection={null}
        canEdit
        onConnectionChange={() => undefined}
        onApplied={() => undefined}
      />
    );
    expect(edit).toContain('aria-label="수자인 신축 조회"');
    expect(edit).toContain(">수자인 신축 조회</h3>");
    expect(edit).toContain(
      ">공식 수자인 아이디·비밀번호로 이 주택만 연결해요. 확인·새로고침을 눌렀을 때만 분양대금과 옵션을 함께 읽어요.</p>"
    );
    expect(edit).toContain(">수자인</p>");
    expect(edit).toContain(">수자인 아이디</label>");
    expect(edit).toContain(">수자인 비밀번호</label>");
    expect(edit).toContain(">수자인 연결 저장</button>");
    // 브라우저에 저장된 자격 증명 연결을 지키려고 칸 이름은 그대로 둔다.
    expect(edit).toContain('name="sujain-login"');
    expect(edit).toContain('name="sujain-password"');

    const saveFirst = renderToStaticMarkup(
      <HousingBrandPanel
        householdId="33333333-3333-4333-8333-333333333333"
        planId={null}
        planVersion={null}
        connection={null}
        canEdit
        requiresSavedPlan
        onConnectionChange={() => undefined}
        onApplied={() => undefined}
      />
    );
    expect(saveFirst).toContain(">주택을 먼저 저장한 뒤 수자인을 연결할 수 있어요.</p>");
  });

  it("does not render the same status sentence twice when only connection.statusMessage is set", () => {
    const html = renderToStaticMarkup(
      <HousingBrandPanel
        householdId="33333333-3333-4333-8333-333333333333"
        planId="22222222-2222-4222-8222-222222222222"
        planVersion={1}
        connection={connection("failed")}
        canEdit
        onConnectionChange={() => undefined}
        onApplied={() => undefined}
      />
    );
    const needle = "수자인 조회를 끝내지 못했어요.";
    const first = html.indexOf(needle);
    const second = html.indexOf(needle, first + needle.length);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBe(-1);
  });
});
