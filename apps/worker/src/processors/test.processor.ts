import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import { createLogger, QUEUE_NAMES } from '@family/shared';
import type { Job } from 'bullmq';

const PROCESS_DELAY_MS = 150;

interface TestJobResult {
  processedAt: string;
  echo: unknown;
}

@Processor(QUEUE_NAMES.TEST)
export class TestProcessor extends WorkerHost {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(configService: ConfigService) {
    super();
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:test-processor', { pretty: nodeEnv !== 'production' });
  }

  async process(job: Job): Promise<TestJobResult> {
    // 개인정보/Secret 보호: job.data(payload)는 절대 로그에 남기지 않는다. 메타데이터만 기록.
    this.logger.info(
      { jobId: job.id, jobName: job.name, queue: job.queueName, attempt: job.attemptsMade + 1 },
      'test job received',
    );

    await this.delay(PROCESS_DELAY_MS);

    const result: TestJobResult = {
      processedAt: new Date().toISOString(),
      echo: job.data,
    };

    this.logger.info({ jobId: job.id, queue: job.queueName }, 'test job completed');

    return result;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
