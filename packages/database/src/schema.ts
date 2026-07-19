/**
 * Drizzle 스키마 (Phase 1 Build Spec §2 — 인증과 가족).
 *
 * 규약:
 * - PK는 `uuid('id').primaryKey().defaultRandom()` (PG17 내장 gen_random_uuid()).
 * - 모든 timestamp는 `timestamp({ withTimezone: true })` (timestamptz).
 * - 공통 컬럼: createdAt/updatedAt default now, 필요 시 deletedAt(soft delete).
 * - JS 필드는 camelCase, DB 컬럼은 snake_case로 매핑한다(추론 타입은 camelCase 유지).
 * - pgvector 확장은 infrastructure/postgres/init/01-extensions.sql 이 생성하므로
 *   여기서 다루지 않는다.
 * - 금액 컬럼은 KRW 정수 원칙(Phase 1 테이블에는 금액 컬럼 없음).
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* pgEnum                                                                     */
/* -------------------------------------------------------------------------- */

/** 가족 그룹 내 역할. */
export const householdRole = pgEnum('household_role', [
  'owner',
  'admin',
  'member',
  'viewer',
]);

/** 구성원 상태(soft-remove). */
export const memberStatus = pgEnum('member_status', ['active', 'removed']);

/** 초대 상태. */
export const invitationStatus = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
]);

/** 푸시 구독 플랫폼(FCM 토큰 발급처). */
export const pushPlatform = pgEnum('push_platform', ['android', 'ios', 'web']);

/* -------------------------------------------------------------------------- */
/* users                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 사용자 계정. `email`은 소문자 정규화하여 저장한다(호출부 책임).
 * `passwordHash`는 argon2id 해시 — 값 자체를 로그에 남기지 않는다.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [unique('users_email_unique').on(table.email)],
);

/* -------------------------------------------------------------------------- */
/* userSessions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Refresh 토큰 세션. 토큰은 불투명 랜덤이며 DB에는 sha256 해시만 저장한다.
 * 회전 시 기존 세션을 revoke(`revokedAt` 설정)한다.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('user_sessions_refresh_token_hash_unique').on(
      table.refreshTokenHash,
    ),
    index('user_sessions_user_id_idx').on(table.userId),
  ],
);

/* -------------------------------------------------------------------------- */
/* households                                                                 */
/* -------------------------------------------------------------------------- */

/** 가족 그룹. `createdBy`는 생성자(초기 owner). */
export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/* -------------------------------------------------------------------------- */
/* householdMembers                                                           */
/* -------------------------------------------------------------------------- */

/** 가족 구성원 멤버십. (householdId, userId)는 유일하다. */
export const householdMembers = pgTable(
  'household_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: householdRole('role').notNull(),
    status: memberStatus('status').notNull().default('active'),
    // 구성원 강조색 팔레트 키(contracts memberColorSchema). null = 자동(해시) 색.
    color: text('color'),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('household_members_household_user_unique').on(
      table.householdId,
      table.userId,
    ),
    index('household_members_household_id_idx').on(table.householdId),
    index('household_members_user_id_idx').on(table.userId),
  ],
);

/* -------------------------------------------------------------------------- */
/* householdInvitations                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 가족 초대. raw 토큰은 발급 시 1회만 응답하고 DB에는 sha256 해시만 저장한다.
 * `tokenHash`는 유일하며, 값 자체를 로그에 남기지 않는다.
 */
export const householdInvitations = pgTable(
  'household_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    email: text('email'),
    role: householdRole('role').notNull().default('member'),
    tokenHash: text('token_hash').notNull(),
    status: invitationStatus('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('household_invitations_token_hash_unique').on(table.tokenHash),
    index('household_invitations_household_id_idx').on(table.householdId),
  ],
);

/* -------------------------------------------------------------------------- */
/* householdConsents                                                          */
/* -------------------------------------------------------------------------- */

