/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 문자 수집 자동화 설정 템플릿 (로드맵 C-2)
 *
 * 사용자가 자동화 앱에 **그대로 옮겨 적을 값**을 만든다. 여기서 만든 문자열이
 * 틀리면 이 앱으로 들어오는 데이터가 0이 되므로, 계약의 정본은 추측하지 않고
 * `docs/addendum-card-sms-token-ingest.md` §3-1(P0-9가 확정)을 따른다.
 *
 * 렌더링과 분리된 순수 모듈인 이유: "생성된 템플릿이 실제 수집 계약을 만족하는가"를
 * 컴포넌트 없이 테스트할 수 있어야 한다(collect-setup.test.ts가 zod 계약으로 검증).
 *
 * 두 가지 설계 결정과 근거:
 *
 * 1. **Android는 `card-sms-text`, iOS는 `card-sms-token`(JSON)을 쓴다.**
 *    MacroDroid는 매직 텍스트(`[sms_message]`)를 **문자열 치환**으로 본문에 끼워
 *    넣는다. 카드 문자에는 줄바꿈과 따옴표가 흔해서 JSON 템플릿에 그대로 들어가면
 *    본문이 깨져 400이 난다 — `card-sms-text`가 존재하는 이유가 이것이다.
 *    iOS 단축어는 JSON 본문을 앱이 직접 만들어 주므로(이스케이프를 앱이 처리)
 *    JSON 경로가 안전하고 필드 대응이 명확하다.
 *
 * 2. **iOS 템플릿에 `receivedAt`을 넣지 않는다.** 계약의 `receivedAt`은 UTC ISO
 *    (`Z`)만 받는데 단축어의 '현재 날짜'는 로컬 오프셋(`+09:00`)을 붙이기 쉽고,
 *    그러면 400으로 수집이 통째로 실패한다. `eventId`를 보내므로 멱등 정확도는
 *    이미 최상(`client`)이고, 저장용 수신 시각은 서버가 now()로 채운다.
 *
 * 보안: collect token은 Bearer 자격증명이다. **URL 쿼리에 절대 넣지 않는다**
 * (프록시·로그·브라우저 히스토리에 남는다). 헤더 값으로만 나간다.
 * ------------------------------------------------------------------------- */
import type { DevicePlatform } from "@family/contracts";

/** 수집 경로 — 본문을 JSON으로 보내는지, 문자 원문 그대로 보내는지. */
export type CollectRoute = "json" | "text";

/** 사용자가 자동화 앱의 한 칸에 그대로 옮겨 적는 값. */
export interface SetupEntry {
  label: string;
  value: string;
  /** 값 그대로 쓰면 안 되는 자리(버전마다 이름이 다른 매직 텍스트 등)의 설명. */
  note?: string;
}

export interface CollectSetupPlan {
  platform: DevicePlatform;
  /** 안내에 쓰는 자동화 앱 이름. */
  appName: string;
  /** 설치 안내 문구(앱 스토어로 보내기 전에 무엇을 하는 앱인지 알려준다). */
  appDescription: string;
  /** 스토어/도움말 링크. 없으면 null(기본 설치 앱). */
  appStoreUrl: string | null;
  appStoreCta: string;
  /** 자동화 앱에서 만들 것 — 트리거/동작. UI 메뉴 이름은 버전마다 다르다. */
  triggerSummary: string;
  actionSummary: string;
  route: CollectRoute;
  method: "POST";
  endpoint: string;
  contentType: string;
  /** Authorization 포함 — 화면·클립보드에 그대로 인쇄된다. */
  headers: SetupEntry[];
  bodyLabel: string;
  /** 본문에 넣을 값. json이면 JSON 문자열, text면 문자 원문 매직 텍스트 하나. */
  body: string;
  /** JSON 경로에서 필드 단위로 입력하는 앱(단축어)을 위한 필드별 설명. */
  bodyFields: SetupEntry[];
  /** `eventId`를 문자마다 다르게 만드는 방법(§3-1). */
  eventIdHint: string;
  /** 설정 화면에 같이 띄울 주의사항. */
  cautions: string[];
}

/** JSON 본문 필드 자리표시자(단축어에서 사용자가 채울 값). */
const IOS_PLACEHOLDER = {
  eventId: "sms-<현재 날짜: yyyyMMdd-HHmmss>-<보낸 사람>",
  sender: "<보낸 사람>",
  content: "<문자 내용>",
} as const;

/**
 * MacroDroid 매직 텍스트. 이름은 **버전마다 다르다** — §3-1이 "액션 편집기의 매직
 * 텍스트 선택기에서 고르라"고 못 박은 이유다. 그래서 값은 그대로 붙여넣을 수 있게
 * 인쇄하되, `note`로 선택기에서 바꿔야 할 수 있음을 반드시 함께 알린다.
 */
const MACRODROID_MAGIC = {
  message: "[sms_message]",
  number: "[sms_number]",
  triggerTime: "[triggertimestamp]",
} as const;

