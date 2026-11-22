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
  AUTHORIZATION_HEADER,
  COLLECT_PATH,
  buildCollectSetup,
  buildJsonBody,
  buildSetupClipboardText,
  buildSetupCopySections,
  collectWizardBackAction,
  collectWizardCloseNeedsConfirm,
  collectWizardReceived,
  defaultDevicePlatform,
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

describe("defaultDevicePlatform — 등록 창의 기기 종류 기본값", () => {
  it("앱에서는 지금 휴대폰의 종류, 웹이면 Android(주 사용 기기)", () => {
    expect(defaultDevicePlatform("android")).toBe("android");
    expect(defaultDevicePlatform("ios")).toBe("ios");
    // 예전 기본값은 iOS라, 기본값 그대로 등록한 Android 사용자가 단축어 안내를 받았다.
    expect(defaultDevicePlatform("web")).toBe("android");
  });
});

describe("buildSetupCopySections — 2단계 칸마다 복사", () => {
  const rowsOf = (platform: "ios" | "android" | "other") =>
    buildSetupCopySections(
      buildCollectSetup({ platform, collectToken: TOKEN, apiBaseUrl: BASE }),
      { hasKey: true },
    ).flatMap((section) => section.rows);

  it("Android: 주소·헤더 이름/값·본문을 칸마다 복사할 수 있다(요청 방식은 앱에서 고르는 값)", () => {
    const plan = buildCollectSetup({
      platform: "android",
      collectToken: TOKEN,
      apiBaseUrl: BASE,
    });
    const rows = rowsOf("android");
    const copyable = rows.filter((row) => row.copyable).map((row) => row.value);
    expect(copyable).toContain(plan.endpoint);
    for (const header of plan.headers) {
      expect(copyable).toContain(header.label);
      expect(copyable).toContain(header.value);
    }
    expect(copyable).toContain(plan.body);
    expect(rows.find((row) => row.id === "method")).toMatchObject({
      value: "POST",
      copyable: false,
    });
  });

  it.each(["ios", "android", "other"] as const)(
    "%s: 열쇠는 Authorization 헤더 값 한 칸에만 있고, 그 칸만 '열쇠를 챙겼다'로 센다",
    (platform) => {
      const rows = rowsOf(platform);
      const withToken = rows.filter((row) => row.value.includes(TOKEN));
      expect(withToken).toHaveLength(1);
      expect(withToken[0]).toMatchObject({
        value: `Bearer ${TOKEN}`,
        holdsKey: true,
        name: `${AUTHORIZATION_HEADER} 헤더 값`,
      });
      expect(rows.filter((row) => row.holdsKey)).toHaveLength(1);
    },
  );

  it.each(["ios", "android", "other"] as const)(
    "%s: 복사 버튼 이름이 칸마다 다르다(화면 읽기 사용자가 어느 칸인지 알 수 있게)",
    (platform) => {
      const names = rowsOf(platform)
        .filter((row) => row.copyable)
        .map((row) => row.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names.every((name) => name.trim() !== "")).toBe(true);
    },
  );

  it.each(["ios", "android", "other"] as const)(
    "%s: 열쇠가 없으면(설정 계속하기) Authorization 값은 자리표시자라 복사할 수 없다",
    (platform) => {
      const placeholder = "(등록할 때 받은 토큰)";
      const rows = buildSetupCopySections(
        buildCollectSetup({ platform, collectToken: placeholder, apiBaseUrl: BASE }),
        { hasKey: false },
      ).flatMap((section) => section.rows);
      const authValue = rows.find((row) => row.holdsKey);
      // 값은 보여 주되, 그대로 붙여 이미 넣어 둔 진짜 열쇠를 덮어쓰지 않게 복사 버튼은 없다.
      expect(authValue).toMatchObject({
        value: `Bearer ${placeholder}`,
        copyable: false,
      });
      expect(authValue?.note).toContain("이미 넣었다면 그대로 두세요");
      expect(
        rows.filter((row) => row.copyable && row.value.includes(placeholder)),
      ).toHaveLength(0);
      // 나머지 칸(헤더 이름 포함)은 그대로 복사할 수 있다.
      expect(rows.find((row) => row.name === `${AUTHORIZATION_HEADER} 헤더 이름`)).toMatchObject({
        copyable: true,
      });
      expect(rows.find((row) => row.id === "url")?.copyable).toBe(true);
    },
  );

  it("iOS: 단축어에 키마다 적는 본문 키 이름도 복사할 수 있다", () => {
    const keys = rowsOf("ios")
      .filter((row) => row.id.startsWith("field-"))
      .map((row) => row.value);
    expect(keys).toEqual(["eventId", "sender", "content"]);
  });
});

