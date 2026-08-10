import { Controller, Get, HttpException, HttpStatus, Query } from '@nestjs/common';
import type { CardSmsParserQuality } from '@family/database';

import { HealthService } from './health.service';
import type { LivezResponse, ReadyzResponse } from './health.service';

/** `?windowDays=` 파싱. 잘못된 값은 400이 아니라 기본 창으로 떨어뜨린다(진단 창구). */
function parseWindowDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) return undefined;
  return parsed;
}

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

  /**
   * GET /v1/health/parser-quality — ADR-0023 파서 품질 지표.
   *
   * 왜 헬스 컨트롤러에 두는가: 워커에는 다른 읽기 표면이 없고, 이 지표는 사용자
   * 기능이 아니라 **운영 진단**이다. 새 모듈·새 계약을 만드는 값이 없다.
   * readiness와 달리 값이 나빠도 503을 내지 않는다 — 문구 개편 신호는 워커를 재시작
   * 대상으로 만들 이유가 아니다(오케스트레이터가 헬스체크로 죽여 버린다).
   */
  @Get('parser-quality')
  getParserQuality(
    @Query('windowDays') windowDays?: string,
  ): Promise<CardSmsParserQuality> {
    return this.healthService.getParserQuality(parseWindowDays(windowDays));
  }
}
