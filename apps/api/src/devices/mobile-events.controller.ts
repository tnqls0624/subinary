/**
 * Mobile events HTTP surface (Phase 2 Build Spec §4.5).
 *
 * `POST /v1/mobile-events/ping` proves the device HMAC pipeline end-to-end. The
 * route is `@Public()` (bypasses the global access-token guard) and instead
 * guarded by {@link DeviceHmacGuard}; the authenticated device principal is
 * read via the `@Device()` decorator. Phase 3's `card-sms` endpoint reuses the
 * same guard.
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
import { Device, type DeviceContext } from './decorators/device.decorator';

@Controller('mobile-events')
export class MobileEventsController {
  /** POST /v1/mobile-events/ping — HMAC-authenticated liveness echo. */
  @Public()
  @UseGuards(DeviceHmacGuard)
  @Post('ping')
  @HttpCode(HttpStatus.OK)
  ping(@Device() device: DeviceContext): DevicePingResponse {
    return {
      authenticated: true,
      deviceId: device.deviceId,
      householdId: device.householdId,
      receivedAt: new Date().toISOString(),
    };
  }
}
