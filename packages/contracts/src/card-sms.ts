import { z } from 'zod';

/**
 * Card-SMS parsing lifecycle (PRD §31 Phase 3; mirrors DB `cardSmsParseStatus`).
 *
 * `quarantined`는 LLM(span 추출)이 만든 결과로, 사람이 확인하기 전에는 거래로
 * 승격되지 않는다(ADR-0023 §6). `pending_review`는 이름과 달리 승격을 막지 않는다.
 */
export const cardSmsParseStatusSchema = z.enum([
  'pending',
  'parsed',
  'parse_failed',
  'pending_review',
  'quarantined',
]);
export type CardSmsParseStatus = z.infer<typeof cardSmsParseStatusSchema>;

/** Card transaction kind resolved by the parser (mirrors DB `cardSmsTxnType`). */
export const cardSmsTransactionTypeSchema = z.enum([
  'approval',
  'cancellation',
  'declined',
  'unknown',
]);
export type CardSmsTransactionType = z.infer<typeof cardSmsTransactionTypeSchema>;

/** Ingest disposition — `queued` on first accept, `duplicate` on idempotent replay. */
const cardSmsProcessingStatusSchema = z.enum(['queued', 'duplicate']);

/**
 * 이 수집이 어느 멱등 키로 처리됐는지(P0-9). 정확도 순: `client` > `derived_received_at`
 * > `derived_window`.
 *
 * - `client` — 호출자가 `eventId`를 줬다. 재시도와 별개 결제를 호출자가 구분해 주므로
 *   서버가 추측하지 않는다. **자동화가 도달해야 할 상태.**
 * - `derived_received_at` — `eventId`는 없지만 수신 시각을 줬다. 시각 해상도만큼 정확하다.
 * - `derived_window` — 고유값이 하나도 없다. 서버가 수신 시각을 몇 분 단위 창으로 묶어
 *   추측한다. **같은 창 안의 별개 결제는 여전히 하나로 뭉친다** — 원문은 보관되지만
 *   지출에는 잡히지 않는다.
 *
 * 응답에 싣는 이유: 수집 마법사(로드맵 C-2)와 장치 진단 화면이 "지금 설정은 추측에
 * 의존하고 있다"를 사용자에게 보여줄 수 있어야 한다. 서버 로그만으로는 사용자가 알 길이 없다.
 */
export const cardSmsIdempotencySourceSchema = z.enum([
  'client',
  'derived_received_at',
  'derived_window',
]);
export type CardSmsIdempotencySource = z.infer<typeof cardSmsIdempotencySourceSchema>;

// --- Requests ---

/**
 * `POST /v1/mobile-events/card-sms` — submit a raw card SMS for parsing (PRD §10.3).
 * HMAC-guarded; the device principal supplies household/member scope.
 *
 * `receivedAt` is optional: automation tools that cannot easily format a UTC
 * ISO-8601 timestamp (e.g. Android MacroDroid, whose date variables are local
 * time) may omit it entirely — the server stamps `now()` on ingest. When
 * present it must be UTC (`Z` suffix). The parsed transaction time comes from
 * the SMS body (`MM/DD HH:mm`, no year) with the year resolved *relative to
 * receivedAt* — so a server-stamped `now()` is accurate for live forwarding,
 * but backfilling messages older than ~1 year without an explicit receivedAt
 * will resolve the wrong year. Supply receivedAt when replaying old archives.
 */
export const cardSmsIngestRequestSchema = z.object({
  /**
   * **멱등 키 — 문자 한 통당 하나의 고유값. 보내 주십시오(P0-9).**
   *
   * 이 값을 주면 서버는 "재시도"와 "우연히 같은 문자를 만든 별개 결제"를 확실히
   * 구분한다. 주지 않으면 서버가 추측해야 하고, 추측은 반드시 한쪽으로 틀린다 —
   * 지금 구현은 몇 분 창으로 묶는 쪽이라 **같은 창 안의 별개 결제가 지출에서
   * 누락된다**(원문은 보관되지만 거래로 승격되지 않는다).
   *
   * 그럼에도 선택값인 이유: 이미 배포된 MacroDroid·iOS 단축어 설정이 이 값을 보내지
   * 않는다. 필수로 바꾸면 **모든 기존 사용자의 수집이 그 자리에서 끊긴다** — 이
   * 서비스에서 카드 문자는 유일한 데이터 유입 경로이므로 그건 이 버그보다 나쁘다.
   * 응답의 `idempotencySource`가 어느 경로로 처리됐는지 알려주고, 서버는 그 비율을
   * 집계한다. 키 없는 수집이 충분히 사라지면 그때 필수화한다.
   *
   * 좋은 값: MacroDroid `{sms_message_id}`/`{triggertimestamp}` 조합, 단축어의
   * 수신 시각(초 단위) + 본문 해시 등. 같은 문자를 다시 보낼 때 **같은 값**이면 된다.
   */
  eventId: z.string().max(200).optional(),
  sender: z.string().min(1).max(100),
  content: z.string().min(1).max(4000),
  /**
   * 문자 수신 시각(UTC ISO-8601). `eventId`가 없을 때의 차선 — 초 단위 해상도면
   * 같은 분의 서로 다른 결제도 구분된다. 이것도 없으면 서버 창 추측으로 떨어진다.
   */
  receivedAt: z.string().datetime().optional(),
});
export type CardSmsIngestRequest = z.infer<typeof cardSmsIngestRequestSchema>;

