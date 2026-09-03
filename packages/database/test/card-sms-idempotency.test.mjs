/**
 * 카드 문자 멱등 키 규칙(P0-9) 회귀 테스트.
 *
 * 왜 여기서 테스트하는가: 이 함수의 출력이 곧 `card_sms_events.event_id`이고, 그 값이
 * 같으냐 다르냐가 **결제 한 건이 지출에 잡히느냐 사라지느냐**를 결정한다. 규칙이
 * 조용히 바뀌면 아무것도 실패하지 않은 채 거래가 없어지거나 두 배가 된다. DB는 필요 없다.
 *
 * 특히 §"배포 안전"은 지워지면 안 된다 — 파생 recipe가 한 바이트라도 달라지면 **이미
 * 배포된 자동화의 재전송이 전부 새 이벤트가 되어** 배포 직후 거래가 두 배로 쌓인다.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  CARD_SMS_DEDUPE_WINDOW_MS,
  CARD_SMS_FINGERPRINT_WINDOW_MS,
  CARD_SMS_KEY_SOURCES,
  CARD_SMS_SUPPRESSION_REASONS,
  cardSmsContentCarriesTimestamp,
  cardSmsContentHash,
  cardSmsDedupeWindowLowerBound,
  cardSmsDedupeWindowStart,
  deriveCardSmsEventId,
  isDerivedCardSmsKey,
  resolveCardSmsIdempotency,
} from '../dist/index.mjs';

/** P0-9가 지목한 최악의 문자 — 타임스탬프가 없어 두 결제가 바이트 단위로 같아진다. */
const SENDER = '15881688';
const CONTENT = '카드 승인 5,000원 가맹점';

/** @param {Partial<Record<string, unknown>>} [overrides] */
function resolve(overrides = {}) {
  return resolveCardSmsIdempotency({
    sender: SENDER,
    content: CONTENT,
    ingestedAt: new Date('2026-08-08T12:00:00.000Z'),
    ...overrides,
  });
}

describe('멱등 키 사다리 — 호출자가 준 키가 최우선', () => {
  it('(c) eventId를 주면 그 값을 그대로 쓰고 client로 센다', () => {
    const result = resolve({ eventId: 'sms-42' });
    assert.equal(result.eventId, 'sms-42');
    assert.equal(result.keySource, 'client');
  });

  it('(c) 키가 있으면 서버가 창을 덧씌우지 않는다', () => {
    // 호출자가 이미 "이 둘은 다른 이벤트"라고 말했는데 창으로 묶으면 그 말을 뒤집는다.
    assert.equal(resolve({ eventId: 'sms-42' }).windowLowerBound, null);
  });

  it('공백뿐인 eventId는 없는 것으로 본다 (자동화가 빈 변수를 그대로 보낸다)', () => {
    const result = resolve({ eventId: '   ' });
    assert.notEqual(result.keySource, 'client');
  });

  it('(a) 같은 키의 재전송은 같은 키로 해소된다 — 수신 시각이 달라도', () => {
    const first = resolve({ eventId: 'sms-42' });
    const retry = resolve({
      eventId: 'sms-42',
      ingestedAt: new Date('2026-08-08T18:00:00.000Z'),
    });
    assert.equal(first.eventId, retry.eventId);
  });
});

describe('멱등 키 사다리 — 수신 시각이 있으면 그것을 시간 축으로 쓴다', () => {
  it('receivedAt이 있으면 derived_received_at이고 창을 씌우지 않는다', () => {
    const result = resolve({ receivedAt: '2026-08-08T11:59:30.000Z' });
    assert.equal(result.keySource, 'derived_received_at');
    assert.equal(result.windowLowerBound, null);
  });

  it('(a) 같은 receivedAt의 재전송은 같은 키다 (멱등 유지)', () => {
    const at = '2026-08-08T11:59:30.000Z';
    assert.equal(
      resolve({ receivedAt: at }).eventId,
      resolve({
        receivedAt: at,
        ingestedAt: new Date('2026-08-08T12:30:00.000Z'),
      }).eventId,
    );
  });

  it('초 단위로 다른 두 결제는 다른 키다 (같은 분이어도)', () => {
    assert.notEqual(
      resolve({ receivedAt: '2026-08-08T11:59:30.000Z' }).eventId,
      resolve({ receivedAt: '2026-08-08T11:59:45.000Z' }).eventId,
    );
  });

  it('card-sms-text의 자유 형식 헤더도 같은 등급의 시간 축이다', () => {
    // X-Received-At은 ISO가 아닐 수 있어 계약 필드로는 못 받지만, 같은 문자의 재전송이면
    // 같은 문자열이 오므로 해시 재료로서는 receivedAt과 차이가 없다.
    const result = resolve({ receivedAtTag: '2026-08-08 20:59:30' });
    assert.equal(result.keySource, 'derived_received_at');
    assert.equal(result.windowLowerBound, null);
  });
});

