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
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('user_sessions_refresh_token_hash_unique').on(table.refreshTokenHash),
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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
  consentedAt: timestamp('consented_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/* -------------------------------------------------------------------------- */
/* 추론 타입 (select / insert)                                                */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

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
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    unique('device_nonces_device_id_nonce_unique').on(table.deviceId, table.nonce),
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
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    kind: sourceKind('kind').notNull(),
    objectKey: text('object_key').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    deviceId: uuid('device_id').references(() => registeredDevices.id),
    memberId: uuid('member_id').references(() => householdMembers.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('source_items_household_id_idx').on(table.householdId),
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
    parseStatus: cardSmsParseStatus('parse_status').notNull().default('pending'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