/** 가족 합류 동의 기록 (PRD §7.3). consentType 예: 'household_join'. */
export const householdConsents = pgTable('household_consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  consentType: text('consent_type').notNull(),
  consentVersion: text('consent_version').notNull().default('v1'),
  consentedAt: timestamp('consented_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/* -------------------------------------------------------------------------- */
/* pushSubscriptions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 푸시 알림 구독(FCM 토큰). 수신자는 "로그인한 각 기기의 사용자"이므로
 * registered_devices(=SMS 수집기 크리덴셜)와 별개 테이블이다. householdId를
 * 저장하지 않는 이유: 발송 시점에 household_members로 해석하면 가구 이동/멤버십
 * 변경에 자동 추종한다. `token`은 유일하며 재등록 시 userId를 교체(기기 양도).
 * `revokedAt`은 로그아웃/영구 실패(UNREGISTERED) 시 설정한다.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    platform: pushPlatform('platform').notNull(),
    token: text('token').notNull(),
    // 실패 누적(연속 5xx 등) — 관측/정리에 쓰고, 영구 실패는 revokedAt로 마감.
    failCount: integer('fail_count').notNull().default(0),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('push_subscriptions_token_unique').on(table.token),
    index('push_subscriptions_user_id_idx').on(table.userId),
  ],
);

/* -------------------------------------------------------------------------- */
/* notificationPreferences                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 사용자별 알림 선호(피로도 제어). 행이 없으면 기본값(전부 켬)으로 간주한다.
 * `minAmount`(KRW 정수) 미만은 무음, 무음 시간대(분 단위, 자정 넘김 허용)는
 * 발송을 건너뛴다. `notifyOwnCollected`는 자기 기기에서 수집한 문자로 만들어진
 * 거래도 알림 받을지 여부.
 */
export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  pushEnabled: boolean('push_enabled').notNull().default(true),
  minAmount: integer('min_amount'),
  quietStartMinute: integer('quiet_start_minute'),
  quietEndMinute: integer('quiet_end_minute'),
  notifyOwnCollected: boolean('notify_own_collected').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/* -------------------------------------------------------------------------- */
/* 추론 타입 (select / insert)                                                */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

export type NotificationPreference =
  typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference =
  typeof notificationPreferences.$inferInsert;

export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;

export type Household = typeof households.$inferSelect;
export type NewHousehold = typeof households.$inferInsert;

export type HouseholdMember = typeof householdMembers.$inferSelect;
export type NewHouseholdMember = typeof householdMembers.$inferInsert;

export type HouseholdInvitation = typeof householdInvitations.$inferSelect;
export type NewHouseholdInvitation = typeof householdInvitations.$inferInsert;

export type HouseholdConsent = typeof householdConsents.$inferSelect;
export type NewHouseholdConsent = typeof householdConsents.$inferInsert;

/* ========================================================================== */
/* Phase 2 — 스마트폰 장치 & HMAC 인증 (Phase 2 Build Spec §2)                 */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* pgEnum (device)                                                            */
/* -------------------------------------------------------------------------- */

/** 장치 플랫폼. */
export const devicePlatform = pgEnum('device_platform', [
  'ios',
  'android',
  'other',
]);

/** 등록 장치 상태(폐기 시 revoked). */
export const deviceStatus = pgEnum('device_status', ['active', 'revoked']);

/** 장치 Secret(자격증명) 상태(회전/폐기 시 revoked). */
export const deviceCredentialStatus = pgEnum('device_credential_status', [
  'active',
  'revoked',
]);

/* -------------------------------------------------------------------------- */
/* registeredDevices                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 등록된 스마트폰 장치. 장치는 `householdId`+`memberId`가 소유하며,
 * `createdBy`는 등록을 수행한 사용자다. 폐기 시 status='revoked' + revokedAt.
 *
 * `collectTokenHash`는 단축어(iOS)/MacroDroid(Android) 등 저마찰 자동화 도구용
 * 수집 토큰(Bearer)의 sha256(hex)다. 원문 토큰은 저장하지 않고(등록/회전 시 raw를
 * 1회만 응답) 해시만 보관하며, 값 자체를 로그에 남기지 않는다. 토큰 미발급 장치는
 * null이므로 UNIQUE는 다수 null을 허용한다.
 */
export const registeredDevices = pgTable(
  'registered_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => householdMembers.id),
    name: text('name').notNull(),
    platform: devicePlatform('platform').notNull(),
    status: deviceStatus('status').notNull().default('active'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    collectTokenHash: text('collect_token_hash'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('registered_devices_collect_token_hash_unique').on(
      table.collectTokenHash,
    ),
    index('registered_devices_household_id_idx').on(table.householdId),
    index('registered_devices_member_id_idx').on(table.memberId),
  ],
);

/* -------------------------------------------------------------------------- */
/* deviceCredentials                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 장치별 HMAC Secret. 원문은 저장하지 않고 AES-256-GCM 암호문
 * (`{ciphertext, iv, authTag}` base64)만 보관한다. 한 장치당 active 자격은
 * 1개(앱 로직으로 강제: 회전 시 기존 active→revoked). 값 자체를 로그에 남기지 않는다.
 */
export const deviceCredentials = pgTable(
  'device_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => registeredDevices.id),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretIv: text('secret_iv').notNull(),
    secretAuthTag: text('secret_auth_tag').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    status: deviceCredentialStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('device_credentials_device_id_idx').on(table.deviceId)],
);

/* -------------------------------------------------------------------------- */
/* deviceNonces                                                               */
/* -------------------------------------------------------------------------- */

/**
 * HMAC 요청 replay 방지용 nonce 기록. (deviceId, nonce)는 유일하며,
 * 재사용 시 insert 충돌(23505)로 replay를 차단한다. `expiresAt` 인덱스는
 * 만료 정리용이다.
 */
export const deviceNonces = pgTable(
  'device_nonces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => registeredDevices.id),
    nonce: text('nonce').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('device_nonces_device_id_nonce_unique').on(
      table.deviceId,
      table.nonce,
    ),
    index('device_nonces_expires_at_idx').on(table.expiresAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (device)                                                         */
/* -------------------------------------------------------------------------- */

export type RegisteredDevice = typeof registeredDevices.$inferSelect;
export type NewRegisteredDevice = typeof registeredDevices.$inferInsert;

export type DeviceCredential = typeof deviceCredentials.$inferSelect;
export type NewDeviceCredential = typeof deviceCredentials.$inferInsert;

export type DeviceNonce = typeof deviceNonces.$inferSelect;
export type NewDeviceNonce = typeof deviceNonces.$inferInsert;

/* ========================================================================== */
/* Phase 3 — 카드 문자 수집 & 파싱 (Phase 3 Build Spec §2)                      */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* pgEnum (card sms)                                                          */
/* -------------------------------------------------------------------------- */

/** 범용 원문 Source Item 종류(Phase 3는 card_sms만 사용, 향후 확장). */
export const sourceKind = pgEnum('source_kind', [
  'card_sms',
  'slack',
  'manual',
]);

/** 카드 문자 파싱 상태(pending→parsed/parse_failed/pending_review). */
export const cardSmsParseStatus = pgEnum('card_sms_parse_status', [
  'pending',
  'parsed',
  'parse_failed',
  'pending_review',
]);

/** 카드 거래 종류(승인/취소/미상). */
export const cardSmsTxnType = pgEnum('card_sms_txn_type', [
  'approval',
  'cancellation',
  'unknown',
]);

/* -------------------------------------------------------------------------- */
/* sourceItems                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 범용 원문 레코드(PRD §11 "원문 우선"). 실제 원문 텍스트는 MinIO에 저장하고
 * 여기에는 `objectKey` + `contentHash`(sha256 hex) + 메타만 보관한다.
 * 원문 전체·PII는 로그에 남기지 않는다.
 */
export const sourceItems = pgTable(
  'source_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 소유 스코프는 소스 종류별로 다르다: card_sms→householdId(가족), slack→workspaceId
    // (개인/회사 workspace, PRD §3.6). 둘 다 nullable, 종류별로 하나만 채운다.
    householdId: uuid('household_id').references(() => households.id),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    kind: sourceKind('kind').notNull(),
    objectKey: text('object_key').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    /** 온라인 projection이 가리키는 최신 immutable source revision. */
    currentRevisionId: uuid('current_revision_id').references(
      (): AnyPgColumn => sourceRevisions.id,
    ),
    deviceId: uuid('device_id').references(() => registeredDevices.id),
    memberId: uuid('member_id').references(() => householdMembers.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** 삭제 요청이 접수된 시각. current revision은 tombstone을 가리킨다. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('source_items_household_id_idx').on(table.householdId),
    index('source_items_workspace_id_idx').on(table.workspaceId),
    index('source_items_content_hash_idx').on(table.contentHash),
  ],
);

/* -------------------------------------------------------------------------- */
/* cardSmsEvents                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 카드 문자 이벤트(수집 + 비동기 파싱 결과). 멱등성은 UNIQUE(device_id, event_id)로
 * 강제한다(동일 장치의 동일 eventId 재전송 차단). `rawContent`는 워커가 매번 MinIO를
 * fetch하지 않도록 두는 편의 사본이다. `amount`는 KRW 정수(원), `confidence`는
 * 0~100 정수(부동소수 회피), `occurredAt`은 Asia/Seoul 기준으로 파서가 계산한다.
 * 파싱 결과는 Phase 4에서 `card_transactions`로 승격된다.
 */
export const cardSmsEvents = pgTable(
  'card_sms_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => householdMembers.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => registeredDevices.id),
    sourceItemId: uuid('source_item_id')
      .notNull()
      .references(() => sourceItems.id),
    eventId: text('event_id').notNull(),
    sender: text('sender').notNull(),
    rawContent: text('raw_content').notNull(),
    contentHash: text('content_hash').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    parseStatus: cardSmsParseStatus('parse_status')
      .notNull()
      .default('pending'),
    parseError: text('parse_error'),
    // 파싱 결과(구조화, Phase 4에서 card_transactions로 승격).
    issuer: text('issuer'),
    transactionType: cardSmsTxnType('transaction_type'),
    amount: integer('amount'),
    currency: text('currency').default('KRW'),
    merchantRaw: text('merchant_raw'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    maskedCardNumber: text('masked_card_number'),
    installmentMonths: integer('installment_months'),
    confidence: integer('confidence'),
    parsedAt: timestamp('parsed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('card_sms_events_device_id_event_id_unique').on(
      table.deviceId,
      table.eventId,
    ),
    index('card_sms_events_household_id_idx').on(table.householdId),
    index('card_sms_events_parse_status_idx').on(table.parseStatus),
    index('card_sms_events_household_id_parse_status_idx').on(
      table.householdId,
      table.parseStatus,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (card sms)                                                       */
/* -------------------------------------------------------------------------- */

export type SourceItem = typeof sourceItems.$inferSelect;
export type NewSourceItem = typeof sourceItems.$inferInsert;

export type CardSmsEvent = typeof cardSmsEvents.$inferSelect;
export type NewCardSmsEvent = typeof cardSmsEvents.$inferInsert;

/* ========================================================================== */
/* Phase 4 — 거래 관리 (Phase 4 Build Spec §2)                                 */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* pgEnum (cards & transactions)                                              */
/* -------------------------------------------------------------------------- */

/**
 * 거래/카드 공개 범위(PRD §8, §26). 'private'=본인만, 'household'=가족 공유,
 * 'summary_only'=통계엔 포함하되 목록에서 가맹점은 타인에게 마스킹.
 */
export const cardVisibility = pgEnum('card_visibility', [
  'private',
  'household',
  'summary_only',
]);

/** 카드 상태(비활성 시 inactive). */
export const cardStatus = pgEnum('card_status', ['active', 'inactive']);

/** 거래 종류(승인/취소). */
export const txnType = pgEnum('txn_type', ['approval', 'cancellation']);

/**
 * 거래 상태. 취소 반영/검토 상태를 포함한다.
 * - approved: 정상 승인
 * - partially_cancelled: 부분 취소(netAmount = amount - cancelledAmount)
 * - cancelled: 전체 취소(netAmount = 0)
 * - pending_review: 검토 필요(취소 연결 애매 등)
 * - duplicate_suspected: 2차 유사중복 의심
 */
export const txnStatus = pgEnum('txn_status', [
  'approved',
  'partially_cancelled',
  'cancelled',
  'pending_review',
  'duplicate_suspected',
]);

/** 가맹점 규칙의 생성 근거. AI prediction은 사람 확정 라벨과 분리한다. */
export const merchantRuleSource = pgEnum('merchant_rule_source', [
  'human_confirmed',
  'model_prediction',
  'system_rule',
]);

/* -------------------------------------------------------------------------- */
/* paymentCards                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 결제 카드. `householdId`+`ownerMemberId`가 소유하며, `createdBy`는 등록을
 * 수행한 사용자다. `maskedNumber`는 카드번호 뒤 4자리만 저장(전체 PAN 저장 금지)하며
 * 승격 시 파서 `maskedCardNumber` 뒤 4자리와 매칭해 거래를 자동 연결한다.
 * 거래는 이 카드의 `visibility`를 상속한다(카드 없으면 'household').
 */
export const paymentCards = pgTable(
  'payment_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    ownerMemberId: uuid('owner_member_id')
      .notNull()
      .references(() => householdMembers.id),
    issuer: text('issuer').notNull(),
    alias: text('alias').notNull(),
    maskedNumber: text('masked_number'),
    cardFingerprint: text('card_fingerprint'),
    visibility: cardVisibility('visibility').notNull().default('household'),
    status: cardStatus('status').notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('payment_cards_household_id_idx').on(table.householdId),
    index('payment_cards_household_id_masked_number_idx').on(
      table.householdId,
      table.maskedNumber,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* expenseCategories                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 지출 카테고리. `householdId`가 null이면 시스템 기본 카테고리(모든 가족 공용),
 * 값이 있으면 해당 household 커스텀 카테고리(Phase 4는 시스템 기본만 사용).
 * 시스템 카테고리 `slug`는 partial unique index로, household 커스텀은
 * (householdId, slug)로 유일성을 강제한다.
 */
export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id').references(() => households.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('expense_categories_system_slug_unique')
      .on(table.slug)
      .where(sql`${table.householdId} is null`),
    unique('expense_categories_household_id_slug_unique').on(
      table.householdId,
      table.slug,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* merchantCategoryRules                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 가맹점→카테고리 사용자 규칙(PRD §15 1~2순위). 사용자가 거래 카테고리를 바꾸면
 * (householdId, merchantPattern) → categoryId로 upsert하며, 이후 승격/재분류에
 * 정확 매칭으로 반영된다(과거 거래 소급 안 함). `merchantPattern`은 정규화 가맹점명.
 * `source`로 사람 확정/모델 제안/규칙 생성을 구분하며, 모델 제안은 trace를
 * `predictionTraceId`로 연결한다. AI 제안은 사용자 확정 전 학습 gold가 아니다.
 */
export const merchantCategoryRules = pgTable(
  'merchant_category_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    merchantPattern: text('merchant_pattern').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id),
    priority: integer('priority').notNull().default(100),
    source: merchantRuleSource('source').notNull().default('human_confirmed'),
    predictionTraceId: uuid('prediction_trace_id').references(
      (): AnyPgColumn => aiInvocations.id,
    ),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('merchant_category_rules_household_id_merchant_pattern_unique').on(
      table.householdId,
      table.merchantPattern,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* cardTransactions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 카드 거래(파싱 이벤트에서 승격). 금액은 모두 KRW 정수(원)다.
 *
 * netAmount 규약(PRD §31 / 스펙 §1.2):
 * - `approval` 거래: netAmount = amount - cancelledAmount. 통계는 승인 거래의
 *   netAmount 합으로 계산한다.
 * - `cancellation` 거래: 이력/감사용 레코드로 netAmount = 0(이중계상 방지),
 *   `parentTransactionId`로 대응 승인 거래에 연결한다.
 *
 * 승격 멱등성은 `sourceEventId` UNIQUE로 강제한다(재승격 시 onConflictDoNothing).
 * `parentTransactionId`는 같은 테이블을 가리키는 self-FK다.
 */
export const cardTransactions = pgTable(
  'card_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => householdMembers.id),
    cardId: uuid('card_id').references(() => paymentCards.id),
    sourceEventId: uuid('source_event_id')
      .notNull()
      .references(() => cardSmsEvents.id),
    transactionType: txnType('transaction_type').notNull(),
    status: txnStatus('status').notNull(),
    amount: integer('amount').notNull(),
    cancelledAmount: integer('cancelled_amount').notNull().default(0),
    netAmount: integer('net_amount').notNull(),
    currency: text('currency').notNull().default('KRW'),
    merchantRaw: text('merchant_raw'),
    merchantNormalized: text('merchant_normalized'),
    categoryId: uuid('category_id').references(() => expenseCategories.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    authorizationCode: text('authorization_code'),
    installmentMonths: integer('installment_months'),
    parentTransactionId: uuid('parent_transaction_id').references(
      (): AnyPgColumn => cardTransactions.id,
    ),
    visibility: cardVisibility('visibility').notNull().default('household'),
    memo: text('memo'),
    // 합계/예산에서 제외된 시각(사용자가 '중복이라 제외' 확정). null이면 집계 포함.
    // status와 직교하는 플래그: 거래 종류는 그대로 두고 "카운트 여부"만 토글한다.
    excludedAt: timestamp('excluded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('card_transactions_source_event_id_unique').on(table.sourceEventId),
    index('card_transactions_household_id_idx').on(table.householdId),
    index('card_transactions_household_id_member_id_idx').on(
      table.householdId,
      table.memberId,
    ),
    index('card_transactions_card_id_idx').on(table.cardId),
    index('card_transactions_household_id_transaction_type_idx').on(
      table.householdId,
      table.transactionType,
    ),
    index('card_transactions_parent_transaction_id_idx').on(
      table.parentTransactionId,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (cards & transactions)                                           */
/* -------------------------------------------------------------------------- */

export type PaymentCard = typeof paymentCards.$inferSelect;
export type NewPaymentCard = typeof paymentCards.$inferInsert;

export type ExpenseCategory = typeof expenseCategories.$inferSelect;
export type NewExpenseCategory = typeof expenseCategories.$inferInsert;

export type MerchantCategoryRule = typeof merchantCategoryRules.$inferSelect;
export type NewMerchantCategoryRule = typeof merchantCategoryRules.$inferInsert;

export type CardTransaction = typeof cardTransactions.$inferSelect;
export type NewCardTransaction = typeof cardTransactions.$inferInsert;

/* ========================================================================== */
/* Phase 5 — 예산 (Phase 5 Build Spec §2)                                      */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* pgEnum (budget)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 예산 스코프 종류(PRD §7.2 / 스펙 §1.4). scopeRefId 대상:
 * - household: 가족 전체(scopeRefId=null)
 * - member: 특정 구성원(scopeRefId=householdMembers.id)
 * - category: 특정 카테고리(scopeRefId=expenseCategories.id)
 * - card: 특정 카드(scopeRefId=paymentCards.id)
 */
export const budgetScopeType = pgEnum('budget_scope_type', [
  'household',
  'member',
  'category',
  'card',
]);

/** 예산 주기(MVP는 월 예산만). */
export const budgetPeriod = pgEnum('budget_period', ['monthly']);

/* -------------------------------------------------------------------------- */
/* budgets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 가족 예산. `amount`는 KRW 정수(원)인 월 예산이며, 사용률은 스코프별 현재월
 * 순지출(`sum(netAmount) WHERE transactionType='approval'`, 공개범위 반영) /
 * `amount`로 계산한다(스펙 §1.4). `scopeRefId`는 scopeType이 household면 null,
 * 그 외에는 member/category/card의 id다. `createdBy`는 예산을 생성한 사용자다.
 * (householdId, scopeType, scopeRefId)는 유일하다(중복 예산 방지).
 */
export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    name: text('name'),
    scopeType: budgetScopeType('scope_type').notNull(),
    scopeRefId: uuid('scope_ref_id'),
    amount: integer('amount').notNull(),
    period: budgetPeriod('period').notNull().default('monthly'),
    currency: text('currency').notNull().default('KRW'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('budgets_household_scope_type_scope_ref_id_unique').on(
      table.householdId,
      table.scopeType,
      table.scopeRefId,
    ),
    index('budgets_household_id_idx').on(table.householdId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (budget)                                                         */
/* -------------------------------------------------------------------------- */

export type Budget = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;

/* ========================================================================== */
/* Phase 6 — Slack Import (Phase 6 Build Spec §2)                              */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* pgEnum (workspace)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 개인 데이터 컨테이너 종류(PRD §3.6/§26). 'personal'=개인, 'company'=회사.
 * Slack Import은 기본 'company'로 생성한다.
 */
export const workspaceKindEnum = pgEnum('workspace_kind', [
  'personal',
  'company',
]);

/* -------------------------------------------------------------------------- */
/* workspaces                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 개인 데이터 컨테이너(PRD §3.6/§26). `ownerUserId`가 소유하며, Slack 등
 * 개인화 데이터는 이 workspace를 통해 **소유자 본인만** 접근한다(가족 구성원도
 * 접근 불가). 향후 Phase 8 `personal_events`가 `workspaceId`로 연결된다.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    kind: workspaceKindEnum('kind').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('workspaces_owner_user_id_idx').on(table.ownerUserId)],
);

/* -------------------------------------------------------------------------- */
/* slackWorkspaces                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Slack 워크스페이스(Export 대상). 소유 `workspaces` 1개당 1건(UNIQUE).
 * `mySlackUserId`는 "내 메시지" 필터용 Slack user id 문자열이며,
 * `lastImportedAt`은 마지막 Import 완료 시각이다.
 */
export const slackWorkspaces = pgTable(
  'slack_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    slackTeamId: text('slack_team_id'),
    name: text('name').notNull(),
    mySlackUserId: text('my_slack_user_id'),
    lastImportedAt: timestamp('last_imported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('slack_workspaces_workspace_id_unique').on(table.workspaceId),
  ],
);

/* -------------------------------------------------------------------------- */
/* slackChannels                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Slack 채널 정규화. `slackChannelId`는 Slack 채널 id 문자열(예: 'C1').
 * (slackWorkspaceId, slackChannelId)는 유일하며, 재import 시 이름을 갱신한다
 * (onConflictDoUpdate).
 */
export const slackChannels = pgTable(
  'slack_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slackWorkspaceId: uuid('slack_workspace_id')
      .notNull()
      .references(() => slackWorkspaces.id),
    slackChannelId: text('slack_channel_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('slack_channels_slack_workspace_id_slack_channel_id_unique').on(
      table.slackWorkspaceId,
      table.slackChannelId,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* slackUsers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Slack 사용자 정규화. `slackUserId`는 Slack user id 문자열(예: 'U1').
 * (slackWorkspaceId, slackUserId)는 유일하며, 재import 시 이름을 갱신한다
 * (onConflictDoUpdate).
 */
export const slackUsers = pgTable(
  'slack_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slackWorkspaceId: uuid('slack_workspace_id')
      .notNull()
      .references(() => slackWorkspaces.id),
    slackUserId: text('slack_user_id').notNull(),
    name: text('name').notNull(),
    realName: text('real_name'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('slack_users_slack_workspace_id_slack_user_id_unique').on(
      table.slackWorkspaceId,
      table.slackUserId,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* slackMessages                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Slack 메시지. `slackChannelId`는 `slack_channels.id`(내부 uuid)를 가리키는 FK,
 * `slackUserId`는 정규화 전 Slack user id 문자열(정규화는 slack_users)이다.
 * `ts`/`threadTs`/`editedTs`는 Slack "epoch.micro" 문자열, `occurredAt`은 ts를
 * Date로 변환한 값(Asia/Seoul 기준 timestamptz)이다. UNIQUE(slackChannelId, ts)가
 * import identity를 강제하고 Worker는 merge/snapshot change-set을 적용한다. 한 번 삭제된
 * tombstone은 재수집으로 복구하지 않는다. 사용자 편집·삭제는 current projection을
 * 갱신하고 immutable `data_events` revision으로 기록한다.
 * `text` GIN(gin_trgm_ops) 인덱스는 키워드 검색(ILIKE)용이며, 원문·PII는
 * 로그에 남기지 않는다.
 */
export const slackMessages = pgTable(
  'slack_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slackWorkspaceId: uuid('slack_workspace_id')
      .notNull()
      .references(() => slackWorkspaces.id),
    slackChannelId: uuid('slack_channel_id')
      .notNull()
      .references(() => slackChannels.id),
    slackUserId: text('slack_user_id'),
    ts: text('ts').notNull(),
    threadTs: text('thread_ts'),
    text: text('text').notNull(),
    editedTs: text('edited_ts'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('slack_messages_slack_channel_id_ts_unique').on(
      table.slackChannelId,
      table.ts,
    ),
    index('slack_messages_slack_workspace_id_idx').on(table.slackWorkspaceId),
    index('slack_messages_slack_channel_id_idx').on(table.slackChannelId),
    index('slack_messages_thread_ts_idx').on(table.threadTs),
    index('slack_messages_occurred_at_idx').on(table.occurredAt),
    // 키워드 검색용 trigram GIN 인덱스(pg_trgm 확장, Phase 0에서 설치).
    // drizzle-kit generate가 이 인덱스를 누락하면 통합에서 마이그레이션 SQL에
    // `CREATE INDEX ... USING gin (text gin_trgm_ops)`를 수동 보강한다.
    index('slack_messages_text_trgm_idx').using(
      'gin',
      sql`${table.text} gin_trgm_ops`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* slackThreads                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Slack 스레드 요약(복원용). `threadTs`로 그룹핑하며 `rootTs`(최소 ts),
 * `replyCount`(그룹 크기-1), `lastReplyAt`(최대 occurredAt)을 저장한다.
 * (slackChannelId, threadTs)는 유일하며 재import 시 재계산 upsert한다.
 * `slackChannelId`는 `slack_channels.id`(내부 uuid)를 가리키는 FK다.
 */
export const slackThreads = pgTable(
  'slack_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slackWorkspaceId: uuid('slack_workspace_id')
      .notNull()
      .references(() => slackWorkspaces.id),
    slackChannelId: uuid('slack_channel_id')
      .notNull()
      .references(() => slackChannels.id),
    threadTs: text('thread_ts').notNull(),
    rootTs: text('root_ts').notNull(),
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: timestamp('last_reply_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('slack_threads_slack_channel_id_thread_ts_unique').on(
      table.slackChannelId,
      table.threadTs,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (workspace & slack)                                              */
/* -------------------------------------------------------------------------- */

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

export type SlackWorkspace = typeof slackWorkspaces.$inferSelect;
export type NewSlackWorkspace = typeof slackWorkspaces.$inferInsert;

export type SlackChannel = typeof slackChannels.$inferSelect;
export type NewSlackChannel = typeof slackChannels.$inferInsert;

export type SlackUser = typeof slackUsers.$inferSelect;
export type NewSlackUser = typeof slackUsers.$inferInsert;

export type SlackMessage = typeof slackMessages.$inferSelect;
export type NewSlackMessage = typeof slackMessages.$inferInsert;

export type SlackThread = typeof slackThreads.$inferSelect;
export type NewSlackThread = typeof slackThreads.$inferInsert;

/* ========================================================================== */
/* Phase 7 — Hybrid RAG (Phase 7 Build Spec §2)                               */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* 상수 (embedding 차원)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Embedding 벡터 차원. Mock provider 기준 고정값이며 pgvector `vector` 컬럼
 * 차원과 일치해야 한다(PRD §3.4 / 스펙 §2). 실제 OpenAI/Anthropic provider가
 * 다른 차원을 반환하면 재임베딩 + 컬럼 차원 변경(마이그레이션)이 필요하다.
 */
export const EMBEDDING_DIM = 256;

/* -------------------------------------------------------------------------- */
/* chunks                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * RAG 검색 단위 청크(PRD §31 Phase 7 / 스펙 §1.1). Slack 스레드(threadTs 그룹)를
 * 하나의 청크로 결합하거나 비-스레드 단독 메시지를 청크로 만든다. 소유 스코프는
 * `workspaceId`(workspaces.ownerUserId 소유자 본인만 접근, PRD §26)다.
 *
 * - `sourceType`: 'slack_thread' | 'slack_message'.
 * - `sourceRefId`: threadTs(스레드) 또는 message ts(단독 메시지).
 * - `slackChannelId`는 `slack_channels.id`(내부 uuid) FK(nullable), `channelName`은
 *   citation 표기용 사본이다. `occurredAt`은 스레드 root의 occurredAt이다.
 *
 * 멱등 재인덱싱은 UNIQUE(workspaceId, sourceType, sourceRefId) +
 * onConflictDoUpdate(text/occurredAt 갱신)로 강제한다(중복 없음). `text`
 * GIN(gin_trgm_ops) 인덱스는 FTS(pg_trgm similarity)용이며, 원문·PII는 로그에
 * 남기지 않는다.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    sourceType: text('source_type').notNull(),
    sourceRefId: text('source_ref_id').notNull(),
    slackChannelId: uuid('slack_channel_id').references(() => slackChannels.id),
    channelName: text('channel_name'),
    text: text('text').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** 온라인 projection이 가리키는 최신 immutable chunk revision. */
    currentRevisionId: uuid('current_revision_id').references(
      (): AnyPgColumn => chunkRevisions.id,
    ),
    /** 삭제 전파로 검색·추출 projection에서 제외된 시각. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('chunks_workspace_id_source_type_source_ref_id_unique').on(
      table.workspaceId,
      table.sourceType,
      table.sourceRefId,
    ),
    index('chunks_workspace_id_idx').on(table.workspaceId),
    index('chunks_occurred_at_idx').on(table.occurredAt),
    // FTS(pg_trgm similarity)용 trigram GIN 인덱스(pg_trgm 확장, Phase 0에서 설치).
    // drizzle-kit generate가 이 인덱스를 누락하면 통합에서 마이그레이션 SQL에
    // `CREATE INDEX ... USING gin (text gin_trgm_ops)`를 수동 보강한다.
    index('chunks_text_trgm_idx').using('gin', sql`${table.text} gin_trgm_ops`),
  ],
);

/* -------------------------------------------------------------------------- */
/* embeddings                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 청크 embedding(pgvector). 청크당 1건(UNIQUE(chunkId))이며 재인덱싱은
 * onConflictDoUpdate로 갱신한다(중복 없음, 스펙 §1.1/§5). `embedding`은
 * `vector(EMBEDDING_DIM)` 컬럼이고 검색은 코사인 거리(`<=>`) 오름차순으로 한다.
 * `model`은 provider 식별자('mock' 등), `dim`은 벡터 차원 사본이다.
 * 임베딩 값 자체는 로그에 남기지 않는다(count/식별자만).
 *
 * HNSW cosine 인덱스는 drizzle `.using('hnsw', sql\`... vector_cosine_ops\`)`로
 * 시도한다. drizzle-kit generate가 이 인덱스를 누락하면 통합에서 마이그레이션
 * SQL에 `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`를 수동
 * 보강한다(pgvector 0.8 지원).
 */
export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id),
    model: text('model').notNull(),
    dim: integer('dim').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
    /** 현재 벡터를 재현하는 immutable embedding version. */
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => embeddingVersions.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('embeddings_chunk_id_unique').on(table.chunkId),
    // 검색은 현재 provider의 model/dim으로 반드시 필터한다. 모델 전환 중
    // 서로 다른 벡터 공간이 한 ranking에 섞이지 않게 하는 P0 안전 인덱스다.
    index('embeddings_model_dim_idx').on(table.model, table.dim),
    // HNSW cosine 인덱스(pgvector). generate 누락 시 마이그레이션 SQL 수동 보강.
    index('embeddings_embedding_hnsw_idx').using(
      'hnsw',
      sql`${table.embedding} vector_cosine_ops`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (RAG)                                                            */
/* -------------------------------------------------------------------------- */

export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;

export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;

/* ========================================================================== */
/* Phase 8 — 장기 기억 (Phase 8 Build Spec §2)                                 */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* pgEnum (memory)                                                            */
/* -------------------------------------------------------------------------- */

/** 기억 종류(PRD §20). */
export const memoryType = pgEnum('memory_type', [
  'event',
  'fact',
  'decision',
  'preference',
  'procedure',
  'incident',
  'task',
]);

/** 기억 상태(후보/승인/거부/대체). */
export const memoryStatus = pgEnum('memory_status', [
  'candidate',
  'approved',
  'rejected',
  'superseded',
]);

/** 후보 기억 검토 상태(대기/승인/거부). */
export const candidateStatus = pgEnum('candidate_status', [
  'pending',
  'approved',
  'rejected',
]);

/** 기억 원문 종류(PRD §3.1 원문 연결). */
export const memorySourceType = pgEnum('memory_source_type', [
  'chunk',
  'slack_message',
  'card_sms',
  'manual',
]);

/* -------------------------------------------------------------------------- */
/* memoryCandidates                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 후보 기억(추출 → 검토 대기, 스펙 §1.1). 워커 `memory-extract` 잡이 workspace의
 * chunks 텍스트를 결정적 규칙 함수(`@family/rag` extractMemoryCandidates)로
 * 분류해 생성한다(status='pending'). 소유 스코프는 `workspaceId`
 * (workspaces.ownerUserId 소유자 본인만 접근, PRD §26)다.
 *
 * 멱등성은 source chunk revision + extractor version + 후보 identity로 강제한다.
 * 같은 청크가 편집되거나 추출기 규칙이 바뀌면 기존 사용자 검토 상태를 덮지 않고
 * 별도 후보가 생성된다. `sourceChunkRevisionId`는 append-only 입력 계보,
 * `extractorVersion`은 결과 재현 경계다.
 */
export const memoryCandidates = pgTable(
  'memory_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: memoryType('type').notNull(),
    subject: text('subject').notNull(),
    subjectHash: text('subject_hash').notNull(),
    content: text('content').notNull(),
    confidence: integer('confidence').notNull(),
    sourceChunkId: uuid('source_chunk_id').references(() => chunks.id),
    sourceChunkRevisionId: uuid('source_chunk_revision_id').references(
      (): AnyPgColumn => chunkRevisions.id,
    ),
    extractorVersion: text('extractor_version')
      .notNull()
      .default('memory-rule-v1'),
    sourceRefId: text('source_ref_id'),
    status: candidateStatus('status').notNull().default('pending'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull(),
    promotedMemoryId: uuid('promoted_memory_id').references(
      (): AnyPgColumn => memories.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('memory_candidates_revision_type_hash_extractor_unique')
      .on(
        table.workspaceId,
        table.sourceChunkRevisionId,
        table.type,
        table.subjectHash,
        table.extractorVersion,
      )
      .where(sql`${table.sourceChunkRevisionId} is not null`),
    index('memory_candidates_workspace_id_idx').on(table.workspaceId),
    index('memory_candidates_workspace_id_status_idx').on(
      table.workspaceId,
      table.status,
    ),
    index('memory_candidates_source_chunk_revision_id_idx').on(
      table.sourceChunkRevisionId,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* memories                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 승인된 장기 기억(PRD §20). 소유 스코프는 `workspaceId`
 * (workspaces.ownerUserId 소유자 본인만 접근, PRD §26)다. 현재/과거 구분은
 * `validFrom`(기본 observedAt) / `validUntil`(null=현재 유효)로 하며, supersede
 * 시 기존 기억을 status='superseded' + validUntil=now로 마감하고 새 기억이
 * `supersedesMemoryId`로 이전 기억을 가리킨다(스펙 §1.3, self-FK AnyPgColumn).
 * `observedAt`은 관측 시점, `confidence`는 0~100 정수, `createdBy`는 승인/생성
 * 사용자, `deletedAt`은 soft delete다.
 */
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: memoryType('type').notNull(),
    subject: text('subject').notNull(),
    content: text('content').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    confidence: integer('confidence').notNull(),
    status: memoryStatus('status').notNull().default('approved'),
    supersedesMemoryId: uuid('supersedes_memory_id').references(
      (): AnyPgColumn => memories.id,
    ),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('memories_workspace_id_idx').on(table.workspaceId),
    index('memories_workspace_id_type_idx').on(table.workspaceId, table.type),
    index('memories_workspace_id_status_idx').on(
      table.workspaceId,
      table.status,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* memorySources                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 기억 원문 연결(PRD §3.1). 하나의 memory는 여러 원문을 참조할 수 있으며,
 * `sourceType`('chunk'|'slack_message'|'card_sms'|'manual')별로 `sourceRefId`
 * (chunkId, slack threadTs, 'manual' 등)를 가리킨다. 승인 시 chunk → 원본 Slack
 * 스레드 역추적이 가능하다. (memoryId, sourceType, sourceRefId)는 유일하다
 * (동일 원문 중복 연결 방지).
 */
export const memorySources = pgTable(
  'memory_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id),
    sourceType: memorySourceType('source_type').notNull(),
    sourceRefId: text('source_ref_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('memory_sources_memory_id_source_type_source_ref_id_unique').on(
      table.memoryId,
      table.sourceType,
      table.sourceRefId,
    ),
    index('memory_sources_memory_id_idx').on(table.memoryId),
  ],
);

/* -------------------------------------------------------------------------- */
/* memoryVersions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 기억 수정 이력(스펙 §1.4). PATCH 시 변경 *전* 스냅샷을 저장한다(version 증가).
 * `subject`/`content`는 변경 전 값, `changeReason`은 변경 사유(선택),
 * `changedBy`는 변경 사용자다. (memoryId, version)은 유일하다.
 */
export const memoryVersions = pgTable(
  'memory_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id),
    version: integer('version').notNull(),
    subject: text('subject').notNull(),
    content: text('content').notNull(),
    changeReason: text('change_reason'),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('memory_versions_memory_id_version_unique').on(
      table.memoryId,
      table.version,
    ),
    index('memory_versions_memory_id_idx').on(table.memoryId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (memory)                                                         */
/* -------------------------------------------------------------------------- */

export type MemoryCandidate = typeof memoryCandidates.$inferSelect;
export type NewMemoryCandidate = typeof memoryCandidates.$inferInsert;

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

export type MemorySource = typeof memorySources.$inferSelect;
export type NewMemorySource = typeof memorySources.$inferInsert;

export type MemoryVersion = typeof memoryVersions.$inferSelect;
export type NewMemoryVersion = typeof memoryVersions.$inferInsert;

/* ========================================================================== */
/* Phase 9 — Temporal GraphRAG (Phase 9 Build Spec §2)                        */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* pgEnum (graph)                                                             */
/* -------------------------------------------------------------------------- */

/** 엔티티 종류(PRD §22 / 스펙 §2). person/technology는 규칙 추출, 나머지는 확장 지점. */
export const entityType = pgEnum('entity_type', [
  'person',
  'technology',
  'project',
  'decision',
  'incident',
  'topic',
]);

/** 관계 종류(PRD §20/§22 / 스펙 §2). supersedes는 명시적 대체 체인용. */
export const relationshipType = pgEnum('relationship_type', [
  'relates_to',
  'resolves',
  'works_on',
  'uses',
  'decides',
  'supersedes',
]);

/* -------------------------------------------------------------------------- */
/* entities                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 지식 그래프 엔티티(스펙 §1.1). 소유 스코프는 `workspaceId`
 * (workspaces.ownerUserId 소유자 본인만 접근, PRD §26)다. 규칙 추출은 person
 * (canonicalName=slackUserId, name=realName??name)과 technology
 * (canonicalName=정규화 소문자 term, name=표시형)을 만든다.
 *
 * 현재/과거 구분은 `validFrom`(최초 등장 chunk occurredAt) / `validUntil`
 * (null=현재 유효)로 한다. 멱등 재추출은 UNIQUE(workspaceId, type, canonicalName) +
 * onConflictDoUpdate(validFrom = least(기존, 신규))로 강제한다(중복 없음).
 * `metadata`는 확장 메타(원문·PII는 담지 않음)다.
 */
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: entityType('type').notNull(),
    name: text('name').notNull(),
    canonicalName: text('canonical_name').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('entities_workspace_id_type_canonical_name_unique').on(
      table.workspaceId,
      table.type,
      table.canonicalName,
    ),
    index('entities_workspace_id_idx').on(table.workspaceId),
    index('entities_workspace_id_type_idx').on(table.workspaceId, table.type),
  ],
);

/* -------------------------------------------------------------------------- */
/* relationships                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 지식 그래프 관계(스펙 §1.2/§1.3). 소유 스코프는 `workspaceId`
 * (workspaces.ownerUserId 소유자 본인만 접근, PRD §26)다. 규칙 추출은 chunk 단위로
 * technology 쌍의 relates_to/resolves를 만들며 `validFrom`=chunk.occurredAt,
 * `sourceRefId`=chunk sourceRefId(원문 연결), `confidence`(0~100 정수)를 담는다.
 *
 * Temporal supersede는 **명시적 API**다(자동 결정변경 추론 안 함): 새 관계가 기존을
 * 대체하면 기존을 `validUntil`=now로 마감하고, 새 관계가 `supersedesRelationshipId`로
 * 이전 관계를 가리킨다(self-FK, forward 없이 자기참조이므로 AnyPgColumn lazy 콜백).
 *
 * 자동 추출 관계는 `sourceChunkRevisionId`와 `extractorVersion`을 가지며 동일
 * revision 재시도만 unique index로 흡수한다. 새 revision 처리 시 이전 자동 관계는
 * `validUntil`로 마감되고 새 관계가 별도 행으로 추가된다. 명시적 supersede 관계는
 * chunk provenance가 null이라 자동 reconcile 대상에서 제외된다.
 */
export const relationships = pgTable(
  'relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    sourceEntityId: uuid('source_entity_id')
      .notNull()
      .references(() => entities.id),
    targetEntityId: uuid('target_entity_id')
      .notNull()
      .references(() => entities.id),
    type: relationshipType('type').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    supersedesRelationshipId: uuid('supersedes_relationship_id').references(
      (): AnyPgColumn => relationships.id,
    ),
    sourceChunkId: uuid('source_chunk_id').references(() => chunks.id),
    sourceChunkRevisionId: uuid('source_chunk_revision_id').references(
      (): AnyPgColumn => chunkRevisions.id,
    ),
    extractorVersion: text('extractor_version')
      .notNull()
      .default('graph-rule-v1'),
    sourceRefId: text('source_ref_id'),
    confidence: integer('confidence').notNull().default(60),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('relationships_revision_edge_extractor_unique')
      .on(
        table.workspaceId,
        table.sourceEntityId,
        table.type,
        table.targetEntityId,
        table.sourceChunkRevisionId,
        table.extractorVersion,
      )
      .where(sql`${table.sourceChunkRevisionId} is not null`),
    index('relationships_workspace_id_idx').on(table.workspaceId),
    index('relationships_source_entity_id_idx').on(table.sourceEntityId),
    index('relationships_target_entity_id_idx').on(table.targetEntityId),
    index('relationships_workspace_id_type_idx').on(
      table.workspaceId,
      table.type,
    ),
    index('relationships_source_chunk_id_idx').on(table.sourceChunkId),
    index('relationships_source_chunk_revision_id_idx').on(
      table.sourceChunkRevisionId,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* graphEntityMentions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 청크 revision별 엔티티 관측 이력. `entities`는 canonical current projection인
 * 반면 이 테이블은 어떤 extractor가 어느 immutable chunk revision에서 엔티티를
 * 발견했는지 보존한다. 새 revision/추출기 처리 시 이전 mention은 validUntil로
 * 마감되며, 다른 current chunk의 열린 mention이 하나라도 있으면 entity는 current다.
 */
export const graphEntityMentions = pgTable(
  'graph_entity_mentions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    sourceChunkId: uuid('source_chunk_id')
      .notNull()
      .references(() => chunks.id),
    sourceChunkRevisionId: uuid('source_chunk_revision_id')
      .notNull()
      .references((): AnyPgColumn => chunkRevisions.id),
    extractorVersion: text('extractor_version').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('graph_entity_mentions_revision_entity_extractor_unique').on(
      table.sourceChunkRevisionId,
      table.entityId,
      table.extractorVersion,
    ),
    index('graph_entity_mentions_workspace_id_idx').on(table.workspaceId),
    index('graph_entity_mentions_source_chunk_id_idx').on(table.sourceChunkId),
    index('graph_entity_mentions_entity_id_idx').on(table.entityId),
    index('graph_entity_mentions_current_idx')
      .on(table.entityId, table.validUntil)
      .where(sql`${table.validUntil} is null`),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (graph)                                                          */
/* -------------------------------------------------------------------------- */

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

export type Relationship = typeof relationships.$inferSelect;
export type NewRelationship = typeof relationships.$inferInsert;

export type GraphEntityMention = typeof graphEntityMentions.$inferSelect;
export type NewGraphEntityMention = typeof graphEntityMentions.$inferInsert;

/* ========================================================================== */
/* AI 학습 데이터 제어 평면 (ADR-0017 P0/P1)                                 */
/* ========================================================================== */

/** 파이프라인/단계 실행 상태. terminal 상태는 succeeded/failed/quarantined/cancelled다. */
export const pipelineRunStatus = pgEnum('pipeline_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'quarantined',
  'cancelled',
]);

/** 파이프라인 실행을 시작한 원인. */
export const pipelineTrigger = pgEnum('pipeline_trigger', [
  'api',
  'bullmq',
  'scheduled',
  'backfill',
  'system',
]);

/** 관측 대상 AI 연산 종류. */
export const aiOperation = pgEnum('ai_operation', [
  'llm_generate',
  'embedding',
  'rerank',
  'classification',
]);

/** AI 호출 결과. 관측 저장 실패는 실제 AI 호출 결과를 바꾸지 않는다. */
export const aiInvocationOutcome = pgEnum('ai_invocation_outcome', [
  'succeeded',
  'failed',
]);

/** feedback의 생성 주체. model_prediction은 정답 라벨로 간주하지 않는다. */
export const feedbackSource = pgEnum('feedback_source', [
  'human_confirmed',
  'human_rejected',
  'system_rule',
  'model_prediction',
  'imported_gold',
]);

/** Immutable 데이터셋 snapshot의 검증·승인 수명주기. */
export const datasetSnapshotStatus = pgEnum('dataset_snapshot_status', [
  'draft',
  'validated',
  'approved',
  'revoked',
]);

/** 학습/검증/평가 분할. 동일 group key는 항상 하나의 split에만 속한다. */
export const datasetSplit = pgEnum('dataset_split', [
  'train',
  'validation',
  'test',
]);

/** 모델 registry 승인 수명주기. identity 필드는 등록 후 변경하지 않는다. */
export const modelRegistryStatus = pgEnum('model_registry_status', [
  'candidate',
  'approved',
  'rejected',
  'retired',
]);

/** 별도 Training Runner 실행과 파생 artifact의 수명주기. */
export const trainingRunStatus = pgEnum('training_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'revoked',
]);

/** 평가 계산은 성공했지만 품질 gate는 별도로 passed/failed를 기록한다. */
export const evaluationRunStatus = pgEnum('evaluation_run_status', [
  'succeeded',
  'revoked',
]);

/** 서버가 계산한 offline 품질 gate 결과. */
export const evaluationGateResult = pgEnum('evaluation_gate_result', [
  'passed',
  'failed',
]);

/** named model alias 변경 원인. */
export const modelAliasChangeType = pgEnum('model_alias_change_type', [
  'promotion',
  'rollback',
]);

/** 승격 revision의 운영 canary 관측 상태. */
export const modelCanaryStatus = pgEnum('model_canary_status', [
  'monitoring',
  'passed',
  'rolled_back',
  'superseded',
]);

/** 원문 없는 운영 경보 종류. */
export const operationalAlertKind = pgEnum('operational_alert_kind', [
  'pipeline_failed',
  'outbox_quarantined',
  'canary_rolled_back',
  'canary_suspended',
]);

export const operationalAlertSeverity = pgEnum(
  'operational_alert_severity',
  ['warning', 'critical'],
);

export const operationalAlertStatus = pgEnum('operational_alert_status', [
  'pending',
  'delivered',
  'failed',
]);

/** 후보 모델 traffic 실행 방식. */
export const modelTrafficMode = pgEnum('model_traffic_mode', [
  'shadow',
  'live',
]);

/** 모델 traffic 정책 수명주기. */
export const modelTrafficPolicyStatus = pgEnum('model_traffic_policy_status', [
  'active',
  'paused',
  'superseded',
]);

/** AI 호출이 traffic 정책에서 맡은 역할. */
export const modelTrafficRole = pgEnum('model_traffic_role', [
  'primary',
  'candidate',
]);

/* -------------------------------------------------------------------------- */
/* pipelineRuns                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 파이프라인 1회 실행. BullMQ job 재시도도 별도 run으로 남겨 시도별 지연/실패를
 * 보존한다. `externalRunId`는 job id 등 외부 상관키이며 재실행을 허용하므로
 * unique가 아니다. 원문·PII는 저장하지 않는다.
 */
export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipelineName: text('pipeline_name').notNull(),
    pipelineVersion: text('pipeline_version').notNull(),
    scopeType: text('scope_type'),
    scopeId: text('scope_id'),
    trigger: pipelineTrigger('trigger').notNull(),
    externalRunId: text('external_run_id'),
    codeSha: text('code_sha'),
    configHash: text('config_hash'),
    status: pipelineRunStatus('status').notNull().default('queued'),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('pipeline_runs_pipeline_name_started_at_idx').on(
      table.pipelineName,
      table.startedAt,
    ),
    index('pipeline_runs_status_started_at_idx').on(
      table.status,
      table.startedAt,
    ),
    index('pipeline_runs_external_run_id_idx').on(table.externalRunId),
    check(
      'pipeline_runs_scope_pair_check',
      sql`(${table.scopeType} is null) = (${table.scopeId} is null)`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* pipelineStepRuns                                                          */
/* -------------------------------------------------------------------------- */

/** 파이프라인 단계별 시도와 품질/처리량 집계. metrics에는 원문을 저장하지 않는다. */
export const pipelineStepRuns = pgTable(
  'pipeline_step_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipelineRunId: uuid('pipeline_run_id')
      .notNull()
      .references(() => pipelineRuns.id),
    stepName: text('step_name').notNull(),
    stepVersion: text('step_version').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: pipelineRunStatus('status').notNull().default('queued'),
    inputCount: integer('input_count'),
    outputCount: integer('output_count'),
    rejectedCount: integer('rejected_count'),
    metrics: jsonb('metrics')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('pipeline_step_runs_run_step_attempt_unique').on(
      table.pipelineRunId,
      table.stepName,
      table.attempt,
    ),
    index('pipeline_step_runs_status_started_at_idx').on(
      table.status,
      table.startedAt,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* aiInvocations                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 원문 없는 AI 호출 trace. 입력은 SHA-256 fingerprint와 개수만 저장하며 prompt,
 * context, embedding, 응답 본문, 오류 메시지는 저장하지 않는다. `errorCode`에는
 * 오류 class/name처럼 비민감 코드만 허용한다.
 */
export const aiInvocations = pgTable(
  'ai_invocations',
  {
    id: uuid('id').primaryKey(),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
    modelAliasId: uuid('model_alias_id').references(
      (): AnyPgColumn => modelAliases.id,
    ),
    modelAliasRevision: integer('model_alias_revision'),
    modelRegistryId: uuid('model_registry_id').references(
      (): AnyPgColumn => modelRegistry.id,
    ),
    trafficPolicyId: uuid('traffic_policy_id').references(
      (): AnyPgColumn => modelTrafficPolicies.id,
    ),
    trafficMode: modelTrafficMode('traffic_mode'),
    trafficRole: modelTrafficRole('traffic_role'),
    trafficBucket: integer('traffic_bucket'),
    trafficSelected: boolean('traffic_selected'),
    task: text('task').notNull(),
    operation: aiOperation('operation').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version'),
    inputFingerprint: text('input_fingerprint').notNull(),
    inputCount: integer('input_count').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms').notNull(),
    outcome: aiInvocationOutcome('outcome').notNull(),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('ai_invocations_task_started_at_idx').on(table.task, table.startedAt),
    index('ai_invocations_model_started_at_idx').on(
      table.model,
      table.startedAt,
    ),
    index('ai_invocations_outcome_started_at_idx').on(
      table.outcome,
      table.startedAt,
    ),
    index('ai_invocations_pipeline_run_id_idx').on(table.pipelineRunId),
    index('ai_invocations_alias_revision_started_at_idx').on(
      table.modelAliasId,
      table.modelAliasRevision,
      table.startedAt,
    ),
    index('ai_invocations_traffic_policy_started_at_idx').on(
      table.trafficPolicyId,
      table.startedAt,
    ),
    check(
      'ai_invocations_serving_trace_check',
      sql`num_nonnulls(${table.modelAliasId}, ${table.modelAliasRevision}, ${table.modelRegistryId}) in (0, 3)`,
    ),
    check(
      'ai_invocations_alias_revision_check',
      sql`${table.modelAliasRevision} is null or ${table.modelAliasRevision} > 0`,
    ),
    check(
      'ai_invocations_traffic_trace_check',
      sql`num_nonnulls(${table.trafficPolicyId}, ${table.trafficMode}, ${table.trafficRole}, ${table.trafficBucket}, ${table.trafficSelected}) in (0, 5)`,
    ),
    check(
      'ai_invocations_traffic_bucket_check',
      sql`${table.trafficBucket} is null or (${table.trafficBucket} >= 0 and ${table.trafficBucket} < 10000)`,
    ),
    check('ai_invocations_input_count_check', sql`${table.inputCount} >= 0`),
    check('ai_invocations_duration_ms_check', sql`${table.durationMs} >= 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* feedbackEvents                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 사용자/시스템 feedback append-only 이력. label은 category slug, relevant id처럼
 * 구조화된 값만 저장하고 자유형식 원문은 저장하지 않는다. 원문 학습 payload는
 * 별도 암호화 저장소를 도입하기 전까지 수집하지 않는다(ADR-0017).
 */
export const feedbackEvents = pgTable(
  'feedback_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    householdId: uuid('household_id').references(() => households.id),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    predictionTraceId: uuid('prediction_trace_id').references(
      () => aiInvocations.id,
    ),
    labelSchemaVersion: text('label_schema_version').notNull(),
    label: jsonb('label').$type<Record<string, unknown>>().notNull(),
    source: feedbackSource('source').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('feedback_events_workspace_id_occurred_at_idx').on(
      table.workspaceId,
      table.occurredAt,
    ),
    index('feedback_events_household_id_occurred_at_idx').on(
      table.householdId,
      table.occurredAt,
    ),
    index('feedback_events_target_idx').on(table.targetType, table.targetId),
    index('feedback_events_prediction_trace_id_idx').on(
      table.predictionTraceId,
    ),
    check(
      'feedback_events_scope_check',
      sql`num_nonnulls(${table.workspaceId}, ${table.householdId}) <= 1`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* dataEvents (PostgreSQL transactional outbox)                              */
/* -------------------------------------------------------------------------- */

/**
 * 도메인 변경과 같은 트랜잭션에서 기록하는 outbox event. dispatcher는
 * unpublished 행을 lease로 claim해 BullMQ에 at-least-once 발행한다. payload에는
 * 원문 대신 consumer가 필요한 식별자만 저장한다.
 */
export const dataEvents = pgTable(
  'data_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    revisionId: uuid('revision_id'),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    householdId: uuid('household_id').references(() => households.id),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    producerPipelineRunId: uuid('producer_pipeline_run_id').references(
      () => pipelineRuns.id,
    ),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishAttempts: integer('publish_attempts').notNull().default(0),
    reprocessCount: integer('reprocess_count').notNull().default(0),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    quarantinedAt: timestamp('quarantined_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastReprocessedAt: timestamp('last_reprocessed_at', { withTimezone: true }),
    lastReprocessedBy: uuid('last_reprocessed_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('data_events_aggregate_event_revision_unique').on(
      table.aggregateType,
      table.aggregateId,
      table.eventType,
      table.revisionId,
    ),
    index('data_events_aggregate_idx').on(
      table.aggregateType,
      table.aggregateId,
      table.occurredAt,
    ),
    index('data_events_unpublished_available_idx')
      .on(table.availableAt, table.id)
      .where(
        sql`${table.publishedAt} is null and ${table.quarantinedAt} is null`,
      ),
    index('data_events_producer_pipeline_run_id_idx').on(
      table.producerPipelineRunId,
    ),
    index('data_events_quarantined_at_idx').on(table.quarantinedAt),
    check(
      'data_events_scope_check',
      sql`num_nonnulls(${table.workspaceId}, ${table.householdId}) <= 1`,
    ),
    check(
      'data_events_lock_pair_check',
      sql`(${table.lockedAt} is null) = (${table.lockedBy} is null)`,
    ),
    check(
      'data_events_terminal_check',
      sql`num_nonnulls(${table.publishedAt}, ${table.quarantinedAt}) <= 1`,
    ),
    check('data_events_attempts_check', sql`${table.publishAttempts} >= 0`),
    check(
      'data_events_reprocess_count_check',
      sql`${table.reprocessCount} >= 0`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* operationalAlerts (외부 알림 outbox)                                      */
/* -------------------------------------------------------------------------- */

/**
 * pipeline 실패·outbox 격리·canary rollback을 외부 webhook으로 전달하는
 * 영속 outbox. details에는 원문·사용자·scope 식별자를 저장하지 않는다.
 */
export const operationalAlerts = pgTable(
  'operational_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    kind: operationalAlertKind('kind').notNull(),
    severity: operationalAlertSeverity('severity').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    summary: text('summary').notNull(),
    details: jsonb('details')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: operationalAlertStatus('status').notNull().default('pending'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('operational_alerts_pending_available_idx')
      .on(table.availableAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    index('operational_alerts_kind_occurred_at_idx').on(
      table.kind,
      table.occurredAt,
    ),
    check(
      'operational_alerts_lock_pair_check',
      sql`(${table.lockedAt} is null) = (${table.lockedBy} is null)`,
    ),
    check(
      'operational_alerts_terminal_check',
      sql`(${table.status} = 'pending' and ${table.deliveredAt} is null and ${table.failedAt} is null) or (${table.status} = 'delivered' and ${table.deliveredAt} is not null and ${table.failedAt} is null) or (${table.status} = 'failed' and ${table.deliveredAt} is null and ${table.failedAt} is not null)`,
    ),
    check(
      'operational_alerts_attempts_check',
      sql`${table.deliveryAttempts} >= 0`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* sourceRevisions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * MinIO 원본 manifest의 append-only revision. 원문은 복사하지 않고 object key와
 * content hash, 처리 schema/동의 snapshot만 보존한다. `validUntil=null`인 행이
 * source item의 current revision이며 기존 source_items 행은 migration에서 v1으로
 * backfill한다.
 */
export const sourceRevisions = pgTable(
  'source_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceItemId: uuid('source_item_id')
      .notNull()
      .references(() => sourceItems.id),
    revision: integer('revision').notNull(),
    objectKey: text('object_key').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    parserSchemaVersion: text('parser_schema_version').notNull(),
    consentScope: jsonb('consent_scope')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    isTombstone: boolean('is_tombstone').notNull().default(false),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('source_revisions_item_revision_unique').on(
      table.sourceItemId,
      table.revision,
    ),
    uniqueIndex('source_revisions_item_current_unique')
      .on(table.sourceItemId)
      .where(sql`${table.validUntil} is null`),
    index('source_revisions_content_hash_idx').on(table.contentHash),
    index('source_revisions_pipeline_run_id_idx').on(table.pipelineRunId),
    check('source_revisions_revision_check', sql`${table.revision} > 0`),
    check('source_revisions_size_bytes_check', sql`${table.sizeBytes} >= 0`),
    check(
      'source_revisions_validity_check',
      sql`${table.validUntil} is null or ${table.validUntil} > ${table.validFrom}`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* chunkRevisions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 온라인 `chunks` projection의 append-only 재현 이력. 같은 content/source hash와
 * transform version 조합은 재사용하며, 변경될 때만 새 revision을 발행한다.
 * 원문은 workspace 내부 PostgreSQL에만 보존하고 trace/artifact에는 복사하지 않는다.
 * 개인정보 삭제 시에는 재현성보다 삭제권을 우선해 과거 text를 비우고 `deletedAt`을
 * 기록하며, current는 별도 tombstone revision으로 전환한다.
 */
export const chunkRevisions = pgTable(
  'chunk_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id),
    revision: integer('revision').notNull(),
    contentHash: text('content_hash').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    text: text('text').notNull(),
    chunkerVersion: text('chunker_version').notNull(),
    redactionVersion: text('redaction_version').notNull(),
    isTombstone: boolean('is_tombstone').notNull().default(false),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('chunk_revisions_chunk_revision_unique').on(
      table.chunkId,
      table.revision,
    ),
    uniqueIndex('chunk_revisions_chunk_current_unique')
      .on(table.chunkId)
      .where(sql`${table.validUntil} is null`),
    index('chunk_revisions_content_transform_idx').on(
      table.contentHash,
      table.chunkerVersion,
      table.redactionVersion,
    ),
    index('chunk_revisions_pipeline_run_id_idx').on(table.pipelineRunId),
    check('chunk_revisions_revision_check', sql`${table.revision} > 0`),
    check(
      'chunk_revisions_validity_check',
      sql`${table.validUntil} is null or ${table.validUntil} > ${table.validFrom}`,
    ),
    check(
      'chunk_revisions_tombstone_text_check',
      sql`not ${table.isTombstone} or ${table.text} = ''`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* embeddingVersions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * chunk revision과 모델 revision/preprocessing 조합별 immutable 벡터. 현재
 * `embeddings` projection은 `currentVersionId`로 이 행을 가리킨다.
 */
export const embeddingVersions = pgTable(
  'embedding_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chunkRevisionId: uuid('chunk_revision_id')
      .notNull()
      .references(() => chunkRevisions.id),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    modelRevision: text('model_revision').notNull(),
    preprocessingVersion: text('preprocessing_version').notNull(),
    dim: integer('dim').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
    embeddingHash: text('embedding_hash').notNull(),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('embedding_versions_revision_model_preprocess_unique').on(
      table.chunkRevisionId,
      table.provider,
      table.model,
      table.modelRevision,
      table.preprocessingVersion,
    ),
    index('embedding_versions_model_dim_idx').on(table.model, table.dim),
    index('embedding_versions_pipeline_run_id_idx').on(table.pipelineRunId),
    check('embedding_versions_dim_check', sql`${table.dim} > 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* ragRetrievalExamples                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 사용자가 명시적으로 확정한 RAG 질의–관련 청크 pair. 자유형식 질의는 DB에
 * 저장하지 않고 workspace 전용 object storage에 두며, 여기에는 검증용 hash와
 * immutable chunk revision 계보만 보존한다. source 삭제 시 revoked 처리한다.
 */
export const ragRetrievalExamples = pgTable(
  'rag_retrieval_examples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    feedbackEventId: uuid('feedback_event_id')
      .notNull()
      .references(() => feedbackEvents.id),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id),
    chunkRevisionId: uuid('chunk_revision_id')
      .notNull()
      .references(() => chunkRevisions.id),
    queryObjectKey: text('query_object_key').notNull(),
    queryHash: text('query_hash').notNull(),
    labelSchemaVersion: text('label_schema_version').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('rag_retrieval_examples_feedback_unique').on(table.feedbackEventId),
    unique('rag_retrieval_examples_workspace_query_chunk_unique').on(
      table.workspaceId,
      table.queryHash,
      table.chunkRevisionId,
    ),
    index('rag_retrieval_examples_workspace_occurred_at_idx').on(
      table.workspaceId,
      table.occurredAt,
    ),
    index('rag_retrieval_examples_chunk_revision_id_idx').on(
      table.chunkRevisionId,
    ),
    check(
      'rag_retrieval_examples_query_hash_check',
      sql`${table.queryHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'rag_retrieval_examples_revocation_check',
      sql`(${table.revokedAt} is null) = (${table.revocationReason} is null)`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* lineageEdges                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 삭제·재현에 필요한 revision 경계의 계보. node id는 현재 모두 UUID지만 generic
 * node type으로 source_revision→chunk_revision→embedding_version/dataset_snapshot
 * 확장을 허용한다. 동일 revision 관계는 실행을 반복해도 한 번만 남긴다.
 */
export const lineageEdges = pgTable(
  'lineage_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromNodeType: text('from_node_type').notNull(),
    fromNodeId: uuid('from_node_id').notNull(),
    toNodeType: text('to_node_type').notNull(),
    toNodeId: uuid('to_node_id').notNull(),
    transformVersion: text('transform_version').notNull(),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('lineage_edges_from_to_transform_unique').on(
      table.fromNodeType,
      table.fromNodeId,
      table.toNodeType,
      table.toNodeId,
      table.transformVersion,
    ),
    index('lineage_edges_from_idx').on(table.fromNodeType, table.fromNodeId),
    index('lineage_edges_to_idx').on(table.toNodeType, table.toNodeId),
    index('lineage_edges_pipeline_run_id_idx').on(table.pipelineRunId),
    check(
      'lineage_edges_self_check',
      sql`${table.fromNodeType} <> ${table.toNodeType} or ${table.fromNodeId} <> ${table.toNodeId}`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* datasetSnapshots / datasetSnapshotItems                                   */
/* -------------------------------------------------------------------------- */

/**
 * MinIO Gold 영역의 immutable dataset artifact/manifest 등록부. v1은 workspace
 * 또는 household 한 범위만 허용하며 cross-workspace snapshot은 만들지 않는다.
 */
export const datasetSnapshots = pgTable(
  'dataset_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    householdId: uuid('household_id').references(() => households.id),
    task: text('task').notNull(),
    version: text('version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    artifactKey: text('artifact_key').notNull(),
    artifactHash: text('artifact_hash').notNull(),
    manifestKey: text('manifest_key').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    splitPolicy: jsonb('split_policy')
      .$type<Record<string, unknown>>()
      .notNull(),
    consentScope: jsonb('consent_scope')
      .$type<Record<string, unknown>>()
      .notNull(),
    rowCount: integer('row_count').notNull(),
    status: datasetSnapshotStatus('status').notNull().default('draft'),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
    createdBy: uuid('created_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('dataset_snapshots_workspace_task_version_unique')
      .on(table.workspaceId, table.task, table.version)
      .where(sql`${table.workspaceId} is not null`),
    uniqueIndex('dataset_snapshots_household_task_version_unique')
      .on(table.householdId, table.task, table.version)
      .where(sql`${table.householdId} is not null`),
    index('dataset_snapshots_status_created_at_idx').on(
      table.status,
      table.createdAt,
    ),
    index('dataset_snapshots_artifact_hash_idx').on(table.artifactHash),
    check(
      'dataset_snapshots_scope_check',
      sql`num_nonnulls(${table.workspaceId}, ${table.householdId}) = 1`,
    ),
    check('dataset_snapshots_row_count_check', sql`${table.rowCount} >= 0`),
    check(
      'dataset_snapshots_revocation_check',
      sql`${table.status} <> 'revoked' or ${table.revokedAt} is not null`,
    ),
  ],
);

/** snapshot에 고정된 label과 task별 입력 계보(chunk revision 또는 merchant rule). */
export const datasetSnapshotItems = pgTable(
  'dataset_snapshot_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetSnapshotId: uuid('dataset_snapshot_id')
      .notNull()
      .references(() => datasetSnapshots.id),
    feedbackEventId: uuid('feedback_event_id')
      .notNull()
      .references(() => feedbackEvents.id),
    chunkRevisionId: uuid('chunk_revision_id').references(
      () => chunkRevisions.id,
    ),
    merchantCategoryRuleId: uuid('merchant_category_rule_id').references(
      () => merchantCategoryRules.id,
    ),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    split: datasetSplit('split').notNull(),
    splitGroupHash: text('split_group_hash'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('dataset_snapshot_items_snapshot_feedback_unique').on(
      table.datasetSnapshotId,
      table.feedbackEventId,
    ),
    index('dataset_snapshot_items_chunk_revision_id_idx').on(
      table.chunkRevisionId,
    ),
    index('dataset_snapshot_items_merchant_rule_id_idx').on(
      table.merchantCategoryRuleId,
    ),
    index('dataset_snapshot_items_target_idx').on(
      table.targetType,
      table.targetId,
    ),
    index('dataset_snapshot_items_split_group_idx').on(
      table.datasetSnapshotId,
      table.splitGroupHash,
      table.split,
    ),
    check(
      'dataset_snapshot_items_input_check',
      sql`num_nonnulls(${table.chunkRevisionId}, ${table.merchantCategoryRuleId}) = 1`,
    ),
    check(
      'dataset_snapshot_items_split_audit_check',
      sql`num_nonnulls(${table.splitGroupHash}, ${table.occurredAt}) in (0, 2) and (${table.splitGroupHash} is null or ${table.splitGroupHash} ~ '^[a-f0-9]{64}$')`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* modelRegistry / evaluationRuns / modelAliases                             */
/* -------------------------------------------------------------------------- */

/**
 * workspace 또는 household 한 범위에 속하는 immutable 모델 identity 등록부.
 * credential이나 object key는 저장·노출하지 않으며 artifact checksum만 선택적으로
 * 기록한다. 상태와 승인 감사 필드만 수명주기 중 변경된다.
 */
export const modelRegistry = pgTable(
  'model_registry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    householdId: uuid('household_id').references(() => households.id),
    task: text('task').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    version: text('version').notNull(),
    artifactHash: text('artifact_hash'),
    dimensions: integer('dimensions'),
    status: modelRegistryStatus('status').notNull().default('candidate'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('model_registry_workspace_identity_unique')
      .on(
        table.workspaceId,
        table.task,
        table.provider,
        table.model,
        table.version,
      )
      .where(sql`${table.workspaceId} is not null`),
    uniqueIndex('model_registry_household_identity_unique')
      .on(
        table.householdId,
        table.task,
        table.provider,
        table.model,
        table.version,
      )
      .where(sql`${table.householdId} is not null`),
    index('model_registry_task_status_created_at_idx').on(
      table.task,
      table.status,
      table.createdAt,
    ),
    check(
      'model_registry_scope_check',
      sql`num_nonnulls(${table.workspaceId}, ${table.householdId}) = 1`,
    ),
    check(
      'model_registry_dimensions_check',
      sql`${table.dimensions} is null or ${table.dimensions} > 0`,
    ),
    check(
      'model_registry_artifact_hash_check',
      sql`${table.artifactHash} is null or ${table.artifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'model_registry_approval_check',
      sql`${table.status} not in ('approved', 'retired') or (${table.approvedAt} is not null and ${table.approvedBy} is not null)`,
    ),
  ],
);

/**
 * 승인 dataset에서 별도 자원으로 실행하는 학습 기록. object key는 내부 전용이며
 * API는 checksum·환경 지문·원문 없는 평가 지표만 노출한다.
 */
export const trainingRuns = pgTable(
  'training_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetSnapshotId: uuid('dataset_snapshot_id')
      .notNull()
      .references(() => datasetSnapshots.id),
    modelRegistryId: uuid('model_registry_id').references(
      () => modelRegistry.id,
    ),
    task: text('task').notNull(),
    trainerVersion: text('trainer_version').notNull(),
    status: trainingRunStatus('status').notNull().default('queued'),
    artifactKey: text('artifact_key'),
    artifactHash: text('artifact_hash'),
    environment: jsonb('environment').$type<Record<string, unknown>>(),
    metrics: jsonb('metrics').$type<Record<string, unknown>>(),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    artifactPurgedAt: timestamp('artifact_purged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('training_runs_dataset_created_at_idx').on(
      table.datasetSnapshotId,
      table.createdAt,
    ),
    index('training_runs_status_created_at_idx').on(
      table.status,
      table.createdAt,
    ),
    index('training_runs_model_registry_id_idx').on(table.modelRegistryId),
    check(
      'training_runs_artifact_hash_check',
      sql`${table.artifactHash} is null or ${table.artifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'training_runs_execution_state_check',
      sql`
        (${table.status} = 'queued' and ${table.startedAt} is null and ${table.completedAt} is null)
        or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.completedAt} is null)
        or (${table.status} in ('succeeded', 'failed', 'blocked', 'revoked') and ${table.completedAt} is not null)
      `,
    ),
    check(
      'training_runs_success_artifact_check',
      sql`${table.status} <> 'succeeded' or num_nonnulls(${table.modelRegistryId}, ${table.artifactKey}, ${table.artifactHash}, ${table.environment}, ${table.metrics}) = 5`,
    ),
    check(
      'training_runs_error_check',
      sql`${table.status} not in ('failed', 'blocked') or ${table.errorCode} is not null`,
    ),
    check(
      'training_runs_revocation_check',
      sql`${table.status} <> 'revoked' or (${table.revokedAt} is not null and ${table.revocationReason} is not null)`,
    ),
  ],
);

/**
 * 고정 snapshot에 대한 immutable offline 평가. evaluator가 제출한 수치만 보관하고
 * gateResult와 gateDetails는 API 서버가 결정적으로 계산한다.
 */
export const evaluationRuns = pgTable(
  'evaluation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetSnapshotId: uuid('dataset_snapshot_id')
      .notNull()
      .references(() => datasetSnapshots.id),
    baselineModelId: uuid('baseline_model_id').references(
      () => modelRegistry.id,
    ),
    candidateModelId: uuid('candidate_model_id')
      .notNull()
      .references(() => modelRegistry.id),
    evaluatorVersion: text('evaluator_version').notNull(),
    baselineMetrics: jsonb('baseline_metrics').$type<Record<string, number>>(),
    candidateMetrics: jsonb('candidate_metrics')
      .$type<Record<string, number>>()
      .notNull(),
    baselineSliceMetrics: jsonb('baseline_slice_metrics').$type<
      Record<string, Record<string, number>>
    >(),
    candidateSliceMetrics: jsonb('candidate_slice_metrics')
      .$type<Record<string, Record<string, number>>>()
      .notNull()
      .default({}),
    gateCriteria: jsonb('gate_criteria')
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    gateDetails: jsonb('gate_details')
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    gateResult: evaluationGateResult('gate_result').notNull(),
    evaluationHash: text('evaluation_hash').notNull(),
    status: evaluationRunStatus('status').notNull().default('succeeded'),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('evaluation_runs_evaluation_hash_unique').on(table.evaluationHash),
    index('evaluation_runs_dataset_created_at_idx').on(
      table.datasetSnapshotId,
      table.createdAt,
    ),
    index('evaluation_runs_candidate_created_at_idx').on(
      table.candidateModelId,
      table.createdAt,
    ),
    index('evaluation_runs_gate_created_at_idx').on(
      table.gateResult,
      table.createdAt,
    ),
    check(
      'evaluation_runs_baseline_pair_check',
      sql`(${table.baselineModelId} is null) = (${table.baselineMetrics} is null)`,
    ),
    check(
      'evaluation_runs_hash_check',
      sql`${table.evaluationHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'evaluation_runs_revocation_check',
      sql`${table.status} <> 'revoked' or ${table.revokedAt} is not null`,
    ),
  ],
);

/** 모델 승인의 통과 평가 근거. 모델별 최초 승인 1건을 불변으로 보존한다. */
export const modelRegistryApprovals = pgTable(
  'model_registry_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelRegistryId: uuid('model_registry_id')
      .notNull()
      .references(() => modelRegistry.id),
    evaluationRunId: uuid('evaluation_run_id')
      .notNull()
      .references(() => evaluationRuns.id),
    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('model_registry_approvals_model_unique').on(table.modelRegistryId),
    index('model_registry_approvals_evaluation_idx').on(table.evaluationRunId),
  ],
);

/** scope/task/name별 현재 모델 alias projection. */
export const modelAliases = pgTable(
  'model_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    householdId: uuid('household_id').references(() => households.id),
    task: text('task').notNull(),
    alias: text('alias').notNull(),
    modelRegistryId: uuid('model_registry_id')
      .notNull()
      .references(() => modelRegistry.id),
    revision: integer('revision').notNull().default(1),
    evaluationRunId: uuid('evaluation_run_id').references(
      () => evaluationRuns.id,
    ),
    lastChangeType: modelAliasChangeType('last_change_type').notNull(),
    activatedBy: uuid('activated_by')
      .notNull()
      .references(() => users.id),
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspensionReason: text('suspension_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('model_aliases_workspace_task_alias_unique')
      .on(table.workspaceId, table.task, table.alias)
      .where(sql`${table.workspaceId} is not null`),
    uniqueIndex('model_aliases_household_task_alias_unique')
      .on(table.householdId, table.task, table.alias)
      .where(sql`${table.householdId} is not null`),
    index('model_aliases_model_registry_id_idx').on(table.modelRegistryId),
    check(
      'model_aliases_scope_check',
      sql`num_nonnulls(${table.workspaceId}, ${table.householdId}) = 1`,
    ),
    check('model_aliases_revision_check', sql`${table.revision} > 0`),
    check(
      'model_aliases_suspension_pair_check',
      sql`(${table.suspendedAt} is null) = (${table.suspensionReason} is null)`,
    ),
  ],
);

/** alias의 append-only 변경 이력. 직전 model을 기록해 결정적 rollback을 제공한다. */
export const modelAliasRevisions = pgTable(
  'model_alias_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelAliasId: uuid('model_alias_id')
      .notNull()
      .references(() => modelAliases.id),
    revision: integer('revision').notNull(),
    previousModelRegistryId: uuid('previous_model_registry_id').references(
      () => modelRegistry.id,
    ),
    modelRegistryId: uuid('model_registry_id')
      .notNull()
      .references(() => modelRegistry.id),
    evaluationRunId: uuid('evaluation_run_id').references(
      () => evaluationRuns.id,
    ),
    changeType: modelAliasChangeType('change_type').notNull(),
    /** 승격/rollback 직전에 서버가 계산한 runtime 안전 게이트 감사 정보. */
    gateDetails: jsonb('gate_details')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('model_alias_revisions_alias_revision_unique').on(
      table.modelAliasId,
      table.revision,
    ),
    index('model_alias_revisions_model_idx').on(table.modelRegistryId),
    check('model_alias_revisions_revision_check', sql`${table.revision} > 0`),
  ],
);

/**
 * 현재 production alias revision 위에서 승인된 후보를 shadow 또는 live traffic으로
 * 실행하는 정책. alias revision 변경 시 기존 정책은 resolver에서 자동 무효화된다.
 */
export const modelTrafficPolicies = pgTable(
  'model_traffic_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelAliasId: uuid('model_alias_id')
      .notNull()
      .references(() => modelAliases.id),
    aliasRevision: integer('alias_revision').notNull(),
    candidateModelRegistryId: uuid('candidate_model_registry_id')
      .notNull()
      .references(() => modelRegistry.id),
    evaluationRunId: uuid('evaluation_run_id')
      .notNull()
      .references(() => evaluationRuns.id),
    mode: modelTrafficMode('mode').notNull(),
    trafficBasisPoints: integer('traffic_basis_points').notNull(),
    routingSalt: text('routing_salt').notNull(),
    status: modelTrafficPolicyStatus('status').notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('model_traffic_policies_active_alias_unique')
      .on(table.modelAliasId)
      .where(sql`${table.status} = 'active'`),
    index('model_traffic_policies_candidate_idx').on(
      table.candidateModelRegistryId,
    ),
    check(
      'model_traffic_policies_alias_revision_check',
      sql`${table.aliasRevision} > 0`,
    ),
    check(
      'model_traffic_policies_basis_points_check',
      sql`${table.trafficBasisPoints} between 1 and 10000`,
    ),
    check(
      'model_traffic_policies_routing_salt_check',
      sql`length(${table.routingSalt}) between 1 and 200`,
    ),
    check(
      'model_traffic_policies_deactivation_check',
      sql`(${table.status} = 'active') = (${table.deactivatedAt} is null)`,
    ),
  ],
);

/**
 * 기존 모델 위에 승격된 revision의 운영 canary 정책과 최신 판정 projection.
 * 원본 호출은 `ai_invocations`에 append-only로 남고, 이 행은 동일 정책의 집계
 * 상태만 갱신한다. alias/revision당 정책은 하나만 허용한다.
 */
export const modelCanaryRuns = pgTable(
  'model_canary_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelAliasId: uuid('model_alias_id')
      .notNull()
      .references(() => modelAliases.id),
    aliasRevision: integer('alias_revision').notNull(),
    minimumInvocationCount: integer('minimum_invocation_count').notNull(),
    maximumErrorRateBasisPoints: integer(
      'maximum_error_rate_basis_points',
    ).notNull(),
    maximumP95DurationMs: integer('maximum_p95_duration_ms').notNull(),
    windowStartedAt: timestamp('window_started_at', {
      withTimezone: true,
    }).notNull(),
    windowEndsAt: timestamp('window_ends_at', { withTimezone: true }).notNull(),
    status: modelCanaryStatus('status').notNull().default('monitoring'),
    observedInvocationCount: integer('observed_invocation_count')
      .notNull()
      .default(0),
    observedFailedInvocationCount: integer('observed_failed_invocation_count')
      .notNull()
      .default(0),
    observedErrorRateBasisPoints: integer('observed_error_rate_basis_points')
      .notNull()
      .default(0),
    observedP95DurationMs: integer('observed_p95_duration_ms')
      .notNull()
      .default(0),
    decisionReason: text('decision_reason'),
    rollbackRevision: integer('rollback_revision'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    lastEvaluationTrigger: text('last_evaluation_trigger').$type<
      'manual' | 'scheduled'
    >(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('model_canary_runs_alias_revision_unique').on(
      table.modelAliasId,
      table.aliasRevision,
    ),
    index('model_canary_runs_status_window_ends_at_idx').on(
      table.status,
      table.windowEndsAt,
    ),
    check(
      'model_canary_runs_revision_check',
      sql`${table.aliasRevision} > 0 and (${table.rollbackRevision} is null or ${table.rollbackRevision} > ${table.aliasRevision})`,
    ),
    check(
      'model_canary_runs_policy_check',
      sql`${table.minimumInvocationCount} > 0 and ${table.maximumErrorRateBasisPoints} between 0 and 10000 and ${table.maximumP95DurationMs} > 0 and ${table.windowEndsAt} > ${table.windowStartedAt}`,
    ),
    check(
      'model_canary_runs_observation_check',
      sql`${table.observedInvocationCount} >= 0 and ${table.observedFailedInvocationCount} between 0 and ${table.observedInvocationCount} and ${table.observedErrorRateBasisPoints} between 0 and 10000 and ${table.observedP95DurationMs} >= 0`,
    ),
    check(
      'model_canary_runs_decision_check',
      sql`(${table.status} = 'monitoring' and ${table.decisionReason} is null and ${table.rollbackRevision} is null) or (${table.status} = 'passed' and ${table.decisionReason} is not null and ${table.rollbackRevision} is null) or (${table.status} = 'rolled_back' and ${table.decisionReason} is not null and ${table.rollbackRevision} is not null) or (${table.status} = 'superseded' and ${table.rollbackRevision} is null)`,
    ),
    check(
      'model_canary_runs_evaluation_trigger_check',
      sql`${table.lastEvaluationTrigger} is null or ${table.lastEvaluationTrigger} in ('manual', 'scheduled')`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (AI 학습 데이터 제어 평면)                                      */
/* -------------------------------------------------------------------------- */

export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type NewPipelineRun = typeof pipelineRuns.$inferInsert;

export type PipelineStepRun = typeof pipelineStepRuns.$inferSelect;
export type NewPipelineStepRun = typeof pipelineStepRuns.$inferInsert;

export type AiInvocation = typeof aiInvocations.$inferSelect;
export type NewAiInvocation = typeof aiInvocations.$inferInsert;

export type FeedbackEvent = typeof feedbackEvents.$inferSelect;
export type NewFeedbackEvent = typeof feedbackEvents.$inferInsert;

export type DataEvent = typeof dataEvents.$inferSelect;
export type NewDataEvent = typeof dataEvents.$inferInsert;

export type OperationalAlert = typeof operationalAlerts.$inferSelect;
export type NewOperationalAlert = typeof operationalAlerts.$inferInsert;

export type SourceRevision = typeof sourceRevisions.$inferSelect;
export type NewSourceRevision = typeof sourceRevisions.$inferInsert;

export type ChunkRevision = typeof chunkRevisions.$inferSelect;
export type NewChunkRevision = typeof chunkRevisions.$inferInsert;

export type EmbeddingVersion = typeof embeddingVersions.$inferSelect;
export type NewEmbeddingVersion = typeof embeddingVersions.$inferInsert;

export type RagRetrievalExample = typeof ragRetrievalExamples.$inferSelect;
export type NewRagRetrievalExample = typeof ragRetrievalExamples.$inferInsert;

export type LineageEdge = typeof lineageEdges.$inferSelect;
export type NewLineageEdge = typeof lineageEdges.$inferInsert;

export type DatasetSnapshot = typeof datasetSnapshots.$inferSelect;
export type NewDatasetSnapshot = typeof datasetSnapshots.$inferInsert;

export type DatasetSnapshotItem = typeof datasetSnapshotItems.$inferSelect;
export type NewDatasetSnapshotItem = typeof datasetSnapshotItems.$inferInsert;

export type ModelRegistryEntry = typeof modelRegistry.$inferSelect;
export type NewModelRegistryEntry = typeof modelRegistry.$inferInsert;

export type TrainingRun = typeof trainingRuns.$inferSelect;
export type NewTrainingRun = typeof trainingRuns.$inferInsert;

export type EvaluationRun = typeof evaluationRuns.$inferSelect;
export type NewEvaluationRun = typeof evaluationRuns.$inferInsert;

export type ModelRegistryApproval = typeof modelRegistryApprovals.$inferSelect;
export type NewModelRegistryApproval =
  typeof modelRegistryApprovals.$inferInsert;

export type ModelAlias = typeof modelAliases.$inferSelect;
export type NewModelAlias = typeof modelAliases.$inferInsert;

export type ModelAliasRevision = typeof modelAliasRevisions.$inferSelect;
export type NewModelAliasRevision = typeof modelAliasRevisions.$inferInsert;

export type ModelCanaryRun = typeof modelCanaryRuns.$inferSelect;
export type NewModelCanaryRun = typeof modelCanaryRuns.$inferInsert;
export type ModelTrafficPolicy = typeof modelTrafficPolicies.$inferSelect;
export type NewModelTrafficPolicy = typeof modelTrafficPolicies.$inferInsert;
