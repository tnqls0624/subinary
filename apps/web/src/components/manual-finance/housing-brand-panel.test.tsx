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
});