/**
 * 수집 API 경로. 컨트롤러(`apps/api/src/card-sms/card-sms.controller.ts`)의
 * 라우트와 1:1이며, 테스트가 이 상수를 계약으로 검사한다.
 */
export const COLLECT_PATH: Readonly<Record<CollectRoute, string>> = {
  json: "/v1/mobile-events/card-sms-token",
  text: "/v1/mobile-events/card-sms-text",
};

/** 연결 테스트(인증만 확인) 경로. */
export const PING_PATH = "/v1/mobile-events/ping-token";

/**
 * JSON 본문을 만드는 **단일 소스**. 자리표시자를 넣으면 사용자용 템플릿이,
 * 실제 값을 넣으면 예시 요청이 된다 — 테스트가 후자를 계약(zod)으로 검증하므로
 * 사용자가 붙여넣는 문자열과 검증 대상이 갈라지지 않는다.
 */
export function buildJsonBody(values: {
  eventId: string;
  sender: string;
  content: string;
}): string {
  return JSON.stringify(
    {
      eventId: values.eventId,
      sender: values.sender,
      content: values.content,
    },
    null,
    2,
  );
}

/** URL 끝의 `/`를 없애 `//v1/...`이 되는 것을 막는다. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * `eventId`를 만드는 방법(§3-1의 "좋은 eventId의 조건"). 조건은 둘뿐이다 —
 * 문자마다 다르고, 같은 문자를 다시 보낼 때는 같다.
 */
const EVENT_ID_HINT: Readonly<Record<DevicePlatform, string>> = {
  android:
    "문자마다 다른 값이 되도록 발신번호와 트리거 시각(초 단위 포함)을 이어 붙여요. " +
    "분 단위까지만 쓰면 같은 분에 일어난 두 결제가 하나로 합쳐져 한 건이 사라져요.",
  ios:
    "'현재 날짜'를 yyyyMMdd-HHmmss 형식으로 만들어 보낸 사람과 이어 붙여요. " +
    "단축어를 직접 다시 실행하면 새 값이 되는데, 그건 '다시 보낸 것'이 아니라 " +
    "'다시 만든 것'이라 의도한 동작이에요.",
  other:
    "문자 한 통당 하나의 고유값이면 돼요(200자 이하). 같은 문자를 다시 보낼 때는 " +
    "같은 값이어야 재전송이 거래를 두 배로 만들지 않아요.",
};

export interface CollectSetupInput {
  platform: DevicePlatform;
  /** 등록/회전 응답에서 1회만 노출되는 raw collect token. */
  collectToken: string;
  /** `API_BASE_URL` — 화면이 주입한다(테스트가 고정값을 넣을 수 있게). */
  apiBaseUrl: string;
  /** 안내 문구에 쓰는 장치 이름(선택). */
  deviceName?: string;
}

