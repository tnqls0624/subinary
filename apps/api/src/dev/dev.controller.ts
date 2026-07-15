import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import type {
  StorageTestResponse,
  TestJobEnqueueResponse,
  TestJobStatusResponse,
} from '@family/contracts';

import { QueueService } from '../queue/queue.service';
import { ObjectStorageService } from '../storage/object-storage.service';

/**
 * Development-only endpoints (mounted when NODE_ENV !== 'production').
 * Used by the Phase 0 verification contract (spec §9).
 */
@Controller('dev')
export class DevController {
  constructor(
    private readonly queueService: QueueService,
    private readonly objectStorageService: ObjectStorageService,
  ) {}

  /** POST /v1/dev/echo — returns the request body as-is. */
  @Post('echo')
  @HttpCode(HttpStatus.OK)
  echo(@Body() body: unknown): unknown {
    return body === undefined ? {} : body;
  }

  /** POST /v1/dev/test-job — enqueues a BullMQ test job. */
  @Post('test-job')
  @HttpCode(HttpStatus.OK)
  async enqueueTestJob(): Promise<TestJobEnqueueResponse> {
    return this.queueService.enqueueTest({ at: new Date().toISOString() });
  }

  /** GET /v1/dev/test-job/:id — job state/result. */
  @Get('test-job/:id')
  async getTestJob(@Param('id') id: string): Promise<TestJobStatusResponse> {
    const status = await this.queueService.getTestJob(id);
    if (!status) {
      throw new NotFoundException(`Test job "${id}" not found`);
    }
    return status;
  }

  /** POST /v1/dev/storage-test — put→get round trip against object storage. */
  @Post('storage-test')
  @HttpCode(HttpStatus.OK)
  async storageTest(): Promise<StorageTestResponse> {
    const key = `dev/storage-test/${Date.now()}-${randomUUID()}.txt`;
    const payload = `storage-test ${new Date().toISOString()}`;

    const startedAt = Date.now();
    await this.objectStorageService.putObject(key, payload, 'text/plain');
    const retrieved = await this.objectStorageService.getObject(key);
    const roundTripMs = Date.now() - startedAt;

    return {
      ok: retrieved.toString('utf8') === payload,
      bucket: this.objectStorageService.bucket,
      key,
      roundTripMs,
    };
  }
}
