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
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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
    /**
     * 왜 폐기됐는가 — refresh 재사용 유예(24h)를 **회전에만** 적용하기 위해 필요하다.
     *
     * 유예는 다중 탭 동시 회전과 모바일 회전 응답 유실을 자동 로그아웃으로 처리하지
     * 않으려고 도입했다. 그런데 `revokedAt`만 보면 **명시적 로그아웃과 비밀번호 변경도
     * 유예 대상**이 되어, 로그아웃 뒤 24시간 동안 같은 토큰으로 세션을 다시 받을 수
     * 있었다("모든 기기에서 로그아웃"이 거짓이 된다).
     *
     * `rotated`만 유예하고 나머지는 즉시 401이다. NULL(이 컬럼 도입 이전 행)은
     * 기존 동작대로 유예를 적용한다 — 살아 있는 세션을 마이그레이션만으로 끊지 않는다.
     */
    revokedReason: text('revoked_reason', {
      enum: ['rotated', 'logout', 'password_change', 'reuse_detected'],
    }),
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
  /**
   * 공용 카드 결제의 표시 색(팔레트 키). NULL이면 중립 회색 — 기본 동작.
   *
   * 구성원 색과 같은 팔레트를 쓰되 저장 위치가 다르다: 공용은 구성원이 아니라
   * 가구에 하나뿐인 귀속 보류 묶음이다. 값 검증은 `memberColorSchema`가 한다.
   */
  sharedColor: text('shared_color'),
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

/**
 * 가족 합류 동의 기록 (PRD §7.3). consentType 예: 'household_join'.
 *
 * **append-only 이력이다.** 철회는 행을 지우지 않고 `status`를 'revoked'로 전이시키고
 * (`revokedAt`·`revokedReason` 기록), 재동의는 **새 행을 추가**한다. 그래서 "언제
 * 동의했다가 언제 철회했고 언제 다시 동의했는가"가 그대로 남는다 — 0047이 장치·
 * 자격증명에서 삭제 대신 상태 전이를 택한 것과 같은 이유이고, 개인정보 동의는 그
 * 이력 자체가 증빙이라 더더욱 덮어쓰면 안 된다.
 *
 * `consentVersion`의 원문은 **코드가 단일 출처**다(`@family/contracts`의
 * `householdConsentDocuments`). DB에는 버전 문자열만 남기고 사용자가 실제로 읽은
 * 문구는 그 레지스트리에서 되짚는다 — 그래서 알 수 없는 버전 문자열이 DB에 있으면
 * 추적이 끊긴다(0051이 그 상태를 RAISE EXCEPTION으로 막는다).
 *
 * 부분 유니크(가구·사용자·타입당 granted 1행)를 걸지 **않는다**: 가족을 나갔다가
 * 다시 합류하면 서로 다른 시점의 정당한 동의 행이 여러 개 생기고, 이 이력을 사람이
 * 손으로 지워야만 인덱스가 붙는 상황은 "동의 이력 보존"과 정면으로 충돌한다.
 * 대신 현재 상태는 "가장 최근 consentedAt 행"으로 읽고, 철회는 살아있는 granted 행을
 * **전부** 전이시켜 잔여 granted가 남지 않게 한다.
 */
export const householdConsents = pgTable(
  'household_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    consentType: text('consent_type').notNull(),
    consentVersion: text('consent_version').notNull().default('v1'),
    /** 'granted' | 'revoked'. CHECK로 DB가 강제한다. */
    status: text('status').notNull().default('granted'),
    consentedAt: timestamp('consented_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** 'user_request' | 'member_removed' 등. 사후에 "왜 끊겼는지"를 설명한다. */
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('household_consents_scope_idx').on(
      table.householdId,
      table.userId,
      table.consentType,
    ),
    check(
      'household_consents_status_check',
      sql`${table.status} in ('granted', 'revoked')`,
    ),
    // status와 revoked_at이 어긋난 행("철회했다는데 언제인지 모름")을 원천 차단한다.
    check(
      'household_consents_revoked_at_check',
      sql`(${table.status} = 'revoked') = (${table.revokedAt} is not null)`,
    ),
  ],
);

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
  /**
   * 본인이 결제한 건도 푸시로 알릴지. **기본 꺼짐** — 카드사가 이미 같은 결제로
   * 문자를 보내므로 앱 알림은 같은 사건의 두 번째 통지다(실측 미열람률 45%).
   * 가족 구성원의 결제는 이 설정과 무관하게 알린다.
   */
  notifyOwnCollected: boolean('notify_own_collected').notNull().default(false),
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
    /**
     * 마지막으로 이 장치가 **인증에 성공**한 시각(수집 POST·ping 포함).
     * 아래 lastEventAt과 함께 보면 "인증은 되는데 문자 트리거가 안 걸림"을 구분할 수 있다.
     */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** 이 장치에서 카드 문자가 **처음** 도착한 시각. 온보딩 완주 판정(활성화)에 쓴다. */
    firstEventAt: timestamp('first_event_at', { withTimezone: true }),
    /** 이 장치에서 카드 문자가 **마지막으로** 도착한 시각. 수집 생존 판정에 쓴다. */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
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
  (table) => [
    // 앱 로직(회전 시 기존 active→revoked)만으로는 동시 회전 두 건이 각각 active를
    // 남겨 서버가 임의로 고른 쪽과 클라이언트가 받은 secret이 어긋난다(401). 장치당
    // active 1개를 DB가 강제한다.
    uniqueIndex('device_credentials_device_active_unique')
      .on(table.deviceId)
      .where(sql`${table.status} = 'active'`),
    index('device_credentials_device_id_idx').on(table.deviceId),
  ],
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

/**
 * 카드 문자 파싱 상태(pending→parsed/parse_failed/pending_review/quarantined).
 *
 * `quarantined`(ADR-0023 §6)는 **승격을 막는 유일한 상태**다. `pending_review`는
 * 이름과 달리 사람 게이트가 아니라 그대로 승격된다(promotion.service가
 * parsed·pending_review를 모두 수용) — 즉 "검토가 필요하다"는 표시일 뿐이다.
 * LLM이 추론한 결과처럼 사람 확인 전에는 거래로 만들면 안 되는 건을 여기 둔다.
 * 승격 경로가 parsed·pending_review만 허용하므로 이 값은 **자동으로 비승격**이다.
 */
export const cardSmsParseStatus = pgEnum('card_sms_parse_status', [
  'pending',
  'parsed',
  'parse_failed',
  'pending_review',
  'quarantined',
]);

/** 카드 거래 종류(승인/취소/거절/미상). declined=승인거절·거부·실패(체결 안 됨, 미승격). */
export const cardSmsTxnType = pgEnum('card_sms_txn_type', [
  'approval',
  'cancellation',
  'declined',
  'unknown',
]);

/**
 * 승인거절 사유. **사유마다 사용자 조치가 다르므로** 별도 축으로 보존한다 —
 * `lost_or_stolen`은 정기결제 수단 갱신, `insufficient_balance`는 입금,
 * `limit_exceeded`는 한도 조정/카드 변경이다. "거절됨"만으로는 아무것도 못 한다.
 *
 * `unknown`은 "사유 문구를 못 알아봤다"는 뜻으로, 거절 사실 자체는 확실하다.
 */