describe('멱등 키 사다리 — 아무것도 없으면 서버가 창으로 추측한다 (P0-9의 버그 지점)', () => {
  it('키도 시각도 없으면 derived_window이고 창 하한이 함께 온다', () => {
    const result = resolve();
    assert.equal(result.keySource, 'derived_window');
    assert.ok(result.windowLowerBound instanceof Date);
    assert.equal(
      result.windowLowerBound.getTime(),
      new Date('2026-08-08T12:00:00.000Z').getTime() - CARD_SMS_DEDUPE_WINDOW_MS,
    );
  });

  it('(a) 같은 창 안의 재시도는 같은 키다 — UNIQUE가 DB에서 흡수한다', () => {
    const first = resolve({ ingestedAt: new Date('2026-08-08T12:00:01.000Z') });
    const retry = resolve({ ingestedAt: new Date('2026-08-08T12:00:59.000Z') });
    assert.equal(first.eventId, retry.eventId);
  });

  it('(b) 창을 넘긴 동일 본문은 별개 키다 — 이게 이 작업의 핵심 수정이다', () => {
    // 예전 규칙(sha256(sender+content))에서는 이 둘이 **영구히** 같은 키였고, 두 번째
    // 결제는 흔적도 없이 사라졌다.
    const first = resolve({ ingestedAt: new Date('2026-08-08T12:00:00.000Z') });
    const later = resolve({
      ingestedAt: new Date(
        new Date('2026-08-08T12:00:00.000Z').getTime() + CARD_SMS_DEDUPE_WINDOW_MS,
      ),
    });
    assert.notEqual(first.eventId, later.eventId);
  });

  it('창은 epoch 기준으로 바닥 정렬된다 (서버가 여러 대여도 같은 창을 본다)', () => {
    const start = cardSmsDedupeWindowStart(new Date('2026-08-08T12:04:59.999Z'));
    assert.equal(start.getTime() % CARD_SMS_DEDUPE_WINDOW_MS, 0);
    assert.ok(start.getTime() <= new Date('2026-08-08T12:04:59.999Z').getTime());
    assert.ok(
      start.getTime() >
        new Date('2026-08-08T12:04:59.999Z').getTime() - CARD_SMS_DEDUPE_WINDOW_MS,
    );
  });

  it('창 하한은 정렬 지점이 아니라 수신 시각에서 뺀 값이다', () => {
    // 경계 직후에 들어온 재시도가 "창이 방금 갈렸다"는 이유로 별개가 되면 안 된다.
    // 하한이 슬라이딩이라야 그 구멍을 지문 조회가 메운다.
    const at = new Date('2026-08-08T12:00:01.000Z');
    assert.equal(
      cardSmsDedupeWindowLowerBound(at).getTime(),
      at.getTime() - CARD_SMS_DEDUPE_WINDOW_MS,
    );
  });

  it('창 크기는 3분이다 — 바꾸려면 이 테스트와 파일 상단의 근거를 함께 고쳐야 한다', () => {
    // 좁히면 재시도가 중복 거래를 만들고, 넓히면 진짜 결제 소실이 그만큼 남는다.
    // 숫자만 조용히 바뀌는 것을 막기 위해 값 자체를 고정한다.
    assert.equal(CARD_SMS_DEDUPE_WINDOW_MS, 180_000);
  });
});

describe('경로 구분이 흐려지지 않는다', () => {
  it('세 갈래는 서로 다른 키를 낸다 (같은 문자·같은 순간이어도)', () => {
    const ingestedAt = new Date('2026-08-08T12:00:00.000Z');
    const keys = new Set([
      resolve({ eventId: 'sms-42', ingestedAt }).eventId,
      resolve({ receivedAt: '2026-08-08T12:00:00.000Z', ingestedAt }).eventId,
      resolve({ ingestedAt }).eventId,
    ]);
    // 창 시작점 ISO와 클라이언트 receivedAt ISO가 같은 문자열이 되는 순간이 실제로
    // 존재한다(정각). `w:` 접두사가 없으면 여기서 두 경로가 같은 키가 된다.
    assert.equal(keys.size, 3);
  });

  it('파생 경로 판별은 client 여부 하나로 갈린다', () => {
    assert.equal(isDerivedCardSmsKey('client'), false);
    assert.equal(isDerivedCardSmsKey('derived_received_at'), true);
    assert.equal(isDerivedCardSmsKey('derived_window'), true);
  });

  it('키 출처·판정 사유 목록은 DB CHECK와 같은 값이어야 한다', () => {
    // 한쪽만 늘면 오타 난 값이 조용히 들어오거나 정상 값이 거부된다.
    assert.deepEqual(
      [...CARD_SMS_KEY_SOURCES],
      ['client', 'derived_received_at', 'derived_window'],
    );
    assert.deepEqual(
      [...CARD_SMS_SUPPRESSION_REASONS],
      ['event_id_conflict', 'fingerprint_window', 'insert_race'],
    );
  });
});

