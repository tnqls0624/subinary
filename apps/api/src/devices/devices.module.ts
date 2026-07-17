/**
 * Devices module (Phase 2 Build Spec §4.5).
 *
 * Imports {@link AuthModule} to consume its exported `TokenService` and to make
 * the global `AccessTokenGuard` govern the `/v1/devices/*` management routes.
 * The `DB` provider comes from the global `DatabaseModule`, so it is not
 * re-imported here.
 *
 * Exports `DeviceService`, `DeviceHmacGuard` and `DeviceSecretCipher` for
 * Phase 3 reuse: the `card-sms` endpoint applies the same HMAC guard via
 * `@UseGuards()`, and Nest resolves the guard's own dependencies
 * (`DeviceSecretCipher`, `DeviceService`) in the consuming module's context, so
 * they must be exported alongside the guard.
 *
 * `DeviceTokenGuard` is likewise exported for the low-friction
 * `POST /v1/mobile-events/card-sms-token` ingest path (addendum). It depends
 * only on the global `DB` provider, so no extra collaborator export is needed.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DeviceHmacGuard } from './device-hmac.guard';
import { DeviceSecretCipher } from './device-secret.cipher';
import { DeviceTokenGuard } from './device-token.guard';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';
import { MobileEventsController } from './mobile-events.controller';

@Module({
  imports: [AuthModule],
  controllers: [DeviceController, MobileEventsController],
  providers: [DeviceSecretCipher, DeviceService, DeviceHmacGuard, DeviceTokenGuard],
  exports: [DeviceService, DeviceHmacGuard, DeviceSecretCipher, DeviceTokenGuard],
})
export class DevicesModule {}
