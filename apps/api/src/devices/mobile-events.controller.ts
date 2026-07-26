/**
 * Mobile events HTTP surface (Phase 2 Build Spec §4.5).
 *
 * `POST /v1/mobile-events/ping` proves the device HMAC pipeline end-to-end. The
 * route is `@Public()` (bypasses the global access-token guard) and instead
 * guarded by {@link DeviceHmacGuard}; the authenticated device principal is
 * read via the `@Device()` decorator. Phase 3's `card-sms` endpoint reuses the
 * same guard.
 *
 * `ping-token`은 같은 일을 **수집 토큰**으로 한다. 자동화 도구(MacroDroid/단축어)는
 * HMAC 서명을 만들지 못해 collect token 경로만 쓰는데, HMAC 전용 ping은 그들이
 * 호출할 수 없어 온보딩 진단에 쓸 수 없었다. 이 경로가 있어야
 * "인증은 되는데 문자 트리거가 안 걸림"(`lastSeenAt` 있음 + `lastEventAt` 없음)과
 * "인증 자체 실패"(둘 다 없음)가 구분된다.
 */
import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { DevicePingResponse } from '@family/contracts';

import { Public } from '../auth/decorators/public.decorator';
import { DeviceHmacGuard } from './device-hmac.guard';
import { DeviceTokenGuard } from './device-token.guard';
import { Device, type DeviceContext } from './decorators/device.decorator';

@Controller('mobile-events')
export class MobileEventsController {
  /** POST /v1/mobile-events/ping — HMAC-authenticated liveness echo. */
  @Public()
  @UseGuards(DeviceHmacGuard)
  @Post('ping')
  @HttpCode(HttpStatus.OK)
  ping(@Device() device: DeviceContext): DevicePingResponse {
    return this.echo(device);
  }

  /**
   * POST /v1/mobile-events/ping-token — 수집 토큰(Bearer) 기반 연결 테스트.
   * 자동화 설정 직후 "토큰이 맞는지"만 확인하는 용도라 본문이 없다. 가드가
   * `lastSeenAt`을 갱신하므로 이후 진단에서 인증 성공이 관측된다.
   */
  @Public()
  @UseGuards(DeviceTokenGuard)
  @Post('ping-token')
  @HttpCode(HttpStatus.OK)
  pingWithToken(@Device() device: DeviceContext): DevicePingResponse {
    return this.echo(device);
  }

  private echo(device: DeviceContext): DevicePingResponse {
    return {
      authenticated: true,
      deviceId: device.deviceId,
      householdId: device.householdId,
      receivedAt: new Date().toISOString(),
    };
  }
}
