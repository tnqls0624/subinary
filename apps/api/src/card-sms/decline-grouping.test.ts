/**
 * P1-16 회귀 — 거절 묶음은 **별칭을 적용한 뒤에** 세어야 한다.
 *
 * 살아 있던 버그: 알림 스케줄러가 `merchant_raw`로 `GROUP BY` 한 뒤
 * `HAVING count(*) >= 2`를 통과시키고 **그 다음에** 별칭을 적용했다. 그래서 사용자가
 * `GS25`와 `지에스25`를 같은 가게로 확정해 두어도 각각 1회로 세어 둘 다 임계 앞에서
 * 탈락했다 — API 거절 목록(`listDeclines`)은 처음부터 묶기 전에 별칭을 적용하므로
 * **화면에는 "2회 실패"가 뜨는데 알림은 오지 않는** 상태였다.
 * ADR-0024 §3이 이미 "거절 묶음도 정규화와 사용자 별칭을 적용한다"고 결정한 것을
 * 한쪽 경로만 구현한 것이다.
 *
 * 여기서 검증하는 것은 두 경로가 공유하는 **순수 resolver·재묶기**다
 * (`@family/shared`). api `listDeclines`와 worker `runDeclineAlertCheck`가 둘 다
 * 이 함수를 통과하므로, 이 테스트가 통과하면 두 경로의 순서가 같다는 뜻이다.
 * 각자 구현으로 되돌리면 이 테스트는 그대로 통과하면서 사고만 재발하므로,
 * **두 호출부가 이 함수를 쓰는지**를 함께 본다.
 *
 * apps/worker에는 아직 테스트 러너가 없어 apps/api의 vitest에 얹는다
 * (`vitest.config.ts` → `src/**\/*.test.ts`). 대상은 공유 순수 함수라 위치와 무관하다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildMerchantAliasIndex,
  regroupByCanonicalMerchant,
  resolveCanonicalMerchant,
} from '@family/shared';
import { describe, expect, it } from 'vitest';

/** 반복 거절 알림 임계 — 스케줄러의 `DECLINE_ALERT_MIN_ATTEMPTS`와 같은 값. */
const MIN_ATTEMPTS = 2;

const HOUSEHOLD = '11111111-1111-1111-1111-111111111111';
const OTHER_HOUSEHOLD = '22222222-2222-2222-2222-222222222222';

/** 스케줄러가 SQL에서 원문으로 사전집계해 얻는 행의 모양. */
interface AttemptRow {
  householdId: string;
  merchantRaw: string | null;
  amount: number | null;
  attempts: number;
  lastAt: Date;
}

function row(
  merchantRaw: string | null,
  at: string,
  overrides: Partial<AttemptRow> = {},
): AttemptRow {
  return {
    householdId: HOUSEHOLD,
    merchantRaw,
    amount: 4_900,
    attempts: 1,
    lastAt: new Date(at),
    ...overrides,
  };
}

/** 스케줄러의 임계 판정을 그대로 재현한다(재묶기 → 합계 → 임계). */
function alertable(
  rows: readonly AttemptRow[],
  aliases: Parameters<typeof buildMerchantAliasIndex>[0],
) {
  return regroupByCanonicalMerchant(rows, {
    aliases: buildMerchantAliasIndex(aliases),
    householdId: (r) => r.householdId,
    merchantRaw: (r) => r.merchantRaw,
    subKey: (r) => String(r.amount ?? ''),
    weight: (r) => r.attempts,
    orderAt: (r) => r.lastAt,
  }).filter((g) => g.total >= MIN_ATTEMPTS);
}

