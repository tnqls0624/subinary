import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';

import { HealthService } from './health.service';
import type { LivezResponse, ReadyzResponse } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** GET /v1/health/live — liveness. 의존성을 검사하지 않는다. */
  @Get('live')
  getLive(): LivezResponse {
    return this.healthService.getLiveness();
  }

  /** GET /v1/health/ready — readiness. redis ping + db checkConnection. 하나라도 down이면 503. */
  @Get('ready')
  async getReady(): Promise<ReadyzResponse> {
    const readiness = await this.healthService.getReadiness();
    if (readiness.status !== 'ok') {
      // degraded 응답 본문을 그대로 유지하며 HTTP 503으로 반환한다.
      throw new HttpException(readiness, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return readiness;
  }
}
