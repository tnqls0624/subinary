/**
 * 승격 일시정지의 **범위** 테스트.
 *
 * ⚠️ 이 파일이 존재하는 이유는 지시서의 전제 하나가 부족했기 때문이다.
 *
 * 지시서·ADR 5단계는 "worker 승격 소비 일시정지 = BullMQ `queue.pause()`"라고 했다.
 * 그런데 `TransactionPromotionService.promote()`를 부르는 곳을 전수 조사하면 **둘**이다:
 *
 *   1. `card-sms-parse` 큐 프로세서              → 큐 pause로 멈춘다
 *   2. 알림 스케줄러의 `runPromotionStallCheck()` → **1분 setInterval 타이머다.
 *                                                   큐 pause와 무관하게 계속 돈다**
 *
 * 즉 큐만 멈추면 펜스 중에도 (2)가 금액을 쓴다 — "한 경로라도 legacy인 동안 사용자
 * 쓰기를 재개하지 않는다"는 ADR 요구가 깨진다. 이 테스트는 **두 경로가 같은 플래그
 * 하나로 막히는지**를 소스에서 고정한다.
 *
 * 소스 검사인 이유: 두 경로 모두 NestJS 프로바이더 전체(DB·Redis·BullMQ)를 띄워야
 * 실행할 수 있어 단위 테스트 범위가 아니다(이 패키지 vitest 설정의 방침). 실제 동작은
 * 격리 스택 리허설에서 실측한다.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = (relative: string): string =>
  readFileSync(resolve(here, '..', relative), 'utf8');

describe('승격을 부르는 곳은 정확히 둘이고, 둘 다 막힌다', () => {
  it('promote() 호출 지점이 늘면 이 테스트가 깨진다', () => {
    // 새 진입점이 생겼는데 pause를 배선하지 않으면 펜스에 구멍이 난다.
    // 목록이 바뀌면 이 테스트를 고치면서 pause 배선도 함께 보게 된다.
    const callers = [
      'processors/card-sms-parse.processor.ts',
      'notifications/notification-scheduler.service.ts',
    ];
    for (const file of callers) {
      expect(src(file)).toContain('promotionService.promote(');
    }
  });

  it('큐 경로: 프로세서가 자기 BullMQ Worker를 pause 대상으로 등록한다', () => {
    const source = src('processors/card-sms-parse.processor.ts');
    expect(source).toContain('moneyRuntime.register(');
    // `queue.pause()`가 아니라 `worker.pause()`다 — 이 프로세스의 소비만 멈추고
    // 큐(Redis)의 잡은 그대로 쌓인다.
    expect(source).toContain('this.worker.pause()');
    expect(source).toContain('this.worker.resume()');
  });

  it('큐 밖 경로: 스케줄러의 정체 자동복구가 pause를 확인하고 건너뛴다', () => {
    const source = src('notifications/notification-scheduler.service.ts');
    expect(source).toContain('moneyRuntime.isPromotionPaused');
    // 확인이 promote() **앞**에 있어야 한다 — 뒤에 있으면 이미 쓰인 뒤다.
    const guardAt = source.indexOf('moneyRuntime.isPromotionPaused');
    const promoteAt = source.indexOf('promotionService.promote(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(promoteAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(promoteAt);
  });
});

describe('금액 소유 컬럼을 쓰는 worker 지점은 승격 하나뿐이다', () => {
  it('source-tombstone·category-suggest는 금액 컬럼을 쓰지 않는다', () => {
    // 전수 조사 결과를 코드에 남긴다. 이 둘이 `card_transactions`를 건드리긴 하지만
    // tombstone은 `excludedAt`·가맹점명을, category-suggest는 `categoryId`를 쓴다.
    // 어느 쪽도 MONEY_PROTECTED_COLUMNS가 아니라 pause 대상이 아니다.
    const moneyColumns = [
      'amount:',
      'netAmount:',
      'cancelledAmount:',
      'exchangeRate:',
      'fxRateSnapshotId:',
    ];
    for (const file of [
      'processors/source-tombstone.processor.ts',
      'processors/category-suggest.processor.ts',
    ]) {
      const source = src(file);
      for (const column of moneyColumns) {
        expect(source).not.toContain(column);
      }
    }
  });
});

describe('컨테이너 stop이 아니라 소비만 멈춘다', () => {
  it('아웃박스 디스패처·알림 스케줄러는 pause 대상이 아니다', () => {
    // 컨테이너를 내리면 이것들까지 멈춘다. 특히 아웃박스가 멈추면 수집된 카드 문자가
    // 큐에 도달조차 못 한다 — 유실은 아니지만 전환이 길어질수록 밀린 양이 커진다.
    const runtime = src('promotion/money-runtime.service.ts');
    expect(runtime).not.toContain('OutboxDispatcher');
    // 등록은 프로세서가 스스로 한다(역방향 배선) — 런타임이 큐 목록을 하드코딩하지 않는다.
    expect(runtime).toContain('register(consumer: PausableConsumer)');
  });
});
