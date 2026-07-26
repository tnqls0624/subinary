/**
 * 카드 문자 수집 경로(`CardSmsIngestService.ingest`) 통합 검증.
 *
 * 이 경로는 **장치 인증 뒤**에 있어 배포 후 외부에서 확인할 수 있는 것이 401까지다.
 * 실제로 여기서 두 번 회귀가 났고 둘 다 사용자가 화면에서 먼저 발견했다:
 *  1) `sql` 템플릿에 JS `Date`를 보간해 드라이버 직렬화 실패(수집 전면 500).
 *  2) 계약 enum에 값을 추가했는데 조회 필터의 하드코딩 사본이 안 따라감.
 * 타입체크가 못 잡는 종류라(`sql` 템플릿은 any) 실제 DB에 넣어보는 수밖에 없다.
 *
 * 운영 DB 오실행을 막기 위해 **일회용 검증 DB**와 명시적 쓰기 허용 환경변수를 요구한다
 * (`verify-card-sms-ingest-isolated.mjs`가 생성·폐기까지 감싼다).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import { assertVerificationDatabaseSafety } from './lib/verification-database-guard.mjs';

import { createDbClient, schema } from '../packages/database/dist/index.mjs';

const databaseUrl = process.env.DATABASE_URL;
const { databaseName } = assertVerificationDatabaseSafety({
  databaseUrl,
  allowWrite: process.env.CARD_SMS_VERIFY_ALLOW_WRITE,
  nodeEnv: process.env.NODE_ENV,
});
console.log(`[card-sms] 검증 DB 안전 가드 통과: ${databaseName}`);

const require = createRequire(import.meta.url);
const { eq } = require('../packages/database/node_modules/drizzle-orm');
const {
  CardSmsIngestService,
} = require('../apps/api/dist/card-sms/card-sms-ingest.service.js');

/** MinIO를 건드리지 않는 스텁. 원문 보관은 이 검증의 관심사가 아니다. */
const storageStub = {
  putObject: async () => undefined,
  getObject: async () => Buffer.alloc(0),
};

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// 시그니처는 (databaseUrl, opts) 위치 인자다. 반환은 { db, client } — close가 아니라
// client.end()로 풀을 닫는다.
const { db, client } = createDbClient(databaseUrl);

try {
  // --- 시드: 사용자 → 가족 → 구성원 → 장치 ---------------------------------
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `verify-${randomUUID()}@invalid`,
      passwordHash: 'x'.repeat(32),
      name: '검증 사용자',
    })
    .returning();
  const [household] = await db
    .insert(schema.households)
    .values({ name: '검증 가족', createdBy: user.id })
    .returning();
  const [member] = await db
    .insert(schema.householdMembers)
    .values({
      householdId: household.id,
      userId: user.id,
      role: 'owner',
      status: 'active',
    })
    .returning();
  const [device] = await db
    .insert(schema.registeredDevices)
    .values({
      householdId: household.id,
      memberId: member.id,
      name: '검증 장치',
      platform: 'android',
      createdBy: user.id,
    })
    .returning();

  check('시드 장치는 수집 이력이 비어 있다', () => {
    assert.equal(device.firstEventAt, null);
    assert.equal(device.lastEventAt, null);
  });

  const service = new CardSmsIngestService(db, storageStub);
  const deviceContext = {
    deviceId: device.id,
    householdId: household.id,
    memberId: member.id,
  };
  const readDevice = async () => {
    const [row] = await db
      .select()
      .from(schema.registeredDevices)
      .where(eq(schema.registeredDevices.id, device.id))
      .limit(1);
    return row;
  };

  // --- ① 최초 수집 ---------------------------------------------------------
  const firstReceivedAt = new Date('2026-07-20T05:32:00.000Z');
  const first = await service.ingest(deviceContext, {
    eventId: 'verify-event-1',
    sender: '15881688',
    content: '[Web발신]\n삼성2승인 이*빈\n1,169원 일시불\n07/20 14:32 영등포구청',
    receivedAt: firstReceivedAt.toISOString(),
  });

  check('최초 수집은 queued 로 수락된다', () => {
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.processingStatus, 'queued');
  });

  const [storedEvent] = await db
    .select()
    .from(schema.cardSmsEvents)
    .where(eq(schema.cardSmsEvents.eventId, 'verify-event-1'))
    .limit(1);
  check('card_sms_events 행이 pending 으로 생성된다', () => {
    assert.ok(storedEvent, 'event row missing');
    assert.equal(storedEvent.parseStatus, 'pending');
    assert.equal(storedEvent.householdId, household.id);
  });

  // 여기가 실제 회귀 지점이다 — sql 템플릿에 Date를 보간하면 이 호출 자체가 던진다.
  const afterFirst = await readDevice();
  check('수집이 firstEventAt/lastEventAt 을 채운다 (회귀 지점)', () => {
    assert.equal(afterFirst.firstEventAt?.getTime(), firstReceivedAt.getTime());
    assert.equal(afterFirst.lastEventAt?.getTime(), firstReceivedAt.getTime());
  });

  // --- ② 같은 eventId 재전송(멱등) ----------------------------------------
  const duplicate = await service.ingest(deviceContext, {
    eventId: 'verify-event-1',
    sender: '15881688',
    content: '[Web발신]\n삼성2승인 이*빈\n1,169원 일시불\n07/20 14:32 영등포구청',
    receivedAt: firstReceivedAt.toISOString(),
  });
  check('같은 eventId 재전송은 duplicate 로 흡수된다', () => {
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.processingStatus, 'duplicate');
  });

  // --- ③ 다음 수집 — coalesce 의미 검증 ------------------------------------
  const laterReceivedAt = new Date('2026-07-21T00:05:00.000Z');
  await service.ingest(deviceContext, {
    eventId: 'verify-event-2',
    sender: '15881688',
    content: '[Web발신]\n삼성2승인 이*빈\n8,900원 일시불\n07/21 09:05 커피온리샛강역사',
    receivedAt: laterReceivedAt.toISOString(),
  });
  const afterSecond = await readDevice();
  check('firstEventAt 은 최초 값을 유지한다(coalesce)', () => {
    assert.equal(afterSecond.firstEventAt?.getTime(), firstReceivedAt.getTime());
  });
  check('lastEventAt 은 최신 수집으로 갱신된다', () => {
    assert.equal(afterSecond.lastEventAt?.getTime(), laterReceivedAt.getTime());
  });

  // --- ④ receivedAt 생략(자동화 도구 경로) --------------------------------
  const before = Date.now();
  await service.ingest(deviceContext, {
    eventId: 'verify-event-3',
    sender: '15881688',
    content: '[Web발신]\n삼성2승인 이*빈\n3,000원 일시불\n07/22 11:11 쿠팡',
  });
  const afterThird = await readDevice();
  check('receivedAt 생략 시 서버 시각으로 lastEventAt 이 갱신된다', () => {
    assert.ok(
      afterThird.lastEventAt.getTime() >= before,
      'lastEventAt should advance to server now()',
    );
  });

  console.log(`\n[card-sms] 통과 ${passed}/${passed}`);
} finally {
  await client.end({ timeout: 5 });
}