// --- Responses ---

/**
 * Ingest acknowledgement. `accepted` is always `true`; `duplicate` distinguishes
 * a fresh enqueue (`processingStatus: 'queued'`) from an idempotent replay.
 *
 * `eventId`는 **이 문자가 속한 이벤트의 키**다. 중복으로 판정됐다면 새로 파생한 키가
 * 아니라 **흡수된 기존 이벤트의 키**가 온다 — 그래야 호출자가 그 키로 상태를 조회할 수
 * 있다(파생 키는 DB에 없다).
 */
export const cardSmsIngestResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string(),
  processingStatus: cardSmsProcessingStatusSchema,
  duplicate: z.boolean(),
  /** 이 수집이 어느 멱등 키 경로로 처리됐는지. `client`가 아니면 서버가 추측했다는 뜻. */
  idempotencySource: cardSmsIdempotencySourceSchema,
});
export type CardSmsIngestResponse = z.infer<typeof cardSmsIngestResponseSchema>;

/**
 * List projection for `GET /v1/card-sms-events`. Excludes the raw content —
 * that is only surfaced in the detail view. `amount` is in `currency`'s minor
 * units (KRW/JPY exponent 0, USD/EUR exponent 2); when `currency` is null treat
 * it as `KRW`. Clients format per `currency`.
 */
export const cardSmsEventSummarySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  sender: z.string(),
  receivedAt: z.string(),
  parseStatus: cardSmsParseStatusSchema,
  issuer: z.string().nullable(),
  transactionType: cardSmsTransactionTypeSchema.nullable(),
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
  merchantRaw: z.string().nullable(),
  occurredAt: z.string().nullable(),
  installmentMonths: z.number().int().nullable(),
  confidence: z.number().int().nullable(),
  parseError: z.string().nullable(),
  createdAt: z.string(),
});
export type CardSmsEventSummary = z.infer<typeof cardSmsEventSummarySchema>;

/**
 * Detail projection for `GET /v1/card-sms-events/:id` — summary plus the raw
 * content (parse-failure review) and the masked card number.
 */
export const cardSmsEventDetailSchema = cardSmsEventSummarySchema.extend({
  rawContent: z.string(),
  maskedCardNumber: z.string().nullable(),
});
export type CardSmsEventDetail = z.infer<typeof cardSmsEventDetailSchema>;

/**
 * `GET /v1/mobile-events/card-sms/:eventId/status` — lightweight status poll for
 * an ingested event (device-facing).
 */
export const mobileEventStatusResponseSchema = z.object({
  eventId: z.string(),
  parseStatus: cardSmsParseStatusSchema,
  processingStatus: z.string(),
});
export type MobileEventStatusResponse = z.infer<typeof mobileEventStatusResponseSchema>;

// --- Manual entry (in-app 문자 붙여넣기 / 직접 입력) --------------------------

/**
 * `POST /v1/card-sms/parse-preview` — 붙여넣은 문자를 **상태 없이** 파싱해 미리보기.
 * DB에 아무것도 쓰지 않는다(등록 전 사용자에게 인식 결과를 보여주기 위한 용도).
 */
export const manualParsePreviewRequestSchema = z.object({
  content: z.string().min(1).max(4000),
  sender: z.string().max(100).optional(),
});
export type ManualParsePreviewRequest = z.infer<typeof manualParsePreviewRequestSchema>;

