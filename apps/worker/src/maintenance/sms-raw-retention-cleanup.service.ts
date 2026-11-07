/**
 * 가구별 문자 원문 보존 정책에 맞춰 원문 사본을 주기적으로 지운다(SOO-34).
 *
 * 정책 변경 직후 즉시 purge는 API가 담당하고, 여기서는 `days_30`로 나이가 찬 건과
 * `after_parse`/`failures_only`로 나중에 조건이 맞은 건을 이어 지운다.
 * 판정·삭제 본체는 `@family/database`의 같은 함수를 써서 미리보기와 어긋나지 않게 한다.
 */
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ne } from 'drizzle-orm';

import {
  purgeSmsRawForHousehold,
  schema,
  type Db,
  type SmsRetentionPolicy,
} from '@family/database';
import { createLogger } from '@family/shared';

import { DB } from '../database/database.module';
import { ObjectStorageService } from '../storage/object-storage.service';

/** 15분 — after_parse가 파싱 직후 원문을 오래 붙잡지 않게 한다. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

export interface RetentionCleanupSummary {
  householdsScanned: number;
  purgedEventCount: number;
  purgedSuppressionCount: number;
  failedEventCount: number;
  failedSuppressionCount: number;
}

@Injectable()
export class SmsRawRetentionCleanupService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = createLogger('worker:sms-raw-retention-cleanup', {
    pretty: process.env.NODE_ENV !== 'production',
  });
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), PURGE_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<RetentionCleanupSummary> {
    if (this.running) {
      return {
        householdsScanned: 0,
        purgedEventCount: 0,
        purgedSuppressionCount: 0,
        failedEventCount: 0,
        failedSuppressionCount: 0,
      };
    }
    this.running = true;
    try {
      return await this.runOnce();
    } finally {
      this.running = false;
    }
  }

  /** 테스트·수동 실행용. */
  async runOnce(): Promise<RetentionCleanupSummary> {
    const households = await this.db
      .select({
        id: schema.households.id,
        policy: schema.households.smsRetentionPolicy,
      })
      .from(schema.households)
      .where(ne(schema.households.smsRetentionPolicy, 'none'));

    let purgedEventCount = 0;
    let purgedSuppressionCount = 0;
    let failedEventCount = 0;
    let failedSuppressionCount = 0;

    for (const household of households) {
      if (household.policy === 'none') continue;
      const result = await purgeSmsRawForHousehold(this.db, {
        householdId: household.id,
        policy: household.policy as SmsRetentionPolicy,
        triggeredBy: 'scheduler',
        actorUserId: null,
        deleteObject: (key) => this.storage.deleteObject(key),
        objectExists: (key) => this.storage.objectExists(key),
      });
      purgedEventCount += result.purgedEventCount;
      purgedSuppressionCount += result.purgedSuppressionCount;
      failedEventCount += result.failedEventCount;
      failedSuppressionCount += result.failedSuppressionCount;
    }

    if (
      purgedEventCount > 0 ||
      purgedSuppressionCount > 0 ||
      failedEventCount > 0 ||
      failedSuppressionCount > 0
    ) {
      this.logger.info(
        {
          householdsScanned: households.length,
          purgedEventCount,
          purgedSuppressionCount,
          failedEventCount,
          failedSuppressionCount,
        },
        'sms raw retention cleanup',
      );
    }

    return {
      householdsScanned: households.length,
      purgedEventCount,
      purgedSuppressionCount,
      failedEventCount,
      failedSuppressionCount,
    };
  }
}
