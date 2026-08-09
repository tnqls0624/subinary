/**
 * 개인정보 Control Center — 버전된 동의 + 즉시 철회 (C-3 **1단계**).
 *
 * 이 서비스가 하지 **않는** 것을 먼저 적는다. 원문 purge·보존기간 선택·데이터 내보내기는
 * 여기 없다(로드맵 5-1에서 보류). 지금 원문을 실제로 지우는 잡이 존재하지 않으므로
 * "N일 뒤 삭제" 같은 값을 계산해 내보내는 순간 서비스가 지키지 못할 약속을 하게 된다.
 * 보관 현황은 **읽기 전용 집계**로만 나간다.
 *
 * 철회가 실제로 수집을 멈추는 방식:
 *   1) 내 활성 기기를 전부 폐기한다 — **기존 초크포인트** {@link DeviceService.revokeDevice}
 *      를 그대로 통과시킨다. 여기서 UPDATE를 새로 짜면 이 저장소가 이미 네 번 겪은
 *      "사람 개입 경로가 자동 경로의 계약을 재구현" 사고를 하나 더 만드는 것이다.
 *   2) 그 다음 동의 행을 revoked로 전이시킨다.
 *   3) 이후 새 기기 등록은 {@link DeviceService.registerDevice}가 막는다(같은 판정 함수).
 *
 * **순서가 뒤집히면 안 된다.** 동의를 먼저 끊고 기기 폐기가 실패하면 "철회했는데 계속
 * 수집됨"이 되어 P0-2와 같은 사고가 된다. 기기부터 끊으면 최악의 중간 상태가 "수집은
 * 멈췄는데 동의 표시가 아직 살아 있음"이라 사용자 피해가 없고 재시도로 수렴한다.
 */
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  CURRENT_HOUSEHOLD_CONSENT_VERSION,
  type PrivacyConsentGrantRequest,
  type PrivacyConsentRevokeResponse,
  type PrivacyOverview,
  type PrivacyRetention,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';
import { DeviceService } from '../devices/device.service';
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
   *
   * 이미 현재 버전으로 동의가 살아 있으면 아무것도 쓰지 않는다(멱등). 그렇지 않으면
   * 새 행 하나가 늘어난다. 재동의는 이전 granted 행을 revoked로 바꾸지 않는다 —
   * 문구 개정은 철회 사건이 아니고, 없던 철회를 기록하면 이력이 거짓말을 한다.
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

    // 클라이언트가 **자기가 실제로 보여준 문구 버전**을 실어 보낸다. 캐시된 옛 화면이
    // v1 문구를 띄우고 서버는 v2로 기록하는 어긋남이 여기서 409로 잘린다.
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
   * 철회. 기기를 먼저 끊고 동의를 전이시킨다(상단 주석의 순서 근거).
   *
   * 되돌릴 수 있다 — 재동의({@link grantConsent}) 후 기기를 다시 등록하면 수집이
   * 재개된다. 되돌릴 수 없으면 사용자는 무서워서 이 버튼을 못 누른다.
   */
  async revokeConsent(
    householdId: string,
    userId: string,
  ): Promise<PrivacyConsentRevokeResponse> {
    const membership = await this.householdService.requireMembership(
      householdId,
      userId,
    );

    // (1) 내 활성 기기 → 기존 revoke 초크포인트를 그대로 통과시킨다.
    //     대상은 **내 기기만**이다. 가족 다른 사람의 수집까지 끊는 것은 내 동의 철회의
    //     범위가 아니다(그건 가족 그룹 삭제이고 보류 항목이다).
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

    // (2) 살아있는 granted 행을 **전부** 전이시킨다. 하나만 고치면 나갔다 재합류로
    //     생긴 옛 granted 행이 남아 "철회했는데 동의가 살아 있음"이 된다.
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
   * "지금 무엇이 얼마나 보관되어 있는가" — **읽기 전용 사실만**.
   *
   * 원문이 남는 자리는 두 곳이고 둘 다 실제 코드에서 확인한 경로다
   * (`card-sms-ingest.service.ts`): DB `card_sms_events.raw_content`, 그리고 파일
   * 저장소의 `card-sms/{householdId}/{eventId}.txt`. 바이트 집계는 `source_items`의
   * `size_bytes`(업로드한 원문 바이트 수)를 쓴다 — 파일 저장소를 매 요청 스캔하지
   * 않고도 같은 값을 알 수 있고, MinIO 쓰기가 실패한 건은 애초에 집계에 넣으면
   * 안 되는데 그 실패는 best-effort라 DB 쪽 행 수와 어긋날 수 있어 각각 별도로 낸다.
   */
  private async loadRetention(householdId: string): Promise<PrivacyRetention> {
    const [events] = await this.db
      .select({
        count: sql<string>`count(*)`,
        oldest: sql<string | null>`min(${schema.cardSmsEvents.receivedAt})`,
        newest: sql<string | null>`max(${schema.cardSmsEvents.receivedAt})`,
      })
      .from(schema.cardSmsEvents)
      .where(eq(schema.cardSmsEvents.householdId, householdId));

    const [bytes] = await this.db
      .select({ total: sql<string | null>`sum(${schema.sourceItems.sizeBytes})` })
      .from(schema.sourceItems)
      .where(
        and(
          eq(schema.sourceItems.householdId, householdId),
          eq(schema.sourceItems.kind, 'card_sms'),
        ),
      );

    return {
      // purge 잡이 없으므로 정책은 'none' 하나뿐이다. 계약의 열거형이 값 하나라
      // 화면이 삭제 시점을 지어낼 수 있는 통로 자체가 없다.
      policy: 'none',
      smsEventCount: Number(events?.count ?? 0) || 0,
      storedBytes: Number(bytes?.total ?? 0) || 0,
      oldestReceivedAt: toIso(events?.oldest ?? null),
      newestReceivedAt: toIso(events?.newest ?? null),
      objectKeyPrefix: cardSmsObjectKeyPrefix(householdId),
    };
  }
}

/**
 * 집계 함수가 돌려주는 시각을 ISO 문자열로 맞춘다.
 *
 * `min()`/`max()`는 드리즐의 컬럼 타입 매퍼를 타지 않아 드라이버 설정에 따라 Date가
 * 오기도 하고 문자열이 오기도 한다. 화면 계약은 ISO 문자열 하나뿐이므로 여기서 흡수한다.
 */
function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