/** 파서 결과 투영. `parseable`=거래 승격 가능(금액+통화+식별된 유형) 여부. */
export const manualParsePreviewResponseSchema = z.object({
  issuer: z.string().nullable(),
  transactionType: cardSmsTransactionTypeSchema,
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
  merchantRaw: z.string().nullable(),
  occurredAt: z.string().nullable(),
  installmentMonths: z.number().int().nullable(),
  maskedCardNumber: z.string().nullable(),
  confidence: z.number().int(),
  warnings: z.array(z.string()),
  parseable: z.boolean(),
});
export type ManualParsePreviewResponse = z.infer<typeof manualParsePreviewResponseSchema>;

/**
 * `POST /v1/card-sms/manual-text` — 붙여넣은 문자를 일반 수집 파이프라인(가구별 합성
 * "수동" device 경유)으로 태운다. 워커가 파싱·승격하므로 자동 유입과 동작이 동일하다
 * (카드연결/카테고리/중복판정/예산/알림). 응답의 `cardSmsEventId`로 상태를 폴링한다.
 */
export const manualTextEntryRequestSchema = z.object({
  householdId: z.string().uuid(),
  content: z.string().min(1).max(4000),
  sender: z.string().max(100).optional(),
  receivedAt: z.string().datetime().optional(),
});
export type ManualTextEntryRequest = z.infer<typeof manualTextEntryRequestSchema>;

export const manualTextEntryResponseSchema = z.object({
  /** 멱등 키(sha256 파생). */
  eventId: z.string(),
  /** card_sms_events.id (UUID) — GET /v1/card-sms-events/:id 폴링 대상. */
  cardSmsEventId: z.string(),
  duplicate: z.boolean(),
});
export type ManualTextEntryResponse = z.infer<typeof manualTextEntryResponseSchema>;

/**
 * `POST /v1/card-sms/manual-fields` — 파싱 없이 사용자가 입력한 필드로 거래를 직접
 * 등록한다. 사용자가 카드·카테고리를 명시하므로 자동 해석 없이 그대로 저장한다.
 * v1은 승인(approval)만 지원한다. 응답은 생성된 거래(TransactionSummary).
 */
export const manualFieldsEntryRequestSchema = z.object({
  householdId: z.string().uuid(),
  /** 통화의 minor units 정수(KRW는 원 그대로). */
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(3).default('KRW'),
  merchantRaw: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  transactionType: z.literal('approval').default('approval'),
  issuer: z.string().max(50).optional(),
  installmentMonths: z.number().int().positive().max(60).optional(),
  cardId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
});
export type ManualFieldsEntryRequest = z.infer<typeof manualFieldsEntryRequestSchema>;

/**
 * 격리된(quarantined) 또는 파싱 실패한 카드 문자를 사람이 확인·교정해 확정하는 요청
 * (ADR-0023 S3).
 *
 * 확정된 값은 곧 학습 라벨이 된다 — `feedback_events(source:'human_confirmed')`로
 * 기록되고, 템플릿 지문과 함께 저장되어 이후 같은 레이아웃의 추출 레시피가 된다.
 */
export const cardSmsReviewRequestSchema = z.object({
  /** 승인/취소/거절. `declined`는 거래를 만들지 않는다(실제 체결이 아님). */
  transactionType: z.enum(['approval', 'cancellation', 'declined']),
  /** 통화의 minor units 정수(KRW는 원 그대로). declined면 생략 가능. */
  amount: z.number().int().nonnegative().optional(),
  currency: z.string().min(3).max(3).default('KRW'),
  merchantRaw: z.string().min(1).max(200).optional(),
  occurredAt: z.string().datetime().optional(),
  issuer: z.string().max(50).optional(),
  installmentMonths: z.number().int().positive().max(60).optional(),
  cardId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
});
export type CardSmsReviewRequest = z.infer<typeof cardSmsReviewRequestSchema>;

/** 검토 확정 결과. `transaction`은 declined일 때 null이다. */
export const cardSmsReviewResponseSchema = z.object({
  cardSmsEventId: z.string().uuid(),
  parseStatus: cardSmsParseStatusSchema,
  /** 승격된 거래(있을 때). declined는 거래를 만들지 않으므로 null. */
  transactionId: z.string().uuid().nullable(),
});
export type CardSmsReviewResponse = z.infer<typeof cardSmsReviewResponseSchema>;

/* -------------------------------------------------------------------------- */
/* 결제 실패(declined) 추적                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 승인거절 사유. **사유마다 사용자 조치가 다르다** — `lost_or_stolen`은 정기결제 수단
 * 갱신, `insufficient_balance`는 입금, `limit_exceeded`는 한도 조정/카드 변경.
 * `unknown`은 사유 문구를 못 알아본 경우로, 거절 사실 자체는 확실하다.
 */
