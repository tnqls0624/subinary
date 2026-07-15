import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import type {
  HealthCheckItem,
  LivezResponse,
  ReadyzResponse,
} from '@family/contracts';
import { checkConnection, checkPgVector, type Db } from '@family/database';

import { DB } from '../database/database.constants';
import { ObjectStorageService } from '../storage/object-storage.service';
import { REDIS_HEALTH_CLIENT, SERVICE_NAME } from './health.constants';

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS_HEALTH_CLIENT) private readonly redis: Redis,
    private readonly storage: ObjectStorageService,
  ) {}

  /** Liveness: no dependency checks — the process is up and serving. */
  live(): LivezResponse {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: db / pgvector / redis / storage checked in parallel. */
  async ready(): Promise<ReadyzResponse> {
    const checks = await Promise.all([
      this.runCheck('db', async () => {
        const ok = await checkConnection(this.db);
        if (!ok) {
          throw new Error('select 1 failed');
        }
      }),
      this.runCheck('pgvector', async () => {
        const ok = await checkPgVector(this.db);
        if (!ok) {
          throw new Error('vector extension not installed');
        }
      }),
      this.runCheck('redis', async () => {
        const pong = await this.redis.ping();
        if (pong !== 'PONG') {
          throw new Error('unexpected ping response');
        }
      }),
      this.runCheck('storage', async () => {
        await this.storage.headBucket();
      }),
    ]);

    const allUp = checks.every((check) => check.status === 'up');

    return {
      status: allUp ? ('ok' as const) : ('degraded' as const),
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async runCheck(
    name: string,
    check: () => Promise<void>,
  ): Promise<HealthCheckItem> {
    const startedAt = Date.now();
    try {
      await check();
      return { name, status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error: unknown) {
      // Error messages only — never connection strings or credentials.
      const detail = error instanceof Error ? error.message : 'unknown error';
      return {
        name,
        status: 'down',
        detail,
        latencyMs: Date.now() - startedAt,
      };
    }
  }
}
