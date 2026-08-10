/**
 * `device_nonces` 만료 행 정리(ADR-0007 §단점 3 · §변경조건 2).
 *
 * HMAC 서명 요청은 replay 방지를 위해 `(device_id, nonce)`를 DB에 영속한다. TTL이
 * 지난 행은 replay 판정에 더 쓰이지 않는데도 남아 테이블만 키운다 — ADR이 "만료
 * 정리가 필요하다"고 적어 둔 채 정리 주체가 없었다.
 *
 * ## 왜 이렇게 싸게 만드는가
 *
 * 2026-08-10 운영 DB 실측: `device_nonces` **0행 / 96 kB**. 즉 "무한 증가"는 아직
 * 일어나지 않았다(수집이 Bearer collect token 경로만 쓰고 HMAC 경로는 호출되지
 * 않는다 — 자세한 진단은 리포트 참조). 그래서 전용 큐·프로세서를 만들지 않고
 * `expires_at` 인덱스를 그대로 쓰는 주기 DELETE 하나로 끝낸다. 지금 필요한 것은
 * "테이블이 커지기 시작하면 자동으로 깎인다"는 보장뿐이다.
 *
 * ## 왜 배치로 쪼개는가
 *
 * `DELETE WHERE expires_at < now()` 한 방은 행이 쌓인 뒤에 돌면 그 한 문장이
 * 테이블을 오래 잠근다. 잠금 중에는 가드의 nonce INSERT가 대기하고, 그동안 들어온
 * **정상 인증 요청이 타임아웃으로 401처럼 실패**한다 — 정리 작업이 인증을 깎는 것은
 * 정리하지 않는 것보다 나쁘다. 그래서 한 번에 {@link PURGE_BATCH_SIZE}행씩,
 * tick당 {@link MAX_BATCHES_PER_TICK}배치까지만 지운다.
 *
 * 여러 worker 레플리카가 동시에 돌아도 `FOR UPDATE SKIP LOCKED`로 서로 다른 행을
 * 집어가므로 대기 없이 나눠 처리한다(outbox 디스패처와 같은 판단).
 */
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { schema, type Db } from '@family/database';
import { createLogger } from '@family/shared';
import { inArray, lt } from 'drizzle-orm';

import { DB } from '../database/database.module';

/**
 * 정리 주기. nonce TTL 기본값이 600초(`DEVICE_NONCE_TTL_SEC`)라 1시간 주기면 만료
 * 행이 최대 1시간 남는다 — replay 판정은 TTL로 하므로 정확성에 무해하고, 주기를
 * 짧게 해서 얻는 것은 없다.
 */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** 한 DELETE가 잠그는 행 수 상한. */
export const PURGE_BATCH_SIZE = 1_000;

/**
 * tick당 배치 수 상한(= 최대 20,000행). 상한이 없으면 백로그가 큰 첫 실행이 한
 * tick을 무한정 붙잡는다. 남은 행은 다음 tick이 이어서 지운다.
 */
export const MAX_BATCHES_PER_TICK = 20;

/** 한 tick의 정리 결과. */
export interface NoncePurgeSummary {
  deleted: number;
  batches: number;
  /** 상한에 걸려 아직 만료 행이 남아 있을 수 있으면 true. */
  truncated: boolean;
}

/**
 * 배치 DELETE 루프. DB 접근을 콜백으로 분리해 루프 종료 조건만 단위 테스트한다
 * (조건이 틀리면 tick이 안 끝나거나 한 배치만 지우고 만다).
 *
 * 종료 조건은 **"지운 행이 배치 크기보다 적다"**다 — 0을 기다리면 마지막에 항상
 * 빈 쿼리 한 번이 더 나간다.
 */
export async function purgeInBatches(
  deleteBatch: () => Promise<number>,
  maxBatches: number = MAX_BATCHES_PER_TICK,
  batchSize: number = PURGE_BATCH_SIZE,
): Promise<NoncePurgeSummary> {
  let deleted = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const count = await deleteBatch();
    batches += 1;
    deleted += count;
    if (count < batchSize) {
      return { deleted, batches, truncated: false };
    }
  }

  return { deleted, batches, truncated: true };
}

@Injectable()
export class DeviceNonceCleanupService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = createLogger('worker:device-nonce-cleanup', {
    pretty: process.env.NODE_ENV !== 'production',
  });
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@Inject(DB) private readonly db: Db) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), PURGE_INTERVAL_MS);
    // unref: 정리 타이머가 프로세스 종료를 붙잡지 않게 한다(스케줄러와 동일).
    this.timer.unref();
    // 부팅 직후 1회 — 재시작 사이에 쌓인 만료 행을 첫 주기까지 기다리지 않는다.
    void this.tick();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 만료 nonce를 배치로 지운다. 재진입 방지 — 느린 tick이 겹쳐 돌지 않게 한다. */
  async tick(): Promise<NoncePurgeSummary> {
    if (this.running) {
      return { deleted: 0, batches: 0, truncated: false };
    }
    this.running = true;
    try {
      const summary = await purgeInBatches(() => this.deleteExpiredBatch());
      // 0행 정리는 정상 상태(HMAC 경로 미사용)라 로그를 남기지 않는다 — 매시간
      // "0건 지웠음" 줄이 쌓이면 진짜 신호가 묻힌다.
      if (summary.deleted > 0) {
        this.logger.info(summary, 'expired device nonces purged');
      }
      return summary;
    } catch (error: unknown) {
      // 정리 실패는 서비스 기능이 아니다 — 다음 tick이 다시 시도하므로 경고만 남긴다.
      this.logger.warn(
        { errorCode: error instanceof Error ? error.name : 'UnknownError' },
        'device nonce purge failed',
      );
      return { deleted: 0, batches: 0, truncated: false };
    } finally {
      this.running = false;
    }
  }

  /**
   * 만료 행 한 배치를 지우고 지운 행 수를 돌려준다.
   *
   * `id IN (SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED)` 형태를 쓰는 이유:
   * DELETE 자체에는 LIMIT이 없고, 서브쿼리에서 잠글 행을 먼저 고르면 다른
   * 레플리카가 이미 집어간 행은 건너뛴다.
   */
  private async deleteExpiredBatch(): Promise<number> {
    const expired = this.db
      .select({ id: schema.deviceNonces.id })
      .from(schema.deviceNonces)
      .where(lt(schema.deviceNonces.expiresAt, new Date()))
      // 오래된 것부터 — 인덱스(device_nonces_expires_at_idx) 순서라 스캔이 짧다.
      .orderBy(schema.deviceNonces.expiresAt)
      .limit(PURGE_BATCH_SIZE)
      .for('update', { skipLocked: true });

    const rows = await this.db
      .delete(schema.deviceNonces)
      .where(inArray(schema.deviceNonces.id, expired))
      .returning({ id: schema.deviceNonces.id });

    return rows.length;
  }
}
