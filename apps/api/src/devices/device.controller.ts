/**
 * Device management HTTP surface (Phase 2 Build Spec §4.5).
 *
 * All routes require normal user authentication (the global
 * {@link AccessTokenGuard} runs — none of these are `@Public()`). The
 * authenticated principal is passed to the service as `actorUserId`; the
 * service enforces household membership and device ownership. Bodies and the
 * `householdId` query are validated by the global `ZodValidationPipe`.
 *
 * The raw device secret returned by register/rotate-secret is exposed exactly
 * once and is never logged.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  deviceRegisterRequestSchema,
  type DeviceSecretResponse,
  type DeviceSummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { DeviceService } from './device.service';

class DeviceRegisterDto extends createZodDto(deviceRegisterRequestSchema) {}

/** `GET /v1/devices?householdId=` — the household scope is required. */
const deviceListQuerySchema = z.object({ householdId: z.string().uuid() });
class DeviceListQueryDto extends createZodDto(deviceListQuerySchema) {}

@Controller('devices')
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  /** POST /v1/devices/register — register a device and issue its first secret. */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeviceRegisterDto,
  ): Promise<DeviceSecretResponse> {
    return this.deviceService.registerDevice(user.userId, dto);
  }

  /** GET /v1/devices?householdId=... — list a household's devices. */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DeviceListQueryDto,
  ): Promise<DeviceSummary[]> {
    return this.deviceService.listDevices(user.userId, query.householdId);
  }

  /** POST /v1/devices/:id/rotate-secret — rotate the secret (owner/self). */
  @Post(':id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  rotateSecret(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DeviceSecretResponse> {
    return this.deviceService.rotateSecret(user.userId, id);
  }

  /** DELETE /v1/devices/:id — revoke a device (owner/self). */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ revoked: true }> {
    return this.deviceService.revokeDevice(user.userId, id);
  }
}