describe('P1-16 — 별칭은 임계 판정 앞에 적용된다', () => {
  const gs25Alias = [
    { householdId: HOUSEHOLD, alias: '지에스25', canonical: 'GS25' },
  ];

  it('GS25 1회 + 지에스25 1회 + 별칭 = 2회로 세어 알림 대상이 된다', () => {
    // 버그가 있던 동안 이 조합은 0건이었다(각각 1회라 임계 앞에서 둘 다 탈락).
    const groups = alertable(
      [row('GS25', '2026-08-01T15:00:00Z'), row('지에스25', '2026-08-02T15:00:00Z')],
      gs25Alias,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].total).toBe(2);
    expect(groups[0].canonical).toBe('GS25');
    // 알림 payload의 이름은 canonical이어야 화면과 같은 묶음으로 읽힌다.
    expect(groups[0].latest.merchantRaw).toBe('지에스25');
  });

  it('별칭이 없으면 합치지 않는다 (묶음은 사용자 확정의 결과여야 한다)', () => {
    // `normalizeMerchant`는 로마자↔한글 음차를 의도적으로 합치지 않는다. 별칭 없이
    // 합쳐 버리면 시스템이 사용자가 확정하지 않은 사실을 만든다.
    const groups = alertable(
      [row('GS25', '2026-08-01T15:00:00Z'), row('지에스25', '2026-08-02T15:00:00Z')],
      [],
    );
    expect(groups).toHaveLength(0);
  });

  it('다른 가구의 같은 별칭은 우리 가구에 적용되지 않는다', () => {
    // 예전 스케줄러는 전 가구 별칭을 `alias` 문자열 하나만 key로 로드해, 남의 가구가
    // 등록한 별칭이 우리 가구 묶음을 바꿀 수 있었다.
    const groups = alertable(
      [row('GS25', '2026-08-01T15:00:00Z'), row('지에스25', '2026-08-02T15:00:00Z')],
      [{ householdId: OTHER_HOUSEHOLD, alias: '지에스25', canonical: 'GS25' }],
    );
    expect(groups).toHaveLength(0);
  });

  it('금액이 다르면 같은 가맹점이라도 다른 사건이다', () => {
    const groups = alertable(
      [
        row('GS25', '2026-08-01T15:00:00Z'),
        row('지에스25', '2026-08-02T15:00:00Z', { amount: 9_900 }),
      ],
      gs25Alias,
    );
    expect(groups).toHaveLength(0);
  });

  it('한 표기만으로 임계를 넘던 기존 동작은 그대로다', () => {
    const groups = alertable(
      [row('OO피트니스', '2026-08-01T15:00:00Z', { attempts: 7, amount: 99_000 })],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].total).toBe(7);
  });

  it('최신 시도(사유·시각)는 합쳐진 뒤에도 진짜 최신 행에서 온다', () => {
    // 사유는 바뀔 수 있다(한도초과 → 분실신고). 합치면서 옛 사유를 집으면 푸시가
    // 틀린 조치를 안내한다.
    const groups = alertable(
      [
        row('지에스25', '2026-08-05T15:00:00Z'),
        row('GS25', '2026-08-01T15:00:00Z'),
      ],
      gs25Alias,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].latest.lastAt.toISOString()).toBe('2026-08-05T15:00:00.000Z');
  });

  it('가맹점명이 없는 행끼리는 합치지 않는다', () => {
    // 이름을 모르는 서로 다른 실패를 한 사건으로 합치면 없는 사실을 만든다.
    const groups = alertable(
      [row(null, '2026-08-01T15:00:00Z'), row(null, '2026-08-02T15:00:00Z')],
      [],
    );
    expect(groups).toHaveLength(0);
  });
});