export const cardSmsDeclineReasonSchema = z.enum([
  'lost_or_stolen',
  'limit_exceeded',
  'insufficient_balance',
  'expired_card',
  'suspended',
  'invalid_credential',
  'unknown',
]);
export type CardSmsDeclineReason = z.infer<typeof cardSmsDeclineReasonSchema>;

/**
 * 실패한 결제 한 묶음 — 같은 `(가맹점, 금액)`의 반복 시도를 하나로 모은다.
 *
 * 왜 묶는가: 카드사는 정기결제 실패를 **매일 재시도**한다(실측: OO피트니스 99,000원이
 * 7일 연속 15:00에 거절). 시도를 낱개로 보여주면 같은 사건이 7줄이 되어 무엇이 문제인지
 * 묻히고, 다른 실패가 스크롤 아래로 밀린다.
 */
export const cardSmsDeclineGroupSchema = z.object({
  /** 정규화·별칭 해석된 가맹점 이름. 원문이 없으면 null. */
  merchant: z.string().nullable(),
  amount: z.number().int().nullable(),
  currency: z.string(),
  reason: cardSmsDeclineReasonSchema.nullable(),
  issuer: z.string().nullable(),
  maskedCardNumber: z.string().nullable(),
  /** 이 묶음의 거절 시도 횟수. */
  attempts: z.number().int(),
  firstAttemptAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  /**
   * 마지막 거절 **이후** 같은 가맹점에서 승인된 시각. 있으면 스스로 해결된 것이고
   * (실측: STEAMGAMES 10,038원 거절 → 9,900원 승인), null이면 아직 미해결이다
   * (실측: OO피트니스 — 7번 거절 후 승인 0건).
   */
  resolvedAt: z.string().nullable(),
  /**
   * 사용자가 "확인했다"고 표시한 시각. `resolvedAt`(자동 판정)과 **직교**한다.
   *
   * 왜 필요한가: `resolvedAt`은 후속 승인으로만 채워지므로, 정기결제를 아예 해지한
   * 경우처럼 승인이 영구히 오지 않는 실패는 영원히 미해결로 남아 홈 배너가 사라지지
   * 않는다(실측: 버핏서울 106,000원 — 7일 연속 거절 후 승인 0건, 배너 18일째 유지).
   *
   * 이 값이 있어도 **그 시각 이후 새 거절이 오면 서버가 null로 되돌린다** — 영구
   * 무시가 아니라 "지금까지의 시도는 확인했다"는 뜻이다.
   */
  dismissedAt: z.string().nullable(),
});
export type CardSmsDeclineGroup = z.infer<typeof cardSmsDeclineGroupSchema>;

/** `GET /v1/card-sms-events/declines` — 미해결 먼저, 시도 많은 순. */
export const cardSmsDeclineListResponseSchema = z.object({
  items: z.array(cardSmsDeclineGroupSchema),
  /**
   * 조치가 필요한 묶음 수 — 홈 배너 노출 판단에 쓴다.
   * 자동 해결(`resolvedAt`)과 사용자 확인(`dismissedAt`) **둘 다** 제외한 수다.
   */
  unresolvedCount: z.number().int(),
});
export type CardSmsDeclineListResponse = z.infer<
  typeof cardSmsDeclineListResponseSchema
>;

/**
 * `POST /v1/card-sms-events/declines/dismiss` · `/undismiss` — 묶음 확인 표시 토글.
 *
 * 묶음을 id가 아니라 `(merchant, amount)`로 지목하는 이유: 묶음은 조회 시점에
 * 계산되는 집계이지 저장된 행이 아니다. 둘 다 nullable인 것은 가맹점·금액을 파싱하지
 * 못한 거절도 닫을 수 있어야 하기 때문이다.
 */
export const cardSmsDeclineDismissRequestSchema = z.object({
  householdId: z.string().uuid(),
  merchant: z.string().min(1).max(200).nullable(),
  amount: z.number().int().nullable(),
});
export type CardSmsDeclineDismissRequest = z.infer<
  typeof cardSmsDeclineDismissRequestSchema
>;

/** dismiss/undismiss 응답 — 토글 후의 상태(멱등). */
export const cardSmsDeclineDismissResponseSchema = z.object({
  merchant: z.string().nullable(),
  amount: z.number().int().nullable(),
  dismissedAt: z.string().nullable(),
});
export type CardSmsDeclineDismissResponse = z.infer<
  typeof cardSmsDeclineDismissResponseSchema
>;
