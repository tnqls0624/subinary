import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import type { LivezResponse, ReadyzResponse } from '@family/contracts';

import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** GET /v1/health/live */
  @Get('live')
  live(): LivezResponse {
    return this.healthService.live();
  }

  /** GET /v1/health/ready — 503 with the same body when any check is down. */
  @Get('ready')
  async ready(): Promise<ReadyzResponse> {
    const result = await this.healthService.ready();
    if (result.status === 'degraded') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