describe('resolveCanonicalMerchant', () => {
  const index = buildMerchantAliasIndex([
    { householdId: HOUSEHOLD, alias: '지에스25', canonical: 'GS25' },
    // 자기참조는 DB CHECK가 막지만 인덱스도 무시한다(무한 해석 방어).
    { householdId: HOUSEHOLD, alias: '스타벅스', canonical: '스타벅스' },
  ]);

  it('정규화를 먼저 하고 별칭을 1단계만 적용한다', () => {
    // 괄호/지점 접미사는 정규화 단계에서 떨어지고, 그 결과에 별칭이 걸린다.
    expect(resolveCanonicalMerchant('지에스25 강남점', HOUSEHOLD, index)).toBe(
      'GS25',
    );
  });

  it('별칭이 없으면 정규화 결과가 곧 canonical이다', () => {
    expect(resolveCanonicalMerchant('스타벅스', HOUSEHOLD, index)).toBe('스타벅스');
  });

  it('빈 이름은 null이다 (빈 문자열 버킷을 만들지 않는다)', () => {
    expect(resolveCanonicalMerchant(null, HOUSEHOLD, index)).toBeNull();
    expect(resolveCanonicalMerchant('   ', HOUSEHOLD, index)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 두 호출부가 정말 공유 resolver를 통과하는가                                   */
/* -------------------------------------------------------------------------- */

// `import.meta`는 apps/api가 CommonJS로 빌드돼 쓸 수 없다. vitest의 cwd는
// 패키지 루트(apps/api)이므로 거기서 상대 경로를 푼다.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

describe('공유 resolver 재사용 (각자 구현으로 되돌아가지 못하게)', () => {
  it('api listDeclines가 공유 resolver를 쓴다', () => {
    const src = read('src/card-sms/card-sms-query.service.ts');
    expect(src).toContain('resolveCanonicalMerchant');
    expect(src).toContain('buildMerchantAliasIndex');
  });

  it('worker 스케줄러가 재묶기를 임계 앞에 둔다', () => {
    const src = read(
      '../worker/src/notifications/notification-scheduler.service.ts',
    );
    expect(src).toContain('regroupByCanonicalMerchant');
    expect(src).toContain('buildMerchantAliasIndex');
    // SQL 단계의 `HAVING count(*) >= N`이 되살아나면 임계가 다시 별칭 앞으로 간다.
    expect(src).not.toMatch(/\.having\(\s*sql`count\(\*\) >=/);
    // 별칭 로드는 가구별로 격리돼야 한다.
    expect(src).toContain('householdId: schema.merchantAliases.householdId');
  });
});

/* -------------------------------------------------------------------------- */
/* 알림이 실제로 발행되는가 — BullMQ jobId 규칙                                 */
/* -------------------------------------------------------------------------- */

/**
 * BullMQ는 커스텀 `jobId`에 `:`가 있으면 `split(':').length === 3`(반복 잡 호환)일
 * 때만 허용하고 그 외에는 던진다. `reminder:<user>:<date>`는 우연히 통과했지만
 * `decline:<가구>:<가맹점>:<금액>:<주>`는 콜론이 4개라 **매번 실패**했고, 클레임이
 * 먼저라 그 주의 알림이 조용히 사라졌다 — 반복 거절 알림(ADR-0024)이 실제로는 한 번도
 * 발행되지 않고 있었다. 별칭 순서를 고쳐도 이게 남아 있으면 사용자에게 도달하지 않는다.
 */
function bullmqAcceptsJobId(jobId: string): boolean {
  return !jobId.includes(':') || jobId.split(':').length === 3;
}

describe('거절 알림 jobId (발행 실패로 조용히 사라지지 않게)', () => {
  const dedupeKey = 'decline:11111111-1111-1111-1111-111111111111:GS25:4900:2953';

  it('원문 dedupe 키를 그대로 jobId로 쓰면 BullMQ가 거부한다 (이게 버그였다)', () => {
    expect(bullmqAcceptsJobId(`notif_${dedupeKey}`)).toBe(false);
  });

  it('인코딩하면 통과하고, 서로 다른 키가 같은 jobId로 합쳐지지 않는다', () => {
    const jobId = `notif_${encodeURIComponent(dedupeKey)}`;
    expect(bullmqAcceptsJobId(jobId)).toBe(true);
    expect(decodeURIComponent(jobId.slice('notif_'.length))).toBe(dedupeKey);
    // 한글 가맹점명도 콜론 없는 jobId가 된다.
    const korean = 'decline:h:지에스25:4900:2953';
    expect(bullmqAcceptsJobId(`notif_${encodeURIComponent(korean)}`)).toBe(true);
  });

  it('스케줄러가 jobId를 인코딩하고, 발송 실패 시 클레임을 푼다', () => {
    const src = read(
      '../worker/src/notifications/notification-scheduler.service.ts',
    );
    expect(src).toContain('jobId: `notif_${encodeURIComponent(dedupeKey)}`');
    expect(src).toContain('releaseDedupe');
  });
});

/* -------------------------------------------------------------------------- */
/* 유령 결제 실패 — 금액 없는 `declined`가 빨간 경고로 뜨던 것                    */
/* -------------------------------------------------------------------------- */

/**
 * 실측(2026-08-20): `/declines`에 **"확인 안 된 가맹점 · 금액 미확인 · 3번 거절"**
 * 이라는 빨간 경고 한 줄이 상시 떠 있었다. 실패한 결제가 아니다.
 *
 * 정체는 사람이 검토 화면에서 치운 쓰레기 문자 3통이었다 — `'2'`, MacroDroid 변수가
 * 치환되지 않은 `'{v=msg}'`, 토스 모임금고 안내. 파서는 세 건 모두 `parse_failed`로
 * 보고했고(`parseable()`이 amount+currency를 요구한다), `parse_status='parsed'` ·
 * `confidence=100` · `amount=NULL`은 **사람 확정**의 서명이다. 검토 화면에 "카드 문자
 * 아님"을 처리할 결과값이 없어 `declined`가 유일한 탈출구였던 것이다.
 *
 * 그 결과 세 건이 버킷 키 `` `${merchant ?? ''}|${amount ?? ''}` `` = `'|'`로 뭉쳐
 * 한 묶음 3회가 됐다. 여기서 고정하는 것은 **읽는 쪽이 금액을 요구한다**는 것이다:
 * 금액이 없으면 무엇이 실패했는지 말할 수 없고 재시도 묶음도 만들 수 없다.
 *
 * 근본 원인(검토 결과값 추가)은 별건이다. 그것이 들어와도 이 조건은 남아야 한다 —
 * 과거에 그렇게 처리된 행이 DB에 남아 있기 때문이다.
 */
describe('유령 결제 실패 (금액 없는 declined는 결제 실패가 아니다)', () => {
  it('listDeclines가 금액 있는 행만 읽는다', () => {
    const src = read('src/card-sms/card-sms-query.service.ts');
    const start = src.indexOf('async listDeclines(');
    expect(start).toBeGreaterThan(-1);
    // 이 서비스의 다음 메서드 경계까지가 listDeclines의 본문이다.
    const body = src.slice(start, src.indexOf('async dismissDecline('));
    expect(body).toContain('isNotNull(schema.cardSmsEvents.amount)');
  });

  it('금액 없는 행끼리 한 묶음으로 뭉치는 키 규칙은 그대로다', () => {
    // 필터는 읽는 쪽에 있고, 묶음 키는 바뀌지 않았다. 키를 손대면 금액이 있는
    // 정상 거절의 묶음이 함께 갈라진다 — 그래서 필터로 막는 쪽을 골랐다.
    const src = read('src/card-sms/card-sms-query.service.ts');
    expect(src).toContain("`${merchant ?? ''}|${e.amount ?? ''}`");
  });
});
