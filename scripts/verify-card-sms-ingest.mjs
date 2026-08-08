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
import { createHash, randomUUID } from 'node:crypto';

import { assertVerificationDatabaseSafety } from './lib/verification-database-guard.mjs';

import {
  CARD_SMS_DEDUPE_WINDOW_MS,
  createDbClient,
  schema,
} from '../packages/database/dist/index.mjs';

const databaseUrl = process.env.DATABASE_URL;
const { databaseName } = assertVerificationDatabaseSafety({
  databaseUrl,
  allowWrite: process.env.CARD_SMS_VERIFY_ALLOW_WRITE,
  nodeEnv: process.env.NODE_ENV,
});
console.log(`[card-sms] 검증 DB 안전 가드 통과: ${databaseName}`);

const require = createRequire(import.meta.url);
const { and, eq } = require('../packages/database/node_modules/drizzle-orm');
const {
  CardSmsIngestService,
} = require('../apps/api/dist/card-sms/card-sms-ingest.service.js');

/** MinIO를 건드리지 않는 스텁. 원문 보관은 이 검증의 관심사가 아니다. */
const storageStub = {
  putObject: async () => undefined,
  getObject: async () => Buffer.alloc(0),
};

let passed = 0;
/**
 * 검사 하나를 실행하고 통과 수를 센다. **비동기 콜백을 반드시 await 한다** — 안 그러면
 * 콜백 안의 assert 실패가 unhandled rejection이 되어 검증이 "통과"로 끝난다.
 *
 * @param {string} label
 * @param {() => void | Promise<void>} fn
 */