export const cardSmsDeclineReason = pgEnum('card_sms_decline_reason', [
  'lost_or_stolen',
  'limit_exceeded',
  'insufficient_balance',
  'expired_card',
  'suspended',
  'invalid_credential',
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
    /**
     * 이 행의 `event_id`가 어디서 왔는가 — `client`(호출자가 준 멱등 키) /
     * `derived_received_at`(수신 시각으로 파생) / `derived_window`(서버 창으로 파생).
     * 값의 정의는 `card-sms-idempotency.ts`의 `CARD_SMS_KEY_SOURCES`가 정본이다.
     *
     * **NULL은 0050 적용 이전 행이다**(어느 경로였는지 판별 불가). nullable로 두는
     * 이유가 그것이다 — 기본값으로 채우면 없는 사실을 있는 것처럼 세게 된다.
     *
     * 왜 세는가: 멱등 키를 언제 필수화해도 되는지는 "키 없는 수집이 충분히 사라졌는가"로만
     * 판단할 수 있다. 이 컬럼이 그 유일한 근거다(P0-9).
     */
    keySource: text('key_source'),
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
    /**
     * `transaction_type='declined'`일 때의 거절 사유. 거절이 아니면 NULL이다.
     *
     * `card_transactions`가 아니라 이벤트에 두는 이유: declined는 체결이 아니라 거래로
     * 승격되지 않으므로(유령 거래 방지) 거래 테이블에는 행 자체가 없다. 실패는 이벤트
     * 층에서만 관측된다.
     */
    declineReason: cardSmsDeclineReason('decline_reason'),
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
    // 창 기반 중복 판정의 조회 경로: (장치, 본문 지문, 최근 N분). 수집 요청마다 타는
    // 조회라 인덱스가 없으면 이벤트가 쌓일수록 수집 지연이 선형으로 늘어난다.
    index('card_sms_events_device_id_content_hash_received_at_idx').on(
      table.deviceId,
      table.contentHash,
      table.receivedAt,
    ),
    // 값 집합은 코드(CARD_SMS_KEY_SOURCES)와 DB 양쪽에 있어야 한다. 오타 난 값이
    // 들어오면 집계가 조용히 한 갈래를 통째로 놓치고, 그게 필수화 판단을 틀리게 한다.
    check(
      'card_sms_events_key_source_check',
      sql`"card_sms_events"."key_source" is null or "card_sms_events"."key_source" in ('client', 'derived_received_at', 'derived_window')`,
    ),
  ],
);

/**
 * 중복으로 판정해 `card_sms_events`에 넣지 않은 수집 시도의 **원문 보관소**(P0-9).
 *
 * 왜 필요한가: 지금까지 중복 판정된 문자는 아무 흔적도 남기지 않았다. 나중에 그 판정이
 * 오판(= 같은 문자를 만든 별개 결제)으로 밝혀져도 **복구할 근거가 없었다** — 지출이
 * 조용히 과소집계되고 사용자는 이유를 알 방법이 없다. 이 테이블이 그 근거다.
 *
 * 왜 `card_sms_events`에 넣지 않는가: 그 테이블의 행은 곧 거래 승격 후보다. 중복
 * 판정된 시도를 같이 넣으면 승격·집계·목록이 전부 다시 이 문제를 안는다. 승격 대상이
 * 아닌 원문은 승격 대상과 다른 테이블에 있어야 한다.
 *
 * `UNIQUE(device_id, event_id, content_hash)` + `attempts`로 접는 이유: 자동화가
 * 공격적으로 재시도하면(설정 실수·연결 플랩) 같은 시도가 수십 건 쌓인다. 보관의 목적은
 * "무엇이 버려졌는가"이지 "몇 번 눌렀는가"의 낱개 이력이 아니다 — 횟수는 카운터로 충분하다.
 *
 * ⚠️ `raw_content`는 카드 문자 원문(가맹점·금액·마스킹 카드번호)이다. 운영 로그·관측
 * 싱크로 내보내지 말 것. 집계 수치만 로그에 쓴다.
 */
export const cardSmsIngestSuppressions = pgTable(
  'card_sms_ingest_suppressions',
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
    /** 중복으로 판정될 때 이 시도가 들고 있던 멱등 키. */
    eventId: text('event_id').notNull(),
    /** 어느 갈래로 파생된 키였는지(`CARD_SMS_KEY_SOURCES`). */
    keySource: text('key_source').notNull(),
    /** 판정 사유(`CARD_SMS_SUPPRESSION_REASONS`). */
    reason: text('reason').notNull(),
    /**
     * 같은 것으로 판정된 기존 이벤트. **FK를 걸지 않는다** — 이벤트가 지워져도 버려진
     * 원문은 남아야 한다(NO ACTION이면 삭제가 막히고 CASCADE면 보관이 함께 지워진다).
     * 감사 기록이 감사 대상보다 오래 살아야 한다는 0049 수리 로그의 판단과 같다.
     * 경합 패배처럼 대상을 읽지 못한 경우 NULL이다.
     */
    matchedEventId: uuid('matched_event_id'),
    sender: text('sender').notNull(),
    rawContent: text('raw_content').notNull(),
    contentHash: text('content_hash').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(1),
    /**
     * 오판으로 판명돼 실제 이벤트로 되살렸을 때 그 이벤트. 채워지면 이 행은 처리 완료다.
     * 복구 도구가 아직 없어도 컬럼을 먼저 두는 이유: 복구 시점에 "무엇을 이미 되살렸는지"를
     * 알 방법이 없으면 두 번 되살려 이번엔 과대집계가 난다.
     */
    restoredEventId: uuid('restored_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('card_sms_ingest_suppressions_device_event_content_unique').on(
      table.deviceId,
      table.eventId,
      table.contentHash,
    ),
    index('card_sms_ingest_suppressions_household_id_last_seen_at_idx').on(
      table.householdId,
      table.lastSeenAt,
    ),
    index('card_sms_ingest_suppressions_device_id_content_hash_idx').on(
      table.deviceId,
      table.contentHash,
    ),
    check(
      'card_sms_ingest_suppressions_reason_check',
      sql`"card_sms_ingest_suppressions"."reason" in ('event_id_conflict', 'fingerprint_window', 'insert_race')`,
    ),
    check(
      'card_sms_ingest_suppressions_key_source_check',
      sql`"card_sms_ingest_suppressions"."key_source" in ('client', 'derived_received_at', 'derived_window')`,
    ),
    check(
      'card_sms_ingest_suppressions_attempts_check',
      sql`"card_sms_ingest_suppressions"."attempts" >= 1`,
    ),
  ],
);

/**
 * 카드 문자 템플릿 추출 레시피 (ADR-0023 S4).
 *
 * 사람이 확정한 **한 건**에서 유도한 "필드별 몇 번째 후보인가" 규칙을 지문 단위로
 * 저장한다. 같은 레이아웃의 다음 문자는 이 레시피로 결정적으로 추출되어 **LLM을 타지
 * 않는다**.
 *
 * **가구 스코프가 아니다(전역).** 카드사 문자 레이아웃은 사용자와 무관하므로 한 번
 * 확정하면 모두가 쓴다. 개인정보 관점에서 안전한 이유: `recipe`는 후보 **인덱스**만
 * 담고, `skeleton`은 고정 어휘를 제외한 모든 토큰이 슬롯(`@`)으로 접혀 있어 가맹점·
 * 이름·금액이 남지 않는다.
 */
