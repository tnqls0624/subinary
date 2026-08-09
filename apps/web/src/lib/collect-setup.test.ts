/* ---------------------------------------------------------------------------
 * 수집 설정 템플릿이 **실제 수집 계약을 만족하는가**를 검증한다.
 *
 * 이 테스트가 지키는 것: 사용자가 자동화 앱에 붙여넣는 문자열이 틀리면 이 기능
 * 전체가 무의미해진다(수집이 0이 되고, 사용자는 앱의 모든 화면이 빈 이유를 알 수
 * 없다). 그래서 화면 렌더링이 아니라 **템플릿 문자열 자체**를 계약(zod)으로 검사한다.
 * ------------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import { cardSmsIngestRequestSchema } from "@family/contracts";

import {
  COLLECT_PATH,
  buildCollectSetup,
  buildJsonBody,
  buildSetupClipboardText,
} from "./collect-setup";

const TOKEN = "a".repeat(64);
const BASE = "https://api.example.com";

/** 실제 카드 문자(줄바꿈·따옴표 포함) — JSON 이스케이프 사고를 재현하는 재료. */
const SAMPLE_SMS = `신한카드 승인\n12,500원 일시불\n07/15 19:32 "스타벅스" 강남점`;

describe("buildJsonBody — 템플릿과 예시가 같은 함수에서 나온다", () => {
  it("실제 값으로 만든 본문이 수집 계약을 통과한다", () => {
    const body = buildJsonBody({
      eventId: "sms-1786108440-15447200",
      sender: "15447200",
      content: SAMPLE_SMS,
    });

    const parsed = cardSmsIngestRequestSchema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    // eventId가 빠지면 서버가 수신 시각 창으로 추측하고, 같은 창의 별개 결제가
    // 지출에서 누락된다(P0-9). 계약상 optional이라 zod가 잡아주지 않으므로 직접 본다.
    expect(parsed.success && parsed.data.eventId).toBe("sms-1786108440-15447200");
  });

  it("줄바꿈·따옴표가 든 문자도 깨지지 않게 이스케이프한다", () => {
    const body = buildJsonBody({
      eventId: "e-1",
      sender: "15447200",
      content: SAMPLE_SMS,
    });
    expect(JSON.parse(body).content).toBe(SAMPLE_SMS);
  });
});

describe.each(["ios", "android", "other"] as const)(
  "buildCollectSetup(%s)",
  (platform) => {
    const plan = buildCollectSetup({
      platform,
      collectToken: TOKEN,
      apiBaseUrl: BASE,
      deviceName: "엄마 휴대폰",
    });

    it("실제 수집 라우트를 가리킨다", () => {
      expect(plan.endpoint).toBe(`${BASE}${COLLECT_PATH[plan.route]}`);
      expect(plan.method).toBe("POST");
    });

    it("토큰은 Authorization 헤더로만 나간다(URL·본문 금지)", () => {
      const authorization = plan.headers.find(
        (h) => h.label === "Authorization",
      );
      expect(authorization?.value).toBe(`Bearer ${TOKEN}`);
      // Bearer 자격증명이 주소에 섞이면 프록시 로그·브라우저 히스토리에 남는다.
      expect(plan.endpoint).not.toContain(TOKEN);
      expect(plan.endpoint).not.toContain("?");
      expect(plan.body).not.toContain(TOKEN);
    });

    it("멱등 키를 보내는 자리가 반드시 있다", () => {
      const hasEventIdHeader = plan.headers.some(
        (h) => h.label.toLowerCase() === "x-event-id",
      );
      const hasEventIdField =
        plan.route === "json" && "eventId" in JSON.parse(plan.body);
      expect(hasEventIdHeader || hasEventIdField).toBe(true);
      expect(plan.eventIdHint).not.toBe("");
    });

    it("복사 텍스트에 주소·헤더·본문이 모두 들어간다", () => {
      const text = buildSetupClipboardText(plan, "엄마 휴대폰");
      expect(text).toContain(plan.endpoint);
      expect(text).toContain(`Bearer ${TOKEN}`);
      expect(text).toContain(plan.body.split("\n")[0]);
      // 토큰은 한 번만 — 여러 곳에 흩뿌리면 지우기도 어렵다.
      expect(text.split(TOKEN).length - 1).toBe(1);
    });
  },
);

