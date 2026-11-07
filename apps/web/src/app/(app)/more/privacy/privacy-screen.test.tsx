import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_HOUSEHOLD_CONSENT_VERSION,
  type PrivacyOverview,
} from "@family/contracts";

const state = vi.hoisted(() => ({
  overview: undefined as PrivacyOverview | undefined,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/more/privacy",
  useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authedFetch: vi.fn() }),
}));
vi.mock("@/lib/household-context", () => ({
  useHousehold: () => ({ householdId: "00000000-0000-4000-8000-000000000001" }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    isLoading: false,
    data: state.overview,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));

import PrivacyPage from "./page";
import { RetentionGuide } from "./retention-guide";

const thisYear = new Date().getFullYear();

const base: PrivacyOverview = {
  householdId: "00000000-0000-4000-8000-000000000001",
  currentVersion: CURRENT_HOUSEHOLD_CONSENT_VERSION,
  activeConsent: null,
  needsRenewal: false,
  history: [],
  retention: {
    policy: "none",
    smsEventCount: 1280,
    storedBytes: 4_096_000,
    oldestReceivedAt: `${thisYear}-03-02T03:00:00.000Z`,
    newestReceivedAt: `${thisYear}-11-01T03:00:00.000Z`,
    objectKeyPrefix: "card-sms/00000000-0000-4000-8000-000000000001/",
    recentPurges: [],
  },
  myMemberId: "00000000-0000-4000-8000-000000000002",
  myActiveDeviceCount: 2,
};

beforeEach(() => {
  state.overview = base;
});

describe("개인정보 화면", () => {
  it("기기·보관 현황과 보존 정책 진입점을 보여 주고 저장 경로·용량·개발 용어를 드러내지 않는다", () => {
    const html = renderToStaticMarkup(<PrivacyPage />);
    expect(html).toContain("문자 보내는 기기 2대");
    expect(html).toContain('href="/devices"');
    expect(html).toContain("카드 문자 1,280건 보관 중 · 3월부터");
    expect(html).toContain("받은 문자는 자동으로 지워지지 않아요");
    expect(html).toContain(">자세히</button>");
    expect(html).toContain("원문 보존 정책 바꾸기");
    for (const jargon of ["card-sms/", "KB", "MB", "데이터베이스", "파일 저장소", "days_30", "after_parse"]) {
      expect(html).not.toContain(jargon);
    }
  });

  it("가족 가입 동의 절차는 없앴다 — 동의 상태·동의 버튼·철회를 보여 주지 않는다(2026-11-05)", () => {
    const html = renderToStaticMarkup(<PrivacyPage />);
    for (const consentWord of ["동의하기", "동의 중", "동의하지 않은", "동의 내용", "동의 기록", "철회"]) {
      expect(html).not.toContain(consentWord);
    }
    expect(html).not.toContain('aria-label="더보기"');
  });

  it("보관한 문자가 없으면 그렇게 말한다", () => {
    state.overview = {
      ...base,
      retention: { ...base.retention, smsEventCount: 0, oldestReceivedAt: null },
    };
    expect(renderToStaticMarkup(<PrivacyPage />)).toContain("보관 중인 카드 문자가 없어요");
  });

  it("정책이 none이 아니면 선택한 정책 이름을 보여 준다", () => {
    state.overview = {
      ...base,
      retention: { ...base.retention, policy: "days_30" },
    };
    expect(renderToStaticMarkup(<PrivacyPage />)).toContain("보존 정책 · 30일");
  });

  it("불러오지 못하면 공용 오류 상태로 원인 한 줄과 '다시 불러오기'를 보여 준다", () => {
    state.overview = undefined;
    const html = renderToStaticMarkup(<PrivacyPage />);
    expect(html).toMatch(/<p role="alert"[^>]*>개인정보 설정을 불러오지 못했어요<\/p>/);
    expect(html).toMatch(/<button[^>]*>다시 불러오기<\/button>/);
    expect(html).not.toContain("문자 보내는 기기");
  });
});

describe("개인정보 › 보관 안내 시트", () => {
  it("수집을 멈추는 길과 보존 정책을 구분해서 말한다", () => {
    const html = renderToStaticMarkup(<RetentionGuide policy="none" />);
    expect(html).toContain("문자 연동 › 기기 ⋯ › 연결 해제");
    expect(html).toMatch(/<a[^>]*href="\/devices"[^>]*>문자 연동 열기/);
    expect(html).toContain("지금 보존 정책은");
    expect(html).toContain("계속");
    expect(html).toContain("한꺼번에 지워지지는");
  });

  it("문자 연동 화면에 없는 말('폐기')과 갈 곳 없는 부탁('알려 주세요')은 쓰지 않는다", () => {
    const html = renderToStaticMarkup(<RetentionGuide policy="after_parse" />);
    expect(html).not.toContain("폐기");
    expect(html).not.toContain("알려 주세요");
  });
});