export const cardSmsTemplates = pgTable(
  'card_sms_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** sha256(sender \0 skeleton). 조회 키. */
    fingerprint: text('fingerprint').notNull(),
    sender: text('sender').notNull(),
    /** 슬롯으로 접힌 레이아웃(PII 없음). 감사·디버깅용. */
    skeleton: text('skeleton').notNull(),
    /** `TemplateRecipe`(card-parsers) 직렬화. 후보 인덱스만 담는다. */
    recipe: jsonb('recipe').$type<Record<string, unknown>>().notNull(),
    /** 이 레시피를 만든 확정 건(계보 추적). */
    sourceEventId: uuid('source_event_id')
      .references(() => cardSmsEvents.id, { onDelete: 'set null' }),
    confirmedBy: uuid('confirmed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** 레시피가 실제로 적용된 횟수(효과 관측용). */
    hitCount: integer('hit_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('card_sms_templates_fingerprint_unique').on(table.fingerprint),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (card sms)                                                       */
/* -------------------------------------------------------------------------- */

export type SourceItem = typeof sourceItems.$inferSelect;
export type NewSourceItem = typeof sourceItems.$inferInsert;

export type CardSmsEvent = typeof cardSmsEvents.$inferSelect;
export type NewCardSmsEvent = typeof cardSmsEvents.$inferInsert;

export type CardSmsIngestSuppression = typeof cardSmsIngestSuppressions.$inferSelect;
export type NewCardSmsIngestSuppression =
  typeof cardSmsIngestSuppressions.$inferInsert;

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
    /**
     * 여러 구성원이 **함께 쓰는** 카드인가.
     *
     * 카드 승인 문자에는 "누가 그었는지"가 없다(실측: 마스킹 이름 토큰은 발급사마다
     * 상수이고 카드번호 뒤 4자리도 전부 NULL). 그래서 거래의 `member_id`는 문자를
     * 전달한 **폰의 주인**이 되고, 한 카드의 문자가 한 대에만 오므로 공동사용 카드는
     * 지출이 한 사람에게 전부 몰린다(실측 76% vs 24%).
     *
     * 이 플래그는 그 왜곡을 **없는 정보를 지어내지 않고** 다룬다. 금액을 지분으로
     * 쪼개지 않는다 — 50/50은 계산 결과가 아니라 가정이고, 그것을 실측 금액 옆에 같은
     * 서식으로 놓으면 이 저장소가 지키는 습관("표본 없음을 0으로 쓰지 않는다")과
     * 정면으로 어긋난다. 대신 구성원별 집계에서 **'공용' 버킷**으로 묶는다.
     *
     * 거래 행은 건드리지 않는다. 집계가 조인 시점에 이 플래그를 읽으므로 켜는 순간
     * 과거까지 일관되게 바뀌고, 되돌리기는 플래그를 끄는 것으로 끝난다.
     */
    isShared: boolean('is_shared').notNull().default(false),
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
    /**
     * 소비가 아니라 **자산 이동**인 카테고리(현금 인출·선불 충전·결제대행 정산).
     * 이 카테고리 거래는 지출 집계에서 빠지되 이력은 남는다.
     *
     * 왜 `transactionType`이나 별도 테이블이 아니라 카테고리 플래그인가: 판정 기준이
     * 결국 "이 가맹점이 무엇인가"이고, 그 판단 경로(키워드 규칙 → 사용자 확정 →
     * `merchant_category_rules` 자가학습)가 이미 카테고리에 붙어 있다. 새 축을 만들면
     * 같은 판단을 두 곳에서 학습해야 한다.
     *
     * 실측 계기: ATM 50,000 + 모바일티머니선불 60,000 + 토스페이 58,956 = 168,956원이
     * 지출로 계상돼 총액의 13%를 부풀렸다. 충전액을 실제로 쓸 때 이중 계상되기도 한다.
     */
    isTransfer: boolean('is_transfer').notNull().default(false),
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

/**
 * 사용자가 확정한 가맹점 별칭 — "이거 다 같은 가게예요".
 *
 * `normalizeMerchant`는 결정적 규칙만 적용하므로 로마자↔한글 음차(`GS25` vs
 * `지에스25`)나 카드사가 **잘라 보낸 이름**(`주식회사우아한형` vs
 * `주식회사 우아한형제들`)은 합칠 수 없다. 실측에서 GS25 한 브랜드가 6개 키로
 * 쪼개져 서로 다른 카테고리(장보기 1 / 식비 5)로 학습됐고, 사용자가 같은 가게를
 * 6번 따로 확정해야 했다. 그 판단을 1회로 줄이고 재사용하는 것이 이 테이블이다.
 *
 * 해석은 **1단계만** 한다(alias -> canonical). 체인(`A->B`, `B->C`)은 등록 시
 * 평탄화해 막는다 — 재귀 해석은 순환에 취약하고 승격 경로를 느리게 만든다.
 */
export const merchantAliases = pgTable(
  'merchant_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    /** `normalizeMerchant` 출력값. 승격 시 이 값이 canonical로 치환된다. */
    alias: text('alias').notNull(),
    /** 대표 이름. 카테고리 규칙·집계·분석이 모두 이 값으로 모인다. */
    canonical: text('canonical').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // 한 가구에서 같은 alias가 두 canonical을 가리킬 수 없다(해석이 비결정적이 됨).
    unique('merchant_aliases_household_id_alias_unique').on(
      table.householdId,
      table.alias,
    ),
    index('merchant_aliases_household_canonical_idx').on(
      table.householdId,
      table.canonical,
    ),
    // 자기참조는 무한 해석이므로 DB가 막는다(앱 버그가 데이터를 오염시키지 못하게).
    check(
      'merchant_aliases_alias_not_canonical',
      sql`${table.alias} <> ${table.canonical}`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* categoryRecategorizeBatches · categoryRecategorizeItems                    */
/* -------------------------------------------------------------------------- */

/**
 * 카테고리 **소급 재분류**의 되돌리기 원장 — "사용자가 재분류를 한 번 눌렀다"는 사건.
 *
 * `merchantCategoryRules`는 앞으로의 분류만 학습하고 과거 거래를 소급하지 않는다.
 * 반면 소급 재분류는 클릭 한 번으로 과거 수백 건의 `cardTransactions.categoryId`를
 * 덮어쓰는데, 덮어쓰기 전 값은 UPDATE와 함께 사라져 **잘못 눌러도 되돌릴 수 없다.**
 * 이 표는 그 옛 값을 붙잡아 두기 위해 존재한다.
 *
 * ⚠️ **from(이전 카테고리)을 여기에 단일 컬럼으로 두지 않는다.** 한 배치의 대상 거래들이
 * 같은 카테고리라는 보장이 없다 — 일부는 식비, 일부는 장보기, 일부는 미분류(NULL)가
 * 섞여 있고, 애초에 그 뒤죽박죽이 사용자가 일괄 재분류를 누르는 이유다. 단일 from을
 * 적으면 되돌릴 때 전부 그 값으로 되돌아가 **원래 없던 분류를 만들어 낸다.** 이전 값은
 * {@link categoryRecategorizeItems}에 거래별로 남기고, 여기에는 대상 전체가 실제로
 * 공유하는 사실인 `toCategoryId`만 둔다.
 *
 * `revertedAt`/`revertedBy`/`revertedCount`는 셋이 함께 채워진다(DB CHECK). NULL은
 * "아직 되돌리지 않음"이고, `revertedCount = 0`("되돌렸으나 실제로 바뀐 건 0건")과는
 * 다른 사실이다.
 */
export const categoryRecategorizeBatches = pgTable(
  'category_recategorize_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    /** 적용 시점의 canonical 가맹점명. 표시·감사용이며 **신원이 아니다.** */
    merchantCanonical: text('merchant_canonical').notNull(),
    toCategoryId: uuid('to_category_id')
      .notNull()
      .references(() => expenseCategories.id),
    /**
     * 적용 시점에 실제로 바뀐 거래 수. items 행 수로 대체하지 않는 이유: items는 거래가
     * 삭제되면 함께 사라지므로(cascade) "그때 몇 건을 바꿨나"라는 **과거의 사실**까지
     * 조용히 줄어든다. 감사 기록이 현재 상태를 따라다니면 안 된다.
     */
    appliedCount: integer('applied_count').notNull(),
    appliedBy: uuid('applied_by')
      .notNull()
      .references(() => users.id),
    appliedAt: timestamp('applied_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedBy: uuid('reverted_by').references(() => users.id),
    /** 되돌리기로 실제 되돌린 건수. NULL = 아직 되돌리지 않음(≠ 0건). */
    revertedCount: integer('reverted_count'),
  },
  (table) => [
    // 화면이 묻는 것은 "이 가족이 최근에 무엇을 일괄 재분류했나"다(되돌리기 목록).
    index('category_recategorize_batches_household_applied_at_idx').on(
      table.householdId,
      table.appliedAt.desc(),
    ),
    check(
      'category_recategorize_batches_applied_count_check',
      sql`${table.appliedCount} >= 0`,
    ),
    // 반쯤 채워진 행(시각은 있는데 건수가 NULL)은 "되돌렸는가?"에 답할 수 없다.
    // `is not null`을 일일이 적는 이유: CHECK는 NULL을 통과시킨다. `>= 0`만 쓰면
    // 건수가 NULL일 때 그 가지가 FALSE가 아니라 NULL이 되어 반쪽 행이 그대로 들어온다.
    check(
      'category_recategorize_batches_revert_completeness_check',
      sql`(${table.revertedAt} is null and ${table.revertedBy} is null and ${table.revertedCount} is null) or (${table.revertedAt} is not null and ${table.revertedBy} is not null and ${table.revertedCount} is not null and ${table.revertedCount} >= 0)`,
    ),
  ],
);

/**
 * 배치가 바꾼 거래와 그 거래의 **이전 카테고리**. 되돌리기의 실제 재료다.
 *
 * PK가 `(batchId, transactionId)` 복합키인 이유: 한 배치에서 한 거래는 한 번만 기록돼야
 * 한다. 중복 행이 생기면 되돌릴 값이 둘이 되어 어느 쪽으로 되돌리는지가 비결정적이 된다.
 * 재시도·중복 요청도 이 PK가 그대로 막고, 선두 컬럼 덕에 "이 배치의 항목 전부" 조회가
 * 공짜로 따라온다.
 *
 * 거래·배치가 지워지면 항목도 함께 사라진다(cascade). no action으로 두면 이 원장이
 * 거래 삭제를 영구히 막아 사용자에게는 "왜 삭제가 안 되지"로 보인다.
 */
export const categoryRecategorizeItems = pgTable(
  'category_recategorize_items',
  {
    batchId: uuid('batch_id')
      .notNull()
      .references(() => categoryRecategorizeBatches.id, {
        onDelete: 'cascade',
      }),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => cardTransactions.id, { onDelete: 'cascade' }),
    /**
     * 덮어쓰기 **직전** 값. NULL이 정상값이다 — 미분류 거래를 분류하는 것이 일괄
     * 재분류의 가장 흔한 경우고, 되돌리면 다시 미분류(NULL)로 돌아가야 한다.
     */
    previousCategoryId: uuid('previous_category_id').references(
      () => expenseCategories.id,
    ),
  },
  (table) => [
    primaryKey({
      name: 'category_recategorize_items_batch_id_transaction_id_pk',
      columns: [table.batchId, table.transactionId],
    }),
    // 역방향 조회: "이 거래는 어느 배치가 건드렸나"(거래 상세의 출처 설명, 배치 간 덮어쓰기 판별).
    index('category_recategorize_items_transaction_id_idx').on(
      table.transactionId,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* cardSmsDeclineDismissals                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 결제 실패 묶음의 **사용자 확인 표시**(ADR-0024 후속).
 *
 * `listDeclines`의 `resolvedAt`은 "마지막 거절 이후 같은 가맹점 승인"으로만 채워진다.
 * 그래서 정기결제를 아예 해지한 경우처럼 **후속 승인이 영구히 없는** 실패는 영원히
 * 미해결로 남아 홈 최상단 배너가 사라지지 않는다. 실측(2026-07~08): `버핏서울
 * 106,000원` 7일 연속 거절 후 승인 0건 → 배너가 18일째 해소 불가 상태였다.
 *
 * 묶음 단위(가맹점 + 금액)로 기록하는 이유: 사용자가 닫는 대상이 개별 문자가 아니라
 * "이 사건"이다. 낱개에 표시하면 카드사가 다음 날 재시도할 때 같은 사건이 다시 뜬다.
 *
 * `dismissedAt` **이후에 온 거절은 다시 표시한다**(조회 시 `lastAttemptAt`과 비교).
 * 영구 무시가 아니라 "지금까지의 시도는 확인했다"는 뜻이어야, 몇 달 뒤 같은 가맹점에서
 * 새로 실패했을 때 놓치지 않는다.
 *
 * `merchant`/`amount`가 NULL일 수 있다(가맹점·금액을 파싱하지 못한 거절). NULL을 포함한
 * UNIQUE는 Postgres에서 중복을 막지 못하므로 `NULLS NOT DISTINCT`를 명시한다 — 없으면
 * 같은 묶음을 닫을 때마다 행이 쌓인다.
 */
export const cardSmsDeclineDismissals = pgTable(
  'card_sms_decline_dismissals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    /** `normalizeMerchant`(+별칭) 적용 후의 묶음 키. 미파싱이면 NULL. */
    merchant: text('merchant'),
    /** 묶음 키의 금액(minor units). 미파싱이면 NULL. */
    amount: integer('amount'),
    /** 이 시각까지의 시도를 확인했다는 표시. 이후 거절은 다시 노출된다. */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    dismissedBy: uuid('dismissed_by').references(() => users.id),
  },
  (table) => [
    unique('card_sms_decline_dismissals_bucket_unique')
      .on(table.householdId, table.merchant, table.amount)
      .nullsNotDistinct(),
    index('card_sms_decline_dismissals_household_idx').on(table.householdId),
  ],
);

/* -------------------------------------------------------------------------- */
/* fxRateSnapshots                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 역사 환율 스냅샷 — `(원통화, 기준일, 금액 계약 버전)`당 **불변** 1행 (ADR-0027 §3).
 *
 * 왜 필요한가: 승격 경로의 `getRateToKrw(currency)`는 거래일을 받지 않고 `new Date()`의
 * 서울 날짜로 환율을 조회한다. 그래서 **언제 재시도하느냐가 KRW 금액을 바꾸고**, 승인과
 * 취소가 서로 다른 날 환율로 환산돼 같은 건의 전액취소가 상계되지 않는다(USD 100 승인
 * @1,300 = 130,000원, 전액취소 @1,400 = 140,000원 → 잔액 비교 탈락 → 130,000원이 지출로
 * 남는다). 기준일을 명령 입력으로 고정하고 그 날짜의 값을 한 번만 못 박으면 재시도가
 * 결과를 바꾸지 못한다.
 *
 * `rate` 단위는 **원통화 1 major unit당 KRW**이며 `numeric(24,12)` 고정 소수다.
 * `doublePrecision`을 쓰지 않는 이유는 이진 부동소수가 십진 환율을 정확히 담지 못해
 * 같은 입력이 실행 환경에 따라 1원 차이를 낼 수 있기 때문이다. Drizzle이 이 컬럼을
 * `string`으로 매핑하는 것도 의도한 것이다 — number로 받는 순간 정밀도가 날아간다.
 *
 * `asOfDate`가 timestamp가 아니라 `date`(문자열 `YYYY-MM-DD`)인 이유: 기준일은 "서울의
 * 그 날"이지 순간이 아니다. timestamptz로 두면 읽는 쪽 타임존에 따라 하루가 밀린다.
 *
 * **행을 수정하지 않는다.** 공급자 오류로 잘못 고정된 값도 UPDATE하지 않고 새 계약
 * 버전의 정정 스냅샷을 만든다. 마이그레이션 `0049`가 UPDATE/DELETE를 거부하는 트리거
 * (`fx_rate_snapshots_immutable`)로 이를 DB에서 강제한다. 그래서 채우기는
 * `onConflictDoUpdate`가 아니라 **`onConflictDoNothing` 후 SELECT**여야 한다 —
 * DO UPDATE는 UPDATE라 트리거에 걸린다.
 *
 * 통화 지수(ISO 4217 exponent)는 여기 두지 않는다 — 지수는 코드의 단일 ISO 매핑에서만
 * 가져온다. 두 곳에 두면 어긋났을 때 어느 쪽이 맞는지 판단할 수 없다.
 */
export const fxRateSnapshots = pgTable(
  'fx_rate_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 원통화(ISO 4217 alpha-3). */
    baseCurrency: text('base_currency').notNull(),
    /** 환산 대상 통화. 현재 계약은 KRW만 허용한다(아래 CHECK). */
    quoteCurrency: text('quote_currency').notNull().default('KRW'),
    /** 서울 기준 거래일 `YYYY-MM-DD`. 이 값이 스냅샷의 신원이다. */
    asOfDate: date('as_of_date', { mode: 'string' }).notNull(),
    /** 원통화 1 major unit당 KRW. 정수 스케일(10^12)로 올려서 산술한다. */
    rate: numeric('rate', { precision: 24, scale: 12 }).notNull(),
    provider: text('provider').notNull(),
    providerVersion: text('provider_version').notNull(),
    /** 공급자 응답 식별자(요청 URL·응답 id 등). 사후 감사용. */
    providerReference: text('provider_reference'),
    /**
     * 이 스냅샷이 속한 금액 계약 버전. **기본값을 두지 않는다** — 어느 계약의 값인지는
     * 호출자가 매번 명시해야 하고, 기본값이 있으면 그 판단이 조용히 생략된다.
     */
    moneyContractVersion: integer('money_contract_version').notNull(),
    /** 운영자 승인 대체 환율 등의 출처 메모. */
    note: text('note'),
    /** 운영자가 직접 고정한 스냅샷이면 그 사용자. 공급자 자동 취득이면 null. */
    createdBy: uuid('created_by').references(() => users.id),
    /** 공급자에서 값을 받은 시각(기준일과 다르다). */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // 첫 성공 값이 곧 영구 값이다. 재시도는 전부 이 한 행을 참조한다.
    unique('fx_rate_snapshots_natural_key_unique').on(
      table.baseCurrency,
      table.quoteCurrency,
      table.asOfDate,
      table.moneyContractVersion,
    ),
    check('fx_rate_snapshots_rate_positive_check', sql`${table.rate} > 0`),
    check(
      'fx_rate_snapshots_currency_format_check',
      sql`${table.baseCurrency} ~ '^[A-Z]{3}$' and ${table.quoteCurrency} ~ '^[A-Z]{3}$'`,
    ),
    // 다통화 기준통화가 실제로 필요해지면 이 CHECK 하나만 DROP한다. 제약 없이 두면
    // KRW가 아닌 행이 조용히 들어와 KRW를 가정한 금액 산술이 틀린다.
    check(
      'fx_rate_snapshots_quote_krw_check',
      sql`${table.quoteCurrency} = 'KRW'`,
    ),
    check(
      'fx_rate_snapshots_base_not_quote_check',
      sql`${table.baseCurrency} <> ${table.quoteCurrency}`,
    ),
    // 스냅샷은 v2 계약에서 처음 생긴 개념이다. v1을 담을 자리가 없다.
    check(
      'fx_rate_snapshots_contract_version_check',
      sql`${table.moneyContractVersion} >= 2`,
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
    // amount/netAmount/cancelledAmount는 `currency`의 minor units 정수. 외화 거래는
    // 승격 시 승인 시점 환율로 KRW 환산해 저장하므로 currency='KRW'가 된다(지출/예산/
    // 집계에 통합). 원통화 정보는 아래 original_* 로 병기 보존한다(표시·감사용).
    amount: integer('amount').notNull(),
    cancelledAmount: integer('cancelled_amount').notNull().default(0),
    netAmount: integer('net_amount').notNull(),
    currency: text('currency').notNull().default('KRW'),
    // 외화 원거래(환산 전) — KRW 거래는 전부 null. originalAmount는 originalCurrency의
    // minor units, exchangeRate는 승격 시점 원통화 1단위당 KRW(추정치, 실제 청구는
    // 매입 시점 카드사 환율로 확정).
    originalAmount: integer('original_amount'),
    originalCurrency: text('original_currency'),
    exchangeRate: doublePrecision('exchange_rate'),
    /**
     * 원통화 기준 취소 누계 (ADR-0027 §4, 마이그레이션 `0049`). KRW 거래는 null이다.
     *
     * 왜 KRW 누계로 부족한가: 취소 후보를 **환산된 KRW 잔액**으로 비교하면 승인과 취소가
     * 다른 날 환율을 쓸 때 같은 원통화 전액취소가 잔액 비교에서 탈락한다. 원통화 잔액
     * (`originalAmount - originalCancelledAmount`)으로 비교해야 환율 방향과 무관하게
     * 연결되고, 잔액이 0이면 순액도 정확히 0이 된다.
     */
    originalCancelledAmount: integer('original_cancelled_amount'),
    /**
     * 이 거래를 환산한 환율 스냅샷 (ADR-0027 §3).
     *
     * 연결된 외화 취소는 취소일 환율이 아니라 **부모 승인에 저장된 이 스냅샷**을
     * 재사용한다. 자식이 환율을 다시 조회하면 그 순간 두 날짜의 환율이 섞인다.
     */
    fxRateSnapshotId: uuid('fx_rate_snapshot_id').references(
      () => fxRateSnapshots.id,
    ),
    /**
     * 금액 계약 버전 (ADR-0027). **기본값 1(v1)** — 기존 행과 롤백 창의 이전 바이너리가
     * 만드는 행은 전부 v1로 남고, 새 금액 서비스만 v2를 명시적으로 쓴다. 조건부 v2
     * CHECK(`card_transactions_v2_*`)는 이 값이 2 이상인 행에만 걸린다.
     */
    moneyContractVersion: integer('money_contract_version')
      .notNull()
      .default(1),
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
    index('card_transactions_fx_rate_snapshot_id_idx').on(
      table.fxRateSnapshotId,
    ),
    // 새 컬럼 자체의 정합성만 본다. 기존 행은 전부 null/1이라 위반할 수 없어 즉시 검증된다.
    check(
      'card_transactions_original_cancelled_amount_check',
      sql`${table.originalCancelledAmount} is null or ${table.originalCancelledAmount} >= 0`,
    ),
    check(
      'card_transactions_money_contract_version_check',
      sql`${table.moneyContractVersion} >= 1`,
    ),
    // ⚠️ v2 금액 계약 불변식(`card_transactions_v2_*` 6종)은 여기 선언하지 않는다.
    //    Drizzle이 NOT VALID를 표현하지 못하는데, 그 6개는 기존 v1 행이 이미 어기고 있어
    //    (ADR-0027 D-1~D-3) 즉시 검증되는 형태로 생성되면 배포가 그 자리에서 멈춘다.
    //    정의는 마이그레이션 `0049`에만 있고, 기존 행 검증(VALIDATE)은 데이터 수리가
    //    끝난 뒤 `0050`이 한다.
  ],
);

/* -------------------------------------------------------------------------- */
/* transactionMoneyRepairLog                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 금액 수리 배치가 한 거래에 가한 조치 (ADR-0027 §데이터 마이그레이션 계획 §3).
 *
 * pgEnum이 아니라 text + CHECK인 이유: 수리 작업(롤아웃 7단계)은 아직 구현되지 않았고,
 * 조치 목록이 늘어날 여지가 있다. `ALTER TYPE ... ADD VALUE`는 같은 트랜잭션에서 곧바로
 * 쓸 수 없어 마이그레이션이 두 개로 갈라진다. CHECK는 한 줄 교체로 끝난다.
 */
export const TRANSACTION_MONEY_REPAIR_ACTIONS = [
  /** 승인-취소 체인을 거래일 스냅샷으로 재계산(D-1). */
  'recalculate_chain',
  /** 저장 통화를 원통화로 승격하고 KRW로 환산(D-3). */
  'normalize_currency',
  /** 떠 있는 취소를 원승인에 연결하고 상계(D-2). */
  'link_cancellation',
  /** 잘못 연결된 취소를 해제하고 승인 잔액 복원. */
  'unlink_cancellation',
  /** 비거래로 확정된 D-4 행 제거. `restoreImage` 필수. */
  'delete',
] as const;

export type TransactionMoneyRepairAction =
  (typeof TRANSACTION_MONEY_REPAIR_ACTIONS)[number];

/**
 * 금액 수리 로그 — 무엇을 왜 바꿨고 어떻게 되돌리는지의 **유일한 근거**
 * (ADR-0027 §데이터 마이그레이션 계획).
 *
 * `transactionId`에 FK를 걸지 않는다. 광고 문자가 거래로 승격된 D-4 행은 사람이 비거래로
 * 확정하면 제거될 수 있는데, FK가 있으면 그 제거가 막히거나(NO ACTION) 로그가 함께
 * 지워진다(CASCADE). 둘 다 최악이다 — **감사 로그는 감사 대상보다 오래 살아야 한다.**
 * `sourceEventId`도 같은 이유로 FK가 없다. `householdId`만 FK를 둔다(가구를 지우려면
 * 어차피 거래부터 지워야 한다).
 *
 * `beforeMoney`/`afterMoney`가 jsonb인 이유: 보호 컬럼이 12개라(→ {@link MONEY_PROTECTED_COLUMNS})
 * 스칼라로 펼치면 24개가 된다. 대신 ADR-0026 무회귀 대조에 실제로 쓰이는 `netAmount`와
 * `currency`만 별도 컬럼으로 승격했다.
 *
 * `netAmountDelta`는 생성 컬럼이다. ADR-0027의 회귀 기준이 "수리 전후 월 합계 차이 =
 * 수리 로그의 행별 delta 합"인데, 조회할 때마다 손으로 계산하면 조회마다 다른 식이 생겨
 * "설명되지 않는 delta 0건"을 증명할 수 없다. 제거(`action='delete'`)는 after가 null이라
 * delta가 `-before`가 된다 — 의도한 부호다.
 *
 * 체크섬이 둘인 이유: `checksumBefore`는 **적용 직전** 대상 행을 다시 읽어 manifest가
 * 낡지 않았는지 보는 값이고(그 사이 새 거래·사용자 수정이 끼어들 수 있다),
 * `checksumAfter`는 **되돌릴 때** 사용자가 그 뒤로 이 거래를 손댔는지 보는 값이다.
 * 하나로 합치면 둘 중 하나를 못 본다. 두 값 모두 {@link transactionMoneyChecksum}으로 만든다.
 *
 * `appliedAt`이 null이면 아직 적용되지 않은 dry-run manifest이고, `after*`는 그때의
 * **계획값**이다. 적용 시점에 대상 행을 다시 읽어 실제값으로 덮어쓴다.
 *
 * ⚠️ 이 테이블은 금액과 (`restoreImage`를 통해) 가맹점명을 담는다. **운영 로그·관측
 * 싱크로 내보내지 마십시오.** ADR-0027은 운영 로그에는 집계 수치만 쓰라고 정한다.
 */
export const transactionMoneyRepairLog = pgTable(
  'transaction_money_repair_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 되돌림 단위. 실패한 배치만 batch id로 역순 복원한다. */
    batchId: uuid('batch_id').notNull(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    /** 대상 거래 id. FK 없음(위 주석 참고) — 제거된 거래도 같은 id로 복원한다. */
    transactionId: uuid('transaction_id').notNull(),
    /** 원문 이벤트 id. FK 없음. 제거 시 이벤트를 `quarantined`로 남기는 근거. */
    sourceEventId: uuid('source_event_id'),
    /** {@link TransactionMoneyRepairAction} 중 하나. */
    action: text('action').$type<TransactionMoneyRepairAction>().notNull(),
    /** ADR-0027 §데이터 마이그레이션 계획 §2의 분류 코드. */
    reason: text('reason').notNull(),
    note: text('note'),
    /** 보호 컬럼 12개의 적용 전 값({@link buildTransactionMoneyImage} 출력). */
    beforeMoney: jsonb('before_money')
      .$type<Record<string, unknown>>()
      .notNull(),
    /** 적용 후(또는 dry-run 계획) 값. 제거면 null. */
    afterMoney: jsonb('after_money').$type<Record<string, unknown>>(),
    netAmountBefore: integer('net_amount_before'),
    netAmountAfter: integer('net_amount_after'),
    currencyBefore: text('currency_before'),
    currencyAfter: text('currency_after'),
    /** 생성 컬럼. 쓰지 마십시오 — DB가 계산한다. */
    netAmountDelta: integer('net_amount_delta').generatedAlwaysAs(
      sql`coalesce("net_amount_after", 0) - coalesce("net_amount_before", 0)`,
    ),
    checksumBefore: text('checksum_before').notNull(),
    checksumAfter: text('checksum_after'),
    /** 제거된 거래의 전체 복원 이미지(거래 행 · 연결 관계 · source event 상태). */
    restoreImage: jsonb('restore_image').$type<Record<string, unknown>>(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** null이면 아직 적용 전(dry-run manifest). */
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    /** 체크섬 불일치 등으로 자동 되돌림을 중단한 사유. 사람이 병합해야 한다. */
    revertBlockedReason: text('revert_blocked_reason'),
  },
  (table) => [
    // 한 배치가 같은 거래를 두 번 기록하면 delta 합이 두 배가 된다.
    unique('transaction_money_repair_log_batch_transaction_unique').on(
      table.batchId,
      table.transactionId,
    ),
    check(
      'transaction_money_repair_log_action_check',
      sql`${table.action} in ('recalculate_chain', 'normalize_currency', 'link_cancellation', 'unlink_cancellation', 'delete')`,
    ),
    // 적용 전 / 제거 적용 / 일반 적용 — 세 상태 외의 조합은 만들 수 없게 한다.
    check(
      'transaction_money_repair_log_lifecycle_check',
      sql`(${table.appliedAt} is null and ${table.checksumAfter} is null and ${table.revertedAt} is null) or (${table.appliedAt} is not null and ${table.action} = 'delete' and ${table.checksumAfter} is null and ${table.restoreImage} is not null) or (${table.appliedAt} is not null and ${table.action} <> 'delete' and ${table.checksumAfter} is not null)`,
    ),
    index('transaction_money_repair_log_batch_id_idx').on(table.batchId),
    index('transaction_money_repair_log_transaction_id_idx').on(
      table.transactionId,
    ),
    index('transaction_money_repair_log_household_id_created_at_idx').on(
      table.householdId,
      table.createdAt,
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

export type FxRateSnapshot = typeof fxRateSnapshots.$inferSelect;
export type NewFxRateSnapshot = typeof fxRateSnapshots.$inferInsert;

export type TransactionMoneyRepairLogEntry =
  typeof transactionMoneyRepairLog.$inferSelect;
export type NewTransactionMoneyRepairLogEntry =
  typeof transactionMoneyRepairLog.$inferInsert;

export type CategoryRecategorizeBatch =
  typeof categoryRecategorizeBatches.$inferSelect;
export type NewCategoryRecategorizeBatch =
  typeof categoryRecategorizeBatches.$inferInsert;
export type CategoryRecategorizeItem =
  typeof categoryRecategorizeItems.$inferSelect;
export type NewCategoryRecategorizeItem =
  typeof categoryRecategorizeItems.$inferInsert;

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
 * 가족 예산. `amount`는 KRW 정수(원)인 월 예산이며, 사용률은 스코프별 선택월
 * 순지출(`sum(netAmount) WHERE transactionType='approval'`, 공개범위 반영) /
 * `amount`로 계산한다(스펙 §1.4). `scopeRefId`는 scopeType이 household면 null,
 * 그 외에는 member/category/card의 id다. `createdBy`는 예산을 생성한 사용자다.
 * 계획만 월별로 고정하며 실지출·달성률은 거래에서 다시 계산한다.
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
    /** Asia/Seoul 회계월의 첫날(`YYYY-MM-01`). 순간이 아니므로 date로 저장한다. */
    effectiveMonth: date('effective_month', { mode: 'string' }).notNull(),
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
    unique('budgets_household_month_scope_ref_unique').on(
      table.householdId,
      table.effectiveMonth,
      table.scopeType,
      table.scopeRefId,
    ),
    // household 스코프는 scopeRefId가 NULL이라 위 UNIQUE가 서로 다른 값으로 취급한다
    // (NULL != NULL). 같은 회계월의 가구 전체 예산이 둘 생기지 않게 월 부분 유니크로 막는다.
    uniqueIndex('budgets_household_month_scope_unique')
      .on(table.householdId, table.effectiveMonth)
      .where(sql`${table.scopeType} = 'household'`),
    index('budgets_household_effective_month_idx').on(
      table.householdId,
      table.effectiveMonth,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (budget)                                                         */
/* -------------------------------------------------------------------------- */

export type Budget = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;

/**
 * 예산 월 복사 멱등 원장. 한 사용자 동작의 재시도는 최초에 생성한 budget ID 집합을
 * 그대로 돌려준다. 계획 행이 나중에 수정·삭제돼도 같은 키로 복사를 다시 만들지 않는다.
 */
export const budgetCopyOperations = pgTable(
  'budget_copy_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    idempotencyKey: uuid('idempotency_key').notNull(),
    sourceMonth: date('source_month', { mode: 'string' }).notNull(),
    targetMonth: date('target_month', { mode: 'string' }).notNull(),
    copiedBudgetIds: jsonb('copied_budget_ids').$type<string[]>().notNull(),
    copiedCount: integer('copied_count').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('budget_copy_ops_household_idempotency_unique').on(
      table.householdId,
      table.idempotencyKey,
    ),
    index('budget_copy_ops_household_target_month_idx').on(
      table.householdId,
      table.targetMonth,
    ),
    check(
      'budget_copy_operations_copied_count_check',
      sql`${table.copiedCount} >= 0`,
    ),
  ],
);

export type BudgetCopyOperation = typeof budgetCopyOperations.$inferSelect;

/**
 * 예산 사용률 임계(80%/100%) 알림 dedupe 상태.
 * (예산, 회계월, 임계)당 1행만 존재 → "임계 최초 돌파 시 1회" 발송을 보장한다.
 */
export const budgetAlertState = pgTable(
  'budget_alert_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    periodMonth: text('period_month').notNull(),
    threshold: integer('threshold').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('budget_alert_state_budget_period_threshold_unique').on(
      table.budgetId,
      table.periodMonth,
      table.threshold,
    ),
  ],
);

export type BudgetAlertState = typeof budgetAlertState.$inferSelect;

/**
 * 범용 알림 dedupe — 스케줄 알림(리마인더/주간요약)이 다중 인스턴스·재시작에도
 * 기간당 1회만 발송되도록 보장한다. dedupeKey 예: `reminder:{userId}:{YYYY-MM-DD}`,
 * `summary:{userId}:{weekStart}`. onConflictDoNothing 삽입 성공 시에만 발송한다.
 */
export const notificationDedupe = pgTable('notification_dedupe', {
  dedupeKey: text('dedupe_key').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type NotificationDedupe = typeof notificationDedupe.$inferSelect;

/**
 * 인앱 알림함 이력 — 발송된 모든 알림(거래·예산·리마인더·요약)을 수신자별로 저장한다.
 * 푸시 선호(무음/최소금액)와 무관하게 수신 대상 전원 저장(푸시를 꺼도 알림함엔 남음).
 * `sourceKey`로 재시도/재승격 중복을 흡수한다((userId, sourceKey) UNIQUE).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    householdId: uuid('household_id').references(() => households.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    deepLink: text('deep_link'),
    sourceKey: text('source_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // 키셋 페이지네이션(userId 스코프, 최신순) 및 안읽음 카운트용.
    index('notifications_user_created_idx').on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    unique('notifications_user_source_key_unique').on(
      table.userId,
      table.sourceKey,
    ),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

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
/* slackImports                                                               */
/* -------------------------------------------------------------------------- */

/** Slack import 처리 상태(0054). 4개로 닫혀 있다. */
export const slackImportStatus = pgEnum('slack_import_status', [
  'queued',
  'processing',
  'completed',
  'failed',
]);

/** 업로드 형식(0054). 기존 단일 JSON 경로와 새 Export ZIP 경로를 **둘 다** 유지한다. */
export const slackImportFormat = pgEnum('slack_import_format', ['json', 'zip']);

/**
 * Slack import 1건의 관찰 가능한 상태(0054).
 *
 * 이 테이블이 없었을 때의 증상: 업로드 응답이 항상 `queued`라 워커에서 실패해도
 * 사용자는 이유를 알 수 없었다. `importId`(= `sourceItemId`)가 사용자가 들고 있는
 * 유일한 손잡이라 그것을 신원으로 삼는다(UNIQUE — 재시도가 행을 늘리지 않는다).
 *
 * BullMQ 잡 상태에 기대지 않는 이유: 잡은 `removeOnComplete`로 사라져 새로고침·앱
 * 재시작 뒤에 상태가 증발한다.
 *
 * ⚠️ `errorCode`는 **안전한 코드**만 담는다. 원문·엔트리 이름·PII 금지(그대로 사용자
 * 화면까지 간다). 자유 텍스트 컬럼을 일부러 만들지 않았다.
 *
 * 건수 컬럼이 nullable인 이유: `completed` 전에는 **모르는 것**이고, "모른다"와
 * "0건"은 다른 사실이다.
 */
export const slackImports = pgTable(
  'slack_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceItemId: uuid('source_item_id')
      .notNull()
      .references(() => sourceItems.id),
    slackWorkspaceId: uuid('slack_workspace_id')
      .notNull()
      .references(() => slackWorkspaces.id),
    status: slackImportStatus('status').notNull().default('queued'),
    format: slackImportFormat('format').notNull(),
    syncMode: text('sync_mode').notNull(),
    /** 업로드된 (압축) 파일 크기. 해제 후 크기는 완료 전에는 알 수 없다. */
    uploadBytes: integer('upload_bytes').notNull().default(0),
    errorCode: text('error_code'),
    attempt: integer('attempt').notNull().default(0),
    channelCount: integer('channel_count'),
    userCount: integer('user_count'),
    messageCount: integer('message_count'),
    createdMessageCount: integer('created_message_count'),
    updatedMessageCount: integer('updated_message_count'),
    deletedMessageCount: integer('deleted_message_count'),
    skippedMessageCount: integer('skipped_message_count'),
    warningCount: integer('warning_count'),
    queuedAt: timestamp('queued_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('slack_imports_source_item_id_unique').on(table.sourceItemId),
    index('slack_imports_workspace_queued_at_idx').on(
      table.slackWorkspaceId,
      table.queuedAt.desc(),
    ),
    index('slack_imports_status_queued_at_idx').on(table.status, table.queuedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* 추론 타입 (workspace & slack)                                              */
/* -------------------------------------------------------------------------- */

export type SlackImport = typeof slackImports.$inferSelect;
export type NewSlackImport = typeof slackImports.$inferInsert;

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
  /**
   * 등록된 장치에서 카드 문자가 N시간 이상 도착하지 않음. 카드 문자는 **재전송이
   * 없어** 자동화가 조용히 멈추면 그 사이 결제가 영구 유실되고 아무도 모른다.
   * 유입 공백 자체가 유일한 감지 신호다.
   */
  'card_sms_collection_gap',
  /**
   * 파싱까지 끝난 이벤트가 거래로 승격되지 않고 임계 시간 이상 멈춤.
   * `card_sms_collection_gap`(유입 자체가 끊김)과 달리 문자는 들어왔고 파싱도
   * 성공했는데 **집계에서만 빠진** 상태로, 사용자 눈에는 결제가 없던 것처럼 보인다.
   * 2026-07-30에 4건(119,693원)이 이 상태로 조용히 누락된 것이 계기다.
   */
  'card_sms_promotion_stalled',
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

export type CardSmsDeclineDismissal =
  typeof cardSmsDeclineDismissals.$inferSelect;
export type NewCardSmsDeclineDismissal =
  typeof cardSmsDeclineDismissals.$inferInsert;

export type ModelCanaryRun = typeof modelCanaryRuns.$inferSelect;
export type NewModelCanaryRun = typeof modelCanaryRuns.$inferInsert;
export type ModelTrafficPolicy = typeof modelTrafficPolicies.$inferSelect;
export type NewModelTrafficPolicy = typeof modelTrafficPolicies.$inferInsert;

/* -------------------------------------------------------------------------- */
/* recurringSeries · recurringSeriesEvidence (C-5 정기 지출 Radar)             */
/* -------------------------------------------------------------------------- */

/**
 * 정기 지출 series의 사용자 상태.
 *
 * - `candidate`: 엔진이 만든 **미확정 후보**. 폐기·재생성 가능한 projection이다.
 * - `confirmed` / `rejected`: 사용자의 판단. **조용히 지우지 않는다.**
 * - `needs_review`: 재계산 결과 근거가 사라졌거나 series가 합쳐/갈라져 기존 판단을
 *   그대로 이어 붙일 수 없는 상태. 시스템이 사용자의 결정을 임의로 폐기하는 대신
 *   "다시 봐 달라"고 남긴다.
 */
export const recurringSeriesStatus = pgEnum('recurring_series_status', [
  'candidate',
  'confirmed',
  'rejected',
  'needs_review',
  /**
   * 사용자가 "해지했어요"라고 **확정한** 상태(금액 레이어 S4).
   *
   * 시스템이 스스로 이 상태로 옮기지 않는다 — 예상일이 지났다는 사실만으로 끄면
   * 사용자 모르게 이번 달 예상 총액이 줄어든다(기획 D4). 유예 경과는 화면이 묻는
   * 근거일 뿐이고, 상태는 답을 받을 때만 바뀐다.
   */
  'ended',
]);

/**
 * 관측된 주기. 6개월 창에서 표본이 확보되는 것만 둔다 —
 * 연 단위 구독은 표본이 1~2회라 결정적으로 판별할 수 없어 후보로 만들지 않는다.
 */
export const recurringCadence = pgEnum('recurring_cadence', [
  'weekly',
  'monthly',
]);

/**
 * 정기 지출 후보/확정 series (C-5).
 *
 * **신원은 이 행의 UUID다.** `(가맹점 문자열, 금액)` 복합키를 쓰지 않는 이유: 별칭
 * merge/unmerge가 과거 거래의 `merchant_normalized`를 바꾸고(P1-16 · merchant.service
 * 백필), P0-10 수리가 금액을 바꾼다. 문자열이나 금액을 신원으로 삼으면 그때마다
 * 사용자의 "정기 결제 맞음" 판단이 통째로 끊긴다. 재계산 시 기존 series와 새 후보는
 * {@link recurringSeriesEvidence}의 **교집합**으로 이어 붙인다.
 *
 * `merchantCanonical`·금액·주기는 전부 **계산 시점의 표시값**이지 신원이 아니다.
 *
 * ⚠️ 이 테이블의 값은 ADR-0027 enforce 전까지 `provisional`이다. `moneyContractVersion`
 * 이 1인 근거 위에서 계산된 금액으로 "다음 달 12,900원이 나갑니다" 같은 예고를 하면
 * 틀린 사실을 확정처럼 말하게 된다. 노출 범위는 코드의 feature flag가 막는다.
 */
export const recurringSeries = pgTable(
  'recurring_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    /**
     * series를 소유한 구성원. 정기 결제는 사람·카드 단위 사건이고, 무엇보다
     * **공개범위가 구성원 기준**이라 여기서 갈라 두어야 타인의 private 거래가 가족
     * 후보로 새지 않는다(P0-6 재발 방지).
     */
    memberId: uuid('member_id')
      .notNull()
      .references(() => householdMembers.id),
    /** 계산 시점의 canonical 가맹점명(정규화 + 별칭). 표시용이며 신원이 아니다. */
    merchantCanonical: text('merchant_canonical').notNull(),
    /** 관측된 금액 범위(minor units). 금액 변동형 구독을 한 series로 묶기 위해 범위로 둔다. */
    amountMin: integer('amount_min').notNull(),
    amountMax: integer('amount_max').notNull(),
    /** 대표 금액(중앙값). 평균이 아닌 이유: 1회의 이상값이 대표값을 끌고 가면 안 된다. */
    amountMedian: integer('amount_median').notNull(),
    currency: text('currency').notNull().default('KRW'),
    /** 관측된 주기의 중앙값(일). */
    intervalDays: integer('interval_days').notNull(),
    cadence: recurringCadence('cadence').notNull(),
    /** 근거 거래 수. {@link recurringSeriesEvidence} 행 수와 같다(계산 시점 기준). */
    occurrenceCount: integer('occurrence_count').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    status: recurringSeriesStatus('status').notNull().default('candidate'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusChangedBy: uuid('status_changed_by').references(() => users.id),
    /**
     * `needs_review`로 넘어간 이유. 어휘: `evidence_lost`(근거가 전부 사라짐) ·
     * `merged`(둘 이상의 확정 series가 한 후보로 합쳐짐) · `split`(하나가 여럿으로 갈라짐).
     * 이유 없이 상태만 바꾸면 사용자에게 무엇을 다시 보라는 것인지 말할 수 없다.
     */
    needsReviewReason: text('needs_review_reason'),
    /** 판별 알고리즘 버전. 규칙이 바뀌면 올려서 과거 결과와 구분한다. */
    /**
     * 다음 결제 예상 시점.
     *
     * **모든 series에 저장하고 노출만 `confirmed`로 제한한다.** 저장을 confirmed로
     * 좁히면 사용자가 확정하는 순간 값이 없어 `decide()`가 다시 계산해야 하는데,
     * 그때의 `now`는 재계산 시점의 `now`와 달라 같은 series가 두 날짜를 갖는다.
     * 저장은 순수 계산이라 무해하고, "후보에 다음 결제를 말하지 않는다"는 요구는
     * 조회 계층에서 지킨다.
     *
     * 저장하는 이유: 목록·홈·예정 알림 **세 곳이 같은 값을 봐야** 한다. 각자
     * 계산하면 요청 시각 차이로 다른 날짜를 말하고, "내일 빠져요"라고 알린 뒤
     * 목록에서 모레로 보이는 사고가 된다. `last_seen_at`·`interval_days`의 순수
     * 함수라 재계산 시점에 확정할 수 있다.
     *
     * 반면 국면(upcoming/due/overdue)은 **조회 시각에 의존**하므로 저장하지 않는다.
     * 저장된 예상일 하나에서 각자 계산하면 값은 자연히 일치한다.
     */
    /**
     * 사용자가 "아니에요, 계속 써요"라고 답한 시각(금액 레이어 S4).
     *
     * `stoppedCandidate`는 시간의 함수라 한 번 true가 되면 결제가 들어올 때까지 계속
     * true다. 답을 받고도 다음 조회에서 또 물으면 그건 답을 무시하는 것이다. 이 시각
     * 뒤 **한 주기가 더 지나야** 다시 묻는다.
     */
    stoppedDismissedAt: timestamp('stopped_dismissed_at', {
      withTimezone: true,
    }),
    nextExpectedAt: timestamp('next_expected_at', { withTimezone: true }),
    /**
     * 예상일의 창 폭(일). `cadence`에서 유도되는 상수지만 함께 저장한다 — 상수를
     * 바꿀 때 과거 예상이 소급 변하면 "8월 24일쯤(±2일)"이라고 보낸 알림이 사후에
     * 다른 말을 한 셈이 된다.
     */
    nextExpectedWindowDays: integer('next_expected_window_days'),
    algorithmVersion: integer('algorithm_version').notNull(),
    /**
     * 이 series가 기대는 금액 계약 버전 — 근거 거래들의 **최솟값**이다.
     * 하나라도 v1 근거가 섞이면 series 전체가 v1 신뢰도라는 뜻이다(ADR-0027).
     */
    moneyContractVersion: integer('money_contract_version').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true })
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
    index('recurring_series_household_id_idx').on(table.householdId),
    index('recurring_series_household_member_idx').on(
      table.householdId,
      table.memberId,
    ),
    index('recurring_series_household_status_idx').on(
      table.householdId,
      table.status,
    ),
    check(
      'recurring_series_amount_band_check',
      sql`${table.amountMin} > 0 and ${table.amountMin} <= ${table.amountMedian} and ${table.amountMedian} <= ${table.amountMax}`,
    ),
    check(
      'recurring_series_interval_days_check',
      sql`${table.intervalDays} > 0`,
    ),
    // 2회는 "반복"의 하한이다. 엔진은 더 보수적으로(서로 다른 달 3회) 요구하지만,
    // DB는 규칙 조정에 따라 흔들리지 않는 최소 정합만 강제한다.
    check(
      'recurring_series_occurrence_count_check',
      sql`${table.occurrenceCount} >= 2`,
    ),
    check(
      'recurring_series_seen_window_check',
      sql`${table.firstSeenAt} <= ${table.lastSeenAt}`,
    ),
    // 상태 이유는 needs_review일 때만 의미가 있다.
    check(
      'recurring_series_needs_review_reason_check',
      sql`${table.needsReviewReason} is null or ${table.status} = 'needs_review'`,
    ),
    // 홈·알림이 "이번 달 남은 정기"를 뽑는 경로(금액 레이어 S1).
    index('recurring_series_next_expected_idx')
      .on(table.householdId, table.nextExpectedAt)
      .where(sql`${table.status} = 'confirmed' and ${table.nextExpectedAt} is not null`),
    // 창 폭 0은 "정확히 그날"이라는 뜻이 되어 기획 D3(범위로 말한다)을 어긴다.
    check(
      'recurring_series_next_window_check',
      sql`${table.nextExpectedWindowDays} is null or ${table.nextExpectedWindowDays} > 0`,
    ),
  ],
);

/**
 * series를 만든 근거 거래 집합.
 *
 * 재계산이 기존 series와 새 후보를 잇는 **유일한 연결선**이다. 문자열·금액이 아니라
 * 거래 ID로 이어야 별칭 merge/unmerge와 P0-10 수리를 견딘다.
 *
 * `transaction_id`에 전역 UNIQUE를 걸지 않는다: `needs_review`가 된 옛 series가
 * 과거 근거를 그대로 들고 있는 동안 새 후보가 같은 거래를 근거로 잡을 수 있는데,
 * UNIQUE를 걸면 그 순간 재계산이 죽는다. 사용자의 판단을 지켜야 하는 쪽이 우선이라
 * "한 거래는 한 series" 는 조회 시점 규약으로 둔다.
 */
export const recurringSeriesEvidence = pgTable(
  'recurring_series_evidence',
  {
    // 복합 PK 대신 대리키 + UNIQUE인 이유: 이 표는 파일 맨 끝에만 덧붙이는 규칙 아래
    // 추가됐고, 복합 PK는 상단 import 블록(`primaryKey`)을 건드려야 한다. 정합성은
    // 아래 UNIQUE가 동일하게 보장한다.
    id: uuid('id').primaryKey().defaultRandom(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => recurringSeries.id, { onDelete: 'cascade' }),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => cardTransactions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('recurring_series_evidence_series_transaction_unique').on(
      table.seriesId,
      table.transactionId,
    ),
    // 교집합 계산은 거래 ID로 역방향 조회한다.
    index('recurring_series_evidence_transaction_id_idx').on(
      table.transactionId,
    ),
  ],
);

export type RecurringSeries = typeof recurringSeries.$inferSelect;
export type NewRecurringSeries = typeof recurringSeries.$inferInsert;
export type RecurringSeriesEvidence =
  typeof recurringSeriesEvidence.$inferSelect;
export type NewRecurringSeriesEvidence =
  typeof recurringSeriesEvidence.$inferInsert;