describe("iOS(JSON 경로)", () => {
  const plan = buildCollectSetup({
    platform: "ios",
    collectToken: TOKEN,
    apiBaseUrl: BASE,
  });

  it("card-sms-token(JSON) 경로를 쓴다", () => {
    expect(plan.route).toBe("json");
    expect(plan.endpoint).toBe(`${BASE}/v1/mobile-events/card-sms-token`);
    expect(plan.contentType).toBe("application/json");
  });

  it("본문 템플릿이 유효한 JSON이고 계약의 필수 필드를 모두 가진다", () => {
    const template = JSON.parse(plan.body) as Record<string, unknown>;
    expect(Object.keys(template).sort()).toEqual([
      "content",
      "eventId",
      "sender",
    ]);
    // 자리표시자를 실제 값으로 바꾸면 그대로 계약을 통과해야 한다.
    const filled = cardSmsIngestRequestSchema.safeParse({
      ...template,
      eventId: "sms-20260715-193200-15447200",
      sender: "15447200",
      content: SAMPLE_SMS,
    });
    expect(filled.success).toBe(true);
  });

  it("receivedAt은 넣지 않는다 — 단축어 형식(+09:00)이 계약(UTC Z)을 어긴다", () => {
    expect(plan.body).not.toContain("receivedAt");
    // 계약이 오프셋 표기를 거부한다는 사실 자체를 고정한다(이게 바뀌면 템플릿을 넓힐 수 있다).
    const withOffset = cardSmsIngestRequestSchema.safeParse({
      sender: "15447200",
      content: "테스트",
      receivedAt: "2026-07-15T19:32:00+09:00",
    });
    expect(withOffset.success).toBe(false);
  });

  it("본문 필드마다 무엇을 넣을지 알려준다(단축어는 칸 단위로 입력한다)", () => {
    expect(plan.bodyFields.map((f) => f.label)).toEqual([
      "eventId",
      "sender",
      "content",
    ]);
  });
});

describe("Android(text 경로)", () => {
  const plan = buildCollectSetup({
    platform: "android",
    collectToken: TOKEN,
    apiBaseUrl: BASE,
  });

  it("card-sms-text 경로를 쓴다 — 매직 텍스트는 문자열 치환이라 JSON이 깨진다", () => {
    expect(plan.route).toBe("text");
    expect(plan.endpoint).toBe(`${BASE}/v1/mobile-events/card-sms-text`);
    expect(plan.contentType).toContain("text/plain");
  });

  it("본문은 문자 원문 매직 텍스트 하나뿐이다(따옴표·JSON 금지)", () => {
    expect(plan.body).toBe("[sms_message]");
  });

  it("멱등 키와 발신자를 헤더로 보낸다(헤더 값엔 개행이 없어 안전)", () => {
    const headers = Object.fromEntries(
      plan.headers.map((h) => [h.label, h.value]),
    );
    expect(headers["X-Sender"]).toBe("[sms_number]");
    // 문자마다 달라야 한다 → 발신번호만으로는 부족하고 시각이 섞여야 한다.
    expect(headers["X-Event-Id"]).toContain("[sms_number]");
    expect(headers["X-Event-Id"]).not.toBe("[sms_number]");
  });

  it("버전마다 다른 매직 텍스트에는 바꿔 넣으라는 설명이 붙는다", () => {
    const eventId = plan.headers.find((h) => h.label === "X-Event-Id");
    expect(eventId?.note).toBeTruthy();
  });
});

describe("baseUrl 조립", () => {
  it("끝의 슬래시를 중복시키지 않는다", () => {
    const plan = buildCollectSetup({
      platform: "ios",
      collectToken: TOKEN,
      apiBaseUrl: "https://api.example.com/",
    });
    expect(plan.endpoint).toBe("https://api.example.com/v1/mobile-events/card-sms-token");
  });
});
