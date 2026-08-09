/**
 * 동의 상태 판정 — **단일 정의**.
 *
 * 왜 provider(@Injectable)가 아니라 순수 함수인가: 이 판정을 읽는 곳이 두 모듈에
 * 걸쳐 있다. `HouseholdPrivacyService`(Control Center)와 `DeviceService`(기기 등록
 * 차단)인데, household → devices 방향 의존이 이미 있으므로 반대 방향으로 provider를
 * 주입하면 모듈 순환이 된다. 함수 임포트는 순환 없이 정의를 하나로 유지한다.
 *
 * 이 저장소가 반복해서 앓은 병이 "자동 경로만 계약을 구현하고 사람 개입 경로가 각자
 * 구현"이다(금액 4건·visibility 5곳). 동의도 같은 함정이 있다 — "지금 동의가 살아
 * 있는가"를 화면과 가드가 따로 계산하기 시작하면 곧 서로 다른 답을 낸다.
 */
import { and, desc, eq } from 'drizzle-orm';

import {
  CURRENT_HOUSEHOLD_CONSENT_VERSION,
  householdConsentDocuments,
  type HouseholdConsentRecord,
  type HouseholdConsentType,
} from '@family/contracts';
import { schema, type DbExecutor } from '@family/database';

/** 지금 존재하는 유일한 동의 종류. DB `consent_type` 값과 같다. */
export const HOUSEHOLD_JOIN_CONSENT: HouseholdConsentType = 'household_join';

/**
 * (가구, 사용자, 종류)의 **동의 이력 전체**를 최신순으로 읽는다.
 *
 * 정렬 키를 세 개 쓰는 이유: `consentedAt`은 같은 트랜잭션에서 만들어진 행끼리 동률이
 * 될 수 있다(now()는 트랜잭션 시각 고정). 동률이면 `createdAt`, 그래도 동률이면 `id`로
 * 완전 순서를 만든다 — "가장 최근 동의"가 요청마다 흔들리면 화면이 오락가락한다.
 */
export async function loadConsentHistory(
  db: DbExecutor,
  householdId: string,
  userId: string,
  consentType: HouseholdConsentType = HOUSEHOLD_JOIN_CONSENT,
): Promise<schema.HouseholdConsent[]> {
  return db
    .select()
    .from(schema.householdConsents)
    .where(
      and(
        eq(schema.householdConsents.householdId, householdId),
        eq(schema.householdConsents.userId, userId),
        eq(schema.householdConsents.consentType, consentType),
      ),
    )
    .orderBy(
      desc(schema.householdConsents.consentedAt),
      desc(schema.householdConsents.createdAt),
      desc(schema.householdConsents.id),
    );
}

/**
 * 이력에서 현재 상태를 뽑는다: **가장 최근 행이 곧 현재 상태**다.
 *
 * 재동의는 새 granted 행을 추가할 뿐 이전 granted 행을 건드리지 않으므로(개정은
 * "철회"가 아니다 — 철회 이벤트를 지어내면 이력이 거짓말을 한다) granted 행이 여러
 * 개 남을 수 있다. 그래도 "최신 행이 현재"라는 규칙 하나면 상태는 언제나 확정된다.
 * 철회는 살아있는 granted 행을 전부 전이시키므로 철회 후에 granted가 남지 않는다.
 */
export function currentConsent(
  history: readonly schema.HouseholdConsent[],
): schema.HouseholdConsent | null {
  return history[0] ?? null;
}

/**
 * 지금 동의가 살아 있는가.
 *
 * **동의 기록이 아예 없으면 `true`로 본다.** 없음은 "철회"가 아니다 — 마이그레이션
 * 0051 이전 데이터나 앱 밖 쓰기로 행이 비어 있을 때 수집을 조용히 끊으면, 사용자는
 * 자기가 하지 않은 철회 때문에 기기가 막힌다. 화면은 이 경우 `activeConsent: null`을
 * 받아 "동의 기록이 없어요 → 동의하기"를 명시적으로 요청하므로 조용히 넘어가지 않는다.
 */
export function hasActiveConsent(
  history: readonly schema.HouseholdConsent[],
): boolean {
  const current = currentConsent(history);
  return current === null || current.status === 'granted';
}

/** 문구가 개정되어 재동의를 요청해야 하는가(차단이 아니라 안내다). */
export function needsRenewal(
  history: readonly schema.HouseholdConsent[],
): boolean {
  const current = currentConsent(history);
  return (
    current !== null &&
    current.status === 'granted' &&
    current.consentVersion !== CURRENT_HOUSEHOLD_CONSENT_VERSION
  );
}

/** DB 행 → 계약 표현. `documentAvailable`은 원문 추적 가능 여부다. */
export function toConsentRecord(
  row: schema.HouseholdConsent,
): HouseholdConsentRecord {
  return {
    id: row.id,
    consentType: HOUSEHOLD_JOIN_CONSENT,
    version: row.consentVersion,
    status: row.status === 'revoked' ? 'revoked' : 'granted',
    consentedAt: row.consentedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedReason: row.revokedReason,
    // 코드에 원문이 없는 버전이면 화면이 "무엇에 동의했는지"를 보여줄 수 없다.
    // 0051이 이런 행을 막지만, 앱 밖 쓰기로 생길 수 있으므로 화면까지 사실을 전달한다.
    documentAvailable: row.consentVersion in householdConsentDocuments,
  };
}
