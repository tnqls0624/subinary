/**
 * 개인정보 Control Center — 버전된 동의 + 즉시 철회 + 문자 원문 보존 정책(SOO-34).
 *
 * 철회는 새 수집만 멈춘다. 이미 보관된 원문 삭제는 보존 정책이 담당한다.
 * 정책 변경은 미리보기 건수와 실제 삭제 후보가 같을 때만 적용한다.
 */
import {
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';

import {
  CURRENT_HOUSEHOLD_CONSENT_VERSION,
  type PrivacyConsentGrantRequest,
  type PrivacyConsentRevokeResponse,
  type PrivacyOverview,
  type PrivacyRetention,
  type PrivacyRetentionPreviewResponse,
  type PrivacyRetentionUpdateRequest,
  type PrivacyRetentionUpdateResponse,
  type RetentionPolicy,
} from '@family/contracts';
import {
  previewSmsRawPurge,
  purgeSmsRawForHousehold,
  retentionPolicyEffectSummary,
  schema,
  type Db,
  type SmsRetentionPolicy,
} from '@family/database';

import { DB } from '../database/database.constants';
import { DeviceService } from '../devices/device.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import {
  HOUSEHOLD_JOIN_CONSENT,
  currentConsent,
  loadConsentHistory,
  needsRenewal,
  toConsentRecord,
} from './household-consent';
import { HouseholdService } from './household.service';

/** 카드 문자 원문이 파일 저장소에 쌓이는 경로(card-sms-ingest.service.ts와 같은 규칙). */
export function cardSmsObjectKeyPrefix(householdId: string): string {
  return `card-sms/${householdId}/`;
}