describe('배포 안전 — 이미 배포된 자동화의 키가 바뀌면 안 된다', () => {
  it('receivedAt 경로의 해시 recipe는 예전과 바이트 단위로 같다', () => {
    // 옛 규칙: sha256(sender + "\n" + content + "\n" + receivedAt)
    const legacy = createHash('sha256')
      .update(`${SENDER}\n${CONTENT}\n2026-08-08T11:59:30.000Z`, 'utf8')
      .digest('hex');
    assert.equal(resolve({ receivedAt: '2026-08-08T11:59:30.000Z' }).eventId, legacy);
  });

  it('본문 지문은 content_hash 컬럼과 같은 규칙이다', () => {
    // 이 일치가 깨지면 창 기반 조회가 **적용 이전 행을 못 찾아** 배포 직후 재전송이
    // 전부 새 이벤트가 된다(거래 2배).
    const legacy = createHash('sha256')
      .update(`${SENDER}\n${CONTENT}`, 'utf8')
      .digest('hex');
    assert.equal(cardSmsContentHash(SENDER, CONTENT), legacy);
    assert.equal(resolve().contentHash, legacy);
  });

  it('tag 없는 파생은 옛 규칙 그대로다 (조사·재현 경로 보존)', () => {
    assert.equal(
      deriveCardSmsEventId(SENDER, CONTENT),
      cardSmsContentHash(SENDER, CONTENT),
    );
  });
});

/**
 * 지연 재전송 회귀 — 2026-08 실측.
 *
 * 08-23 20:05 쿠팡 취소 문자 하나가 11시간·25시간 뒤에 재전송돼 `content_hash`가 같은
 * 이벤트 3건이 됐고, 그중 2건은 원거래 잔액이 이미 0이라 영원히 `pending_review`로
 * 남아 매일 승격 정체 경보 + "확인이 필요한 거래" 알림을 만들었다. 키 창(3분)은 그대로
 * 두고 **지문 창만** 넓혀 막는다.
 */
describe('지연 재전송 — 본문에 일시가 있으면 지문 창을 넓게 본다', () => {
  const CARD_SENDER = '15888900';
  /** 실측 원문(삼성카드 취소). `MM/DD HH:mm`이 본문 안에 있다. */
  const DATED = '[Web발신]\n삼성7420취소 이*빈\n-3,700원 일시불\n08/23 20:05 쿠팡';

  /** @param {Date} ingestedAt */
  const dated = (ingestedAt) =>
    resolveCardSmsIdempotency({ sender: CARD_SENDER, content: DATED, ingestedAt });

  const FIRST = new Date('2026-08-23T11:06:23.000Z');

  it('본문의 거래 일시를 인식한다', () => {
    assert.equal(cardSmsContentCarriesTimestamp(DATED), true);
    // 연/월/일 접두와 다른 구분자도 같은 등급이다.
    assert.equal(cardSmsContentCarriesTimestamp('2026/08/20 23:54 ANTHROPIC'), true);
    assert.equal(cardSmsContentCarriesTimestamp('08-23 20:05 쿠팡'), true);
  });

  it('시간 축이 없는 본문은 종전 3분 창 그대로다 — 넓히면 결제 소실이다', () => {
    assert.equal(cardSmsContentCarriesTimestamp(CONTENT), false);
    assert.equal(
      resolve().windowLowerBound.getTime(),
      new Date('2026-08-08T12:00:00.000Z').getTime() - CARD_SMS_DEDUPE_WINDOW_MS,
    );
  });

  it('25시간 뒤 재전송도 지문 조회 범위 안에 든다 (실측 사례)', () => {
    // 08-25 09:38 수집분 — 첫 수집(08-23 20:06)보다 하한이 앞서야 지문 조회가 그 행을 찾는다.
    const third = dated(new Date('2026-08-25T00:38:28.000Z'));
    assert.ok(third.windowLowerBound < FIRST, '25시간 전 행을 조회 범위가 덮어야 한다');
    // 종전 3분 창이었다면 덮지 못했다 — 이 대비가 이 수정의 전부다.
    assert.ok(
      cardSmsDedupeWindowLowerBound(new Date('2026-08-25T00:38:28.000Z')) > FIRST,
    );
  });

  it('지문은 세 번의 재전송에서 모두 같다 — 조회가 찾을 대상이 존재한다', () => {
    const hashes = [
      dated(FIRST),
      dated(new Date('2026-08-23T22:44:58.000Z')),
      dated(new Date('2026-08-25T00:38:28.000Z')),
    ].map((r) => r.contentHash);
    assert.equal(new Set(hashes).size, 1);
  });

  it('창 상한은 유한하다 — 30일을 넘긴 동일 본문은 별개로 남는다', () => {
    const far = dated(new Date(FIRST.getTime() + CARD_SMS_FINGERPRINT_WINDOW_MS + 1000));
    assert.ok(far.windowLowerBound > FIRST);
  });

  it('키 창은 건드리지 않는다 — event_id 형식이 바뀌면 기존 행과 호환이 깨진다', () => {
    const a = dated(new Date('2026-08-23T11:06:23.000Z'));
    const b = dated(new Date('2026-08-25T00:38:28.000Z'));
    // 키는 여전히 3분 창 기반이라 서로 다르다. 중복 흡수는 지문 조회가 한다.
    assert.notEqual(a.eventId, b.eventId);
    assert.equal(a.keySource, 'derived_window');
  });
});
