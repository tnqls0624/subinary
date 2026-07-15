import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import type {
  TestJobEnqueueResponse,
  TestJobStatusResponse,
} from '@family/contracts';
import { QUEUE_NAMES } from '@family/shared';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(QUEUE_NAMES.TEST) private readonly testQueue: Queue,
  ) {}

  async enqueueTest(
    payload: Record<string, unknown>,
  ): Promise<TestJobEnqueueResponse> {
    const job = await this.testQueue.add('test', payload);
    return {
      jobId: String(job.id),
      queue: QUEUE_NAMES.TEST,
      status: 'queued',
    };
  }

  async getTestJob(id: string): Promise<TestJobStatusResponse | null> {
    const job = await this.testQueue.getJob(id);
    if (!job) {
      return null;
    }

    const state = await job.getState();
    const response: TestJobStatusResponse = {
      jobId: String(job.id ?? id),
      state,
    };
    if (job.returnvalue !== undefined && job.returnvalue !== null) {
      response.result = job.returnvalue as unknown;
    }
    if (job.failedReason) {
      response.failedReason = job.failedReason;
    }
    return response;
  }
}
