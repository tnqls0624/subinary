/**
 * Devices module (Phase 2 Build Spec §4.5).
 *
 * Imports {@link AuthModule} to consume its exported `TokenService` and to make
 * the global `AccessTokenGuard` govern the `/v1/devices/*` management routes.
 * The `DB` provider comes from the global `DatabaseModule`, so it is not
 * re-imported here.
 *
 * Exports `DeviceService` and `DeviceHmacGuard` for Phase 3 reuse (the
 * `card-sms` endpoint authenticates with the same HMAC guard).
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DeviceHmacGuard } from './device-hmac.guard';
import { DeviceSecretCipher } from './device-secret.cipher';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';
import { MobileEventsController } from './mobile-events.controller';

@Module({
  imports: [AuthModule],
  controllers: [DeviceController, MobileEventsController],
  providers: [DeviceSecretCipher, DeviceService, DeviceHmacGuard],
  exports: [DeviceService, DeviceHmacGuard],
})
export class DevicesModule {}
