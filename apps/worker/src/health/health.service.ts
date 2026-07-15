import { Inject, Injectable } from '@nestjs/common';
import { checkConnection, type Db } from '@family/database';
import type { Redis } from 'ioredis';

import { DB } from '../database/database.module';
import { REDIS_CLIENT, SERVICE_NAME } from './health.constants';

/** contracts의 healthCheckItemSchema와 동일한 shape (worker는 @family/contracts 비의존) */
export interface HealthCheckItem {
  name: string;
  status: 'up' | 'down';
  detail?: string;
  latencyMs?: number;
}

export interface LivezResponse {
  status: 'ok';
  service: string;
  timestamp: string;
}

export interface ReadyzResponse {
  status: 'ok' | 'degraded';
  service: string;
  timestamp: string;
  checks: HealthCheckItem[];
}

const CHECK_TIMEOUT_MS = 3000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  getLiveness(): LivezResponse {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<ReadyzResponse> {
    const checks = await Promise.all([this.checkRedis(), this.checkDb()]);
    const status: ReadyzResponse['status'] = checks.every((check) => check.status === 'up')
      ? 'ok'
      : 'degraded';

    return {
      status,
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private checkRedis(): Promise<HealthCheckItem> {
    return this.runCheck('redis', async () => {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        throw new Error('unexpected redis ping reply');
      }
    });
  }

  private checkDb(): Promise<HealthCheckItem> {
    return this.runCheck('db', async () => {
      const ok = await checkConnection(this.db);
      if (!ok) {
        throw new Error('database connection check returned false');
      }
    });
  }

  private async runCheck(name: string, fn: () => Promise<void>): Promise<HealthCheckItem> {
    const startedAt = Date.now();
    try {
      await this.withTimeout(fn(), CHECK_TIMEOUT_MS, name);
      return { name, status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error: unknown) {
      return {
        name,
        status: 'down',
        detail: error instanceof Error ? error.message : 'unknown error',
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} check timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