describe("collectWizardReceived — '연결이 끝났어요' 판정", () => {
  const OLD = "2026-11-06T08:55:00.000Z";
  const NEW = "2026-11-22T12:00:00.000Z";

  it("토큰을 재발급한 기기에 예전 문자만 있으면 아직 연결된 게 아니다", () => {
    // 2026-11-22: 예전 firstEventAt 으로 판정해 재발급 직후 토큰 대신 성공 화면이 떴다.
    expect(
      collectWizardReceived({
        hasIssuedKey: true,
        baselineLastEventAt: OLD,
        lastEventAt: OLD,
        firstEventAt: "2026-07-18T11:52:00.000Z",
      }),
    ).toBe(false);
  });

  it("토큰을 받은 뒤 문자가 새로 들어오면 연결된 것이다", () => {
    expect(
      collectWizardReceived({
        hasIssuedKey: true,
        baselineLastEventAt: OLD,
        lastEventAt: NEW,
        firstEventAt: "2026-07-18T11:52:00.000Z",
      }),
    ).toBe(true);
    // 새로 등록한 기기는 받은 순간 문자가 없다 — 첫 문자가 오면 연결된 것이다.
    expect(
      collectWizardReceived({
        hasIssuedKey: true,
        baselineLastEventAt: null,
        lastEventAt: NEW,
        firstEventAt: NEW,
      }),
    ).toBe(true);
  });

  it("토큰 없이 '설정 계속하기'로 열었으면 첫 문자가 있는지로 본다", () => {
    expect(
      collectWizardReceived({
        hasIssuedKey: false,
        baselineLastEventAt: OLD,
        lastEventAt: OLD,
        firstEventAt: OLD,
      }),
    ).toBe(true);
    expect(
      collectWizardReceived({
        hasIssuedKey: false,
        baselineLastEventAt: null,
        lastEventAt: null,
        firstEventAt: null,
      }),
    ).toBe(false);
  });
});

describe("collectWizardCloseNeedsConfirm — 열쇠를 챙기기 전 닫기", () => {
  it("방금 받은 열쇠를 아직 챙기지 않았으면 닫기 전에 묻는다", () => {
    expect(
      collectWizardCloseNeedsConfirm({
        hasIssuedKey: true,
        keyKept: false,
        received: false,
      }),
    ).toBe(true);
  });

  it("복사했거나('옮겨 적었어요' 포함) 첫 문자를 받았거나 열쇠가 없는 이어가기면 묻지 않는다", () => {
    expect(
      collectWizardCloseNeedsConfirm({
        hasIssuedKey: true,
        keyKept: true,
        received: false,
      }),
    ).toBe(false);
    expect(
      collectWizardCloseNeedsConfirm({
        hasIssuedKey: true,
        keyKept: false,
        received: true,
      }),
    ).toBe(false);
    expect(
      collectWizardCloseNeedsConfirm({
        hasIssuedKey: false,
        keyKept: false,
        received: false,
      }),
    ).toBe(false);
  });
});

describe("collectWizardBackAction — 안드로이드 뒤로 버튼", () => {
  it("닫기 확인 시트가 떠 있으면 그 시트만 닫는다(뒤로는 한 겹씩)", () => {
    expect(
      collectWizardBackAction({ confirmOpen: true, needsConfirm: true }),
    ).toBe("dismiss-confirm");
  });

  it("열쇠를 챙기기 전이면 닫기 버튼처럼 먼저 묻고, 아니면 창을 닫는다(앞 화면으로 가지 않는다)", () => {
    expect(
      collectWizardBackAction({ confirmOpen: false, needsConfirm: true }),
    ).toBe("ask");
    expect(
      collectWizardBackAction({ confirmOpen: false, needsConfirm: false }),
    ).toBe("close");
  });
});