/** 플랫폼에 맞는 설정 템플릿 한 벌을 만든다. */
export function buildCollectSetup(input: CollectSetupInput): CollectSetupPlan {
  const { platform, collectToken, apiBaseUrl } = input;
  const authorization: SetupEntry = {
    label: "Authorization",
    value: `Bearer ${collectToken}`,
    note: "이 값이 곧 열쇠예요. 주소창이나 메모 공유에는 넣지 말아 주세요.",
  };

  if (platform === "android") {
    return {
      platform,
      appName: "MacroDroid",
      appDescription:
        "문자가 오면 자동으로 이 앱에 전달해 주는 자동화 앱이에요. 무료로 쓸 수 있어요.",
      appStoreUrl:
        "https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid",
      appStoreCta: "Play 스토어 열기",
      triggerSummary: "트리거: 문자(SMS) 수신",
      actionSummary: "동작: HTTP 요청 (POST)",
      route: "text",
      method: "POST",
      endpoint: joinUrl(apiBaseUrl, COLLECT_PATH.text),
      contentType: "text/plain; charset=utf-8",
      headers: [
        authorization,
        { label: "Content-Type", value: "text/plain; charset=utf-8" },
        {
          label: "X-Event-Id",
          value: `sms-${MACRODROID_MAGIC.number}-${MACRODROID_MAGIC.triggerTime}`,
          note:
            "매직 텍스트 이름은 MacroDroid 버전마다 달라요. 붙여넣은 뒤 " +
            `${MACRODROID_MAGIC.triggerTime} 자리는 액션 편집기의 매직 텍스트 ` +
            "선택기에서 '트리거 시각'(초 단위가 포함된 것)으로 골라 주세요.",
        },
        {
          label: "X-Sender",
          value: MACRODROID_MAGIC.number,
          note: "매직 텍스트 선택기에서 문자 발신번호를 고르면 돼요.",
        },
      ],
      bodyLabel: "본문 (문자 원문 그대로)",
      body: MACRODROID_MAGIC.message,
      bodyFields: [],
      eventIdHint: EVENT_ID_HINT.android,
      cautions: [
        "본문에는 문자 내용만 그대로 넣어 주세요. 따옴표로 감싸거나 다른 글자를 덧붙이면 읽지 못해요.",
        "배터리 최적화에서 MacroDroid를 제외해 주세요. 절전이 걸리면 문자가 와도 전달이 멈춰요.",
      ],
    };
  }

  if (platform === "ios") {
    return {
      platform,
      appName: "단축어",
      appDescription:
        "아이폰에 기본으로 설치된 앱이에요. '문자 받았을 때' 자동으로 실행되는 오토메이션을 만들어요.",
      // 기본 설치 앱이라 보통 스토어가 필요 없지만, 지운 경우를 위해 남긴다.
      appStoreUrl: "https://apps.apple.com/kr/app/id915249334",
      appStoreCta: "App Store에서 보기",
      triggerSummary: "오토메이션: 메시지를 받았을 때(보낸 사람: 카드사 번호)",
      actionSummary: "동작: 'URL의 콘텐츠 가져오기' — 방식 POST, 본문 JSON",
      route: "json",
      method: "POST",
      endpoint: joinUrl(apiBaseUrl, COLLECT_PATH.json),
      contentType: "application/json",
      headers: [
        authorization,
        { label: "Content-Type", value: "application/json" },
      ],
      bodyLabel: "본문 (JSON)",
      body: buildJsonBody(IOS_PLACEHOLDER),
      bodyFields: [
        {
          label: "eventId",
          value: IOS_PLACEHOLDER.eventId,
          note: "'현재 날짜'를 사용자 지정 형식 yyyyMMdd-HHmmss로 만들어 이어 붙여 주세요.",
        },
        {
          label: "sender",
          value: IOS_PLACEHOLDER.sender,
          note: "오토메이션이 넘겨주는 '보낸 사람'을 넣어요.",
        },
        {
          label: "content",
          value: IOS_PLACEHOLDER.content,
          note: "문자 내용을 그대로 넣어요.",
        },
      ],
      eventIdHint: EVENT_ID_HINT.ios,
      cautions: [
        "본문의 세 칸은 모두 '텍스트' 형식이에요.",
        "문자 수신 시각은 서버가 자동으로 기록해요. 직접 보내려면 UTC(Z) 형식이어야 해서 단축어에서는 맞추기 까다로워요.",
      ],
    };
  }

  return {
    platform: "other",
    appName: "직접 연동",
    appDescription:
      "문자를 전달할 수 있는 도구라면 무엇이든 아래 요청 한 번만 보내면 돼요.",
    appStoreUrl: null,
    appStoreCta: "",
    triggerSummary: "트리거: 카드사 문자 수신",
    actionSummary: "동작: 아래 주소로 POST 요청",
    route: "json",
    method: "POST",
    endpoint: joinUrl(apiBaseUrl, COLLECT_PATH.json),
    contentType: "application/json",
    headers: [
      authorization,
      { label: "Content-Type", value: "application/json" },
    ],
    bodyLabel: "본문 (JSON)",
    body: buildJsonBody({
      eventId: "<문자마다 다른 고유값>",
      sender: "<보낸 사람>",
      content: "<문자 내용>",
    }),
    bodyFields: [],
    eventIdHint: EVENT_ID_HINT.other,
    cautions: [
      "토큰은 Authorization 헤더로만 보내 주세요. 주소(URL)에 넣으면 기록에 남아요.",
      "같은 문자를 다시 보낼 때 eventId가 같으면 중복으로 저장되지 않아요.",
    ],
  };
}

/**
 * "설정 전체 복사하기" 한 번으로 나가는 텍스트. 자동화 앱과 이 화면을 오가며
 * 값을 하나씩 옮겨 적어야 하므로, 앱 밖(메모 앱)에서도 순서대로 읽히게 만든다.
 */
export function buildSetupClipboardText(
  plan: CollectSetupPlan,
  deviceName?: string,
): string {
  const lines: string[] = [];
  lines.push(
    `[카드 문자 자동 전달 설정${deviceName ? ` — ${deviceName}` : ""}]`,
  );
  lines.push(`앱: ${plan.appName}`);
  lines.push(plan.triggerSummary);
  lines.push(plan.actionSummary);
  lines.push("");
  lines.push(`요청 방식: ${plan.method}`);
  lines.push(`주소: ${plan.endpoint}`);
  lines.push("");
  lines.push("헤더");
  for (const header of plan.headers) {
    lines.push(`  ${header.label}: ${header.value}`);
  }
  lines.push("");
  lines.push(plan.bodyLabel);
  for (const line of plan.body.split("\n")) {
    lines.push(`  ${line}`);
  }
  const notes = [
    ...plan.headers.filter((h) => h.note).map((h) => `${h.label} — ${h.note}`),
    ...plan.bodyFields
      .filter((f) => f.note)
      .map((f) => `${f.label} — ${f.note}`),
    ...plan.cautions,
  ];
  if (notes.length > 0) {
    lines.push("");
    lines.push("메모");
    for (const note of notes) lines.push(`  · ${note}`);
  }
  return lines.join("\n");
}
