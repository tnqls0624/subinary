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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    // 소유 스코프는 소스 종류별로 다르다: card_sms→householdId(가족), slack→workspaceId
    // (개인/회사 workspace, PRD §3.6). 둘 다 nullable, 종류별로 하나만 채운다.
    householdId: uuid('household_id').references(() => households.id),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
 * Date로 변환한 값(Asia/Seoul 기준 timestamptz)이다. 멱등 Import는
 * UNIQUE(slackChannelId, ts) + onConflictDoNothing으로 강제한다.
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('embeddings_chunk_id_unique').on(table.chunkId),
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
 * 멱등성은 UNIQUE(workspaceId, sourceChunkId, type, subjectHash)로 강제한다 —
 * `subjectHash`는 앱이 계산한 md5(subject) 사본이며, 동일 chunk에서 같은
 * type/subject 후보가 중복 생성되지 않도록 한다(재추출 시 onConflictDoNothing/
 * Update). `confidence`는 0~100 정수(규칙 강도), `sourceRefId`는 chunk의
 * sourceRefId(threadTs 등) 사본, 승인 시 `promotedMemoryId`로 생성된 memory에
 * 연결한다(memories를 나중에 선언하므로 forward-FK는 AnyPgColumn lazy 콜백).
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
    sourceRefId: text('source_ref_id'),
    status: candidateStatus('status').notNull().default('pending'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull(),
    promotedMemoryId: uuid('promoted_memory_id').references(
      (): AnyPgColumn => memories.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('memory_candidates_workspace_chunk_type_hash_unique').on(
      table.workspaceId,
      table.sourceChunkId,
      table.type,
      table.subjectHash,
    ),
    index('memory_candidates_workspace_id_idx').on(table.workspaceId),
    index('memory_candidates_workspace_id_status_idx').on(
      table.workspaceId,
      table.status,
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
 * 멱등 재추출은 UNIQUE(workspaceId, sourceEntityId, type, targetEntityId,
 * sourceRefId) + onConflictDoNothing으로 강제한다 — 추출은 항상 sourceRefId를
 * 채우므로 중복이 없고, 명시적 supersede는 새 row(제약 무관)다. Postgres는 UNIQUE의
 * nullable 컬럼 null을 distinct로 취급한다.
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
    sourceRefId: text('source_ref_id'),
    confidence: integer('confidence').notNull().default(60),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // 5컬럼 UNIQUE 이름은 기본 생성 시 63자를 넘으므로 축약한다(ws/src/tgt/ref).
    unique('relationships_ws_src_type_tgt_ref_unique').on(
      table.workspaceId,
      table.sourceEntityId,
      table.type,
      table.targetEntityId,
      table.sourceRefId,
    ),
    index('relationships_workspace_id_idx').on(table.workspaceId),
    index('relationships_source_entity_id_idx').on(table.sourceEntityId),
    index('relationships_target_entity_id_idx').on(table.targetEntityId),
    index('relationships_workspace_id_type_idx').on(
      table.workspaceId,
      table.type,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (graph)                                                          */
/* -------------------------------------------------------------------------- */

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

export type Relationship = typeof relationships.$inferSelect;
export type NewRelationship = typeof relationships.$inferInsert;