@Injectable()
export class HouseholdPrivacyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly householdService: HouseholdService,
    private readonly deviceService: DeviceService,
    private readonly objectStorage: ObjectStorageService,
  ) {}

  /** `GET /v1/households/:id/privacy` — 동의 현황 + 이력 + 보관 현황. */
  async getOverview(
    householdId: string,
    userId: string,
  ): Promise<PrivacyOverview> {
    const membership = await this.householdService.requireMembership(
      householdId,
      userId,
    );
    return this.buildOverview(householdId, userId, membership.id);
  }

  /**
   * 동의(최초·재동의 공통). 새 granted 행을 **추가**한다 — 기존 행을 고쳐 쓰면
   * "언제 동의했다가 언제 철회했는가"를 잃는다.
   */
  async grantConsent(
    householdId: string,
    userId: string,
    input: PrivacyConsentGrantRequest,
  ): Promise<PrivacyOverview> {
    const membership = await this.householdService.requireMembership(
      householdId,
      userId,
    );

    if (input.version !== CURRENT_HOUSEHOLD_CONSENT_VERSION) {
      throw new ConflictException('consent document version is out of date');
    }

    await this.db.transaction(async (tx) => {
      const history = await loadConsentHistory(tx, householdId, userId);
      const current = currentConsent(history);
      if (
        current &&
        current.status === 'granted' &&
        current.consentVersion === CURRENT_HOUSEHOLD_CONSENT_VERSION
      ) {
        return;
      }

      await tx.insert(schema.householdConsents).values({
        householdId,
        userId,
        consentType: HOUSEHOLD_JOIN_CONSENT,
        consentVersion: CURRENT_HOUSEHOLD_CONSENT_VERSION,
        status: 'granted',
      });
    });

    return this.buildOverview(householdId, userId, membership.id);
  }

  /**
   * 철회. 기기를 먼저 끊고 동의를 전이시킨다.
   * 이미 보관된 원문은 지우지 않는다 — 보존 정책이 담당한다.
   */
  async revokeConsent(
    householdId: string,
    userId: string,
  ): Promise<PrivacyConsentRevokeResponse> {
    const membership = await this.householdService.requireMembership(
      householdId,
      userId,
    );

    const myDevices = await this.db
      .select({ id: schema.registeredDevices.id })
      .from(schema.registeredDevices)
      .where(
        and(
          eq(schema.registeredDevices.householdId, householdId),
          eq(schema.registeredDevices.memberId, membership.id),
          eq(schema.registeredDevices.status, 'active'),
        ),
      );

    for (const device of myDevices) {
      await this.deviceService.revokeDevice(userId, device.id);
    }

    await this.db
      .update(schema.householdConsents)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        revokedReason: 'user_request',
      })
      .where(
        and(
          eq(schema.householdConsents.householdId, householdId),
          eq(schema.householdConsents.userId, userId),
          eq(schema.householdConsents.consentType, HOUSEHOLD_JOIN_CONSENT),
          eq(schema.householdConsents.status, 'granted'),
        ),
      );

    return {
      overview: await this.buildOverview(householdId, userId, membership.id),
      revokedDeviceCount: myDevices.length,
    };
  }

  /** 정책 변경 전 영향 미리보기 — purge와 같은 판정 함수. */
  async previewRetention(
    householdId: string,
    userId: string,
    policy: RetentionPolicy,
  ): Promise<PrivacyRetentionPreviewResponse> {
    await this.householdService.requireMembership(householdId, userId);
    const preview = await previewSmsRawPurge(this.db, {
      householdId,
      policy: policy as SmsRetentionPolicy,
    });
    return {
      policy,
      matchingEventCount: preview.matchingEventCount,
      matchingSuppressionCount: preview.matchingSuppressionCount,
      effectSummary: retentionPolicyEffectSummary(policy as SmsRetentionPolicy),
    };
  }

  /**
   * 보존 정책을 저장하고, 이미 조건에 맞는 원문을 즉시 지운다.
   * 미리보기 건수와 다르면 409 — 사람이 다시 확인하게 한다.
   */
  async updateRetention(
    householdId: string,
    userId: string,
    input: PrivacyRetentionUpdateRequest,
  ): Promise<PrivacyRetentionUpdateResponse> {
    const membership = await this.householdService.requireMembership(
      householdId,
      userId,
    );

    const preview = await previewSmsRawPurge(this.db, {
      householdId,
      policy: input.policy as SmsRetentionPolicy,
    });
    if (
      preview.matchingEventCount !== input.expectedEventCount ||
      preview.matchingSuppressionCount !== input.expectedSuppressionCount
    ) {
      throw new ConflictException(
        'retention preview is out of date; request a new preview',
      );
    }

    await this.db
      .update(schema.households)
      .set({
        smsRetentionPolicy: input.policy,
        updatedAt: new Date(),
      })
      .where(eq(schema.households.id, householdId));

    const purge = await purgeSmsRawForHousehold(this.db, {
      householdId,
      policy: input.policy as SmsRetentionPolicy,
      triggeredBy: 'user',
      actorUserId: userId,
      deleteObject: (key) => this.objectStorage.deleteObject(key),
      objectExists: (key) => this.objectStorage.objectExists(key),
    });

    return {
      overview: await this.buildOverview(householdId, userId, membership.id),
      purgedEventCount: purge.purgedEventCount,
      purgedSuppressionCount: purge.purgedSuppressionCount,
      failedEventCount: purge.failedEventCount,
      failedSuppressionCount: purge.failedSuppressionCount,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private async buildOverview(
    householdId: string,
    userId: string,
    memberId: string,
  ): Promise<PrivacyOverview> {
    const history = await loadConsentHistory(this.db, householdId, userId);
    const current = currentConsent(history);

    const [deviceAgg] = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(schema.registeredDevices)
      .where(
        and(
          eq(schema.registeredDevices.householdId, householdId),
          eq(schema.registeredDevices.memberId, memberId),
          eq(schema.registeredDevices.status, 'active'),
        ),
      );

    return {
      householdId,
      currentVersion: CURRENT_HOUSEHOLD_CONSENT_VERSION,
      activeConsent:
        current && current.status === 'granted'
          ? toConsentRecord(current)
          : null,
      needsRenewal: needsRenewal(history),
      history: history.map(toConsentRecord),
      retention: await this.loadRetention(householdId),
      myMemberId: memberId,
      myActiveDeviceCount: Number(deviceAgg?.count ?? 0) || 0,
    };
  }

  /**
   * 지금 남은 원문 사본과 선택한 정책. 건수는 raw_content가 비지 않은 이벤트만 센다.
   */
  private async loadRetention(householdId: string): Promise<PrivacyRetention> {
    const [household] = await this.db
      .select({ policy: schema.households.smsRetentionPolicy })
      .from(schema.households)
      .where(eq(schema.households.id, householdId))
      .limit(1);

    const [events] = await this.db
      .select({
        count: sql<string>`count(*)`,
        oldest: sql<string | null>`min(${schema.cardSmsEvents.receivedAt})`,
        newest: sql<string | null>`max(${schema.cardSmsEvents.receivedAt})`,
      })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.householdId, householdId),
          ne(schema.cardSmsEvents.rawContent, ''),
        ),
      );

    const [bytes] = await this.db
      .select({ total: sql<string | null>`sum(${schema.sourceItems.sizeBytes})` })
      .from(schema.sourceItems)
      .where(
        and(
          eq(schema.sourceItems.householdId, householdId),
          eq(schema.sourceItems.kind, 'card_sms'),
        ),
      );

    const recent = await this.db
      .select({
        id: schema.smsRawPurgeLogs.id,
        policy: schema.smsRawPurgeLogs.policy,
        purgedEventCount: schema.smsRawPurgeLogs.purgedEventCount,
        purgedSuppressionCount: schema.smsRawPurgeLogs.purgedSuppressionCount,
        failedEventCount: schema.smsRawPurgeLogs.failedEventCount,
        failedSuppressionCount: schema.smsRawPurgeLogs.failedSuppressionCount,
        status: schema.smsRawPurgeLogs.status,
        triggeredBy: schema.smsRawPurgeLogs.triggeredBy,
        createdAt: schema.smsRawPurgeLogs.createdAt,
      })
      .from(schema.smsRawPurgeLogs)
      .where(eq(schema.smsRawPurgeLogs.householdId, householdId))
      .orderBy(desc(schema.smsRawPurgeLogs.createdAt))
      .limit(5);

    const policy = (household?.policy ?? 'none') as RetentionPolicy;

    return {
      policy,
      smsEventCount: Number(events?.count ?? 0) || 0,
      storedBytes: Number(bytes?.total ?? 0) || 0,
      oldestReceivedAt: toIso(events?.oldest ?? null),
      newestReceivedAt: toIso(events?.newest ?? null),
      objectKeyPrefix: cardSmsObjectKeyPrefix(householdId),
      recentPurges: recent.map((row) => ({
        id: row.id,
        policy: row.policy as RetentionPolicy,
        purgedEventCount: row.purgedEventCount,
        purgedSuppressionCount: row.purgedSuppressionCount,
        failedEventCount: row.failedEventCount,
        failedSuppressionCount: row.failedSuppressionCount,
        status: row.status,
        triggeredBy: row.triggeredBy,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}

function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