async function check(label, fn) {
  await fn();
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

  await check('시드 장치는 수집 이력이 비어 있다', () => {
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

  await check('최초 수집은 queued 로 수락된다', () => {
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.processingStatus, 'queued');
  });

  const [storedEvent] = await db
    .select()
    .from(schema.cardSmsEvents)
    .where(eq(schema.cardSmsEvents.eventId, 'verify-event-1'))
    .limit(1);
  await check('card_sms_events 행이 pending 으로 생성된다', () => {
    assert.ok(storedEvent, 'event row missing');
    assert.equal(storedEvent.parseStatus, 'pending');
    assert.equal(storedEvent.householdId, household.id);
  });

  // 여기가 실제 회귀 지점이다 — sql 템플릿에 Date를 보간하면 이 호출 자체가 던진다.
  const afterFirst = await readDevice();
  await check('수집이 firstEventAt/lastEventAt 을 채운다 (회귀 지점)', () => {
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
  await check('같은 eventId 재전송은 duplicate 로 흡수된다', () => {
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
  await check('firstEventAt 은 최초 값을 유지한다(coalesce)', () => {
    assert.equal(afterSecond.firstEventAt?.getTime(), firstReceivedAt.getTime());
  });
  await check('lastEventAt 은 최신 수집으로 갱신된다', () => {
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
  await check('receivedAt 생략 시 서버 시각으로 lastEventAt 이 갱신된다', () => {
    assert.ok(
      afterThird.lastEventAt.getTime() >= before,
      'lastEventAt should advance to server now()',
    );
  });

  // --- ⑤ P0-9: 멱등 키 출처 기록 ------------------------------------------
  // 키 있는 수집 / 키 없는 수집을 셀 수 없으면 "언제 eventId를 필수화해도 되는가"를
  // 영원히 판단할 수 없다. 그 근거가 실제로 저장되는지 본다.
  await check('호출자가 준 키로 들어온 이벤트는 key_source=client 로 기록된다', () => {
    assert.equal(storedEvent.keySource, 'client');
  });

  const countEvents = async (deviceId, contentHash) => {
    const rows = await db
      .select({ id: schema.cardSmsEvents.id })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.deviceId, deviceId),
          eq(schema.cardSmsEvents.contentHash, contentHash),
        ),
      );
    return rows.length;
  };
  const readSuppressions = async (deviceId, contentHash) =>
    db
      .select()
      .from(schema.cardSmsIngestSuppressions)
      .where(
        and(
          eq(schema.cardSmsIngestSuppressions.deviceId, deviceId),
          eq(schema.cardSmsIngestSuppressions.contentHash, contentHash),
        ),
      );

  // --- ⑥ P0-9 (a): 같은 이벤트의 재시도는 여전히 하나다 --------------------
  // 창을 좁힌 대가로 재시도가 중복 거래를 만들면 이 작업은 실패다. 창 **경계**를
  // 사이에 두고 갈라지는 재시도가 가장 위험하다 — 키가 달라져 UNIQUE로는 안 잡힌다.
  const flatSender = '15881688';
  const flatContent = '카드 승인 5,000원 가맹점';
  const flatHash = createHash('sha256')
    .update(`${flatSender}\n${flatContent}`, 'utf8')
    .digest('hex');

  // 다음 창의 시작점. 이 값을 기준으로 "경계 직전 / 경계 직후"를 만들어 창 경계에서
  // 갈라지는 재시도(키가 달라져 UNIQUE로는 안 잡히는 경우)를 실제로 재현한다.
  const windowStart =
    (Math.floor(Date.now() / CARD_SMS_DEDUPE_WINDOW_MS) + 1) *
    CARD_SMS_DEDUPE_WINDOW_MS;
  const retryFirst = await service.ingest(deviceContext, {
    sender: flatSender,
    content: flatContent,
    ingestedAt: new Date(windowStart - 1_000),
  });
  const retrySecond = await service.ingest(deviceContext, {
    sender: flatSender,
    content: flatContent,
    ingestedAt: new Date(windowStart + 1_000),
  });

  await check('(a) 창 경계를 넘긴 재시도도 중복으로 흡수된다 (지문 + 슬라이딩 창)', () => {
    assert.equal(retryFirst.duplicate, false);
    assert.equal(retrySecond.duplicate, true);
    assert.equal(retrySecond.processingStatus, 'duplicate');
  });
  await check('(a) 중복 응답의 eventId는 흡수된 실제 이벤트의 키다 (조회 가능해야 한다)', () => {
    // 새로 파생한 키를 돌려주면 호출자가 그 값으로 아무것도 못 찾는다
    // (manual-text는 이 값으로 card_sms_events를 조회한다).
    assert.equal(retrySecond.eventId, retryFirst.eventId);
  });
  await check('(a) 재시도가 이벤트를 늘리지 않았다', async () => {
    assert.equal(await countEvents(device.id, flatHash), 1);
  });

  // --- ⑦ P0-9 (d): 키 없는 경로의 중복은 원문을 남긴다 ---------------------
  const suppressed = await readSuppressions(device.id, flatHash);
  await check('(d) 중복 판정된 문자의 원문이 보관된다 (복구할 근거)', () => {
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0].rawContent, flatContent);
    assert.equal(suppressed[0].sender, flatSender);
    assert.equal(suppressed[0].reason, 'fingerprint_window');
    assert.equal(suppressed[0].keySource, 'derived_window');
    assert.ok(suppressed[0].matchedEventId, '흡수 대상 이벤트가 연결되지 않았다');
  });

  const retryThird = await service.ingest(deviceContext, {
    sender: flatSender,
    content: flatContent,
    ingestedAt: new Date(windowStart + 2_000),
  });
  const suppressedAgain = await readSuppressions(device.id, flatHash);
  await check('(d) 반복 재시도는 행을 늘리지 않고 attempts만 센다', () => {
    assert.equal(retryThird.duplicate, true);
    assert.equal(suppressedAgain.length, 1);
    assert.equal(suppressedAgain[0].attempts, 2);
  });

  // --- ⑧ P0-9 (b): 창을 넘긴 동일 본문 별개 결제는 이벤트 2건 -------------
  // 이 작업의 핵심 수정. 예전 규칙에서는 두 번째가 **영구히** 버려졌다.
  await service.ingest(deviceContext, {
    sender: flatSender,
    content: flatContent,
    ingestedAt: new Date(windowStart + CARD_SMS_DEDUPE_WINDOW_MS + 5_000),
  });
  await check('(b) 타임스탬프 없는 동일 본문 별개 결제 2건 → 이벤트 2건', async () => {
    assert.equal(await countEvents(device.id, flatHash), 2);
  });

  // --- ⑨ P0-9 (c): 키 있는 경로는 창에 갇히지 않는다 ----------------------
  // 호출자가 "이 둘은 다른 이벤트"라고 말했으면 서버가 창으로 뒤집으면 안 된다.
  const keyedSender = '15881688';
  const keyedContent = '카드 승인 7,700원 같은가맹점';
  const keyedAt = new Date(windowStart + 10_000);
  await service.ingest(deviceContext, {
    eventId: 'p0-9-keyed-a',
    sender: keyedSender,
    content: keyedContent,
    ingestedAt: keyedAt,
  });
  const keyedB = await service.ingest(deviceContext, {
    eventId: 'p0-9-keyed-b',
    sender: keyedSender,
    content: keyedContent,
    ingestedAt: new Date(keyedAt.getTime() + 1_000),
  });
  const keyedHash = createHash('sha256')
    .update(`${keyedSender}\n${keyedContent}`, 'utf8')
    .digest('hex');
  await check('(c) 키가 다르면 같은 문자·같은 창이어도 별개 이벤트다', async () => {
    assert.equal(keyedB.duplicate, false);
    assert.equal(keyedB.idempotencySource, 'client');
    assert.equal(await countEvents(device.id, keyedHash), 2);
  });

  const keyedRetry = await service.ingest(deviceContext, {
    eventId: 'p0-9-keyed-a',
    sender: keyedSender,
    content: keyedContent,
    ingestedAt: new Date(keyedAt.getTime() + 2_000),
  });
  const keyedSuppressed = await readSuppressions(device.id, keyedHash);
  await check('(c) 같은 키의 재전송은 duplicate + 원문 보관', () => {
    assert.equal(keyedRetry.duplicate, true);
    assert.equal(keyedRetry.eventId, 'p0-9-keyed-a');
    assert.equal(keyedSuppressed.length, 1);
    assert.equal(keyedSuppressed[0].reason, 'event_id_conflict');
    assert.equal(keyedSuppressed[0].keySource, 'client');
  });

  // --- ⑩ P0-9: 수신 시각만 준 경로 ----------------------------------------
  const tsSender = '15881688';
  const tsContent = '카드 승인 3,300원 시각있음';
  const tsAt = new Date(windowStart + 20_000);
  const tsFirst = await service.ingest(deviceContext, {
    sender: tsSender,
    content: tsContent,
    receivedAt: tsAt.toISOString(),
  });
  const tsSecond = await service.ingest(deviceContext, {
    sender: tsSender,
    content: tsContent,
    receivedAt: new Date(tsAt.getTime() + 15_000).toISOString(),
  });
  await check('수신 시각이 다르면 같은 창 안이어도 별개 이벤트다', () => {
    assert.equal(tsFirst.idempotencySource, 'derived_received_at');
    assert.equal(tsSecond.duplicate, false);
  });
  const tsRetry = await service.ingest(deviceContext, {
    sender: tsSender,
    content: tsContent,
    receivedAt: tsAt.toISOString(),
  });
  await check('같은 수신 시각의 재전송은 duplicate 다 (멱등 유지)', () => {
    assert.equal(tsRetry.duplicate, true);
  });

  console.log(`\n[card-sms] 통과 ${passed}/${passed}`);
} finally {
  await client.end({ timeout: 5 });
}
