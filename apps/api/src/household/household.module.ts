/**
 * Household module (Phase 1 Build Spec §4.3).
 *
 * Imports {@link AuthModule} to consume its exported `TokenService`
 * (`hashToken` is used for invitation token hashing). The `DB` provider comes
 * from the global `DatabaseModule`, so it is not re-imported here.
 *
 * {@link DevicesModule}을 임포트하는 이유(C-3): 동의 철회가 기기를 즉시 폐기해야 하고,
 * 그 폐기는 **기존 초크포인트** `DeviceService.revokeDevice`를 그대로 통과해야 한다.
 * 반대 방향(devices → household) 의존은 만들지 않는다 — `DeviceService`가 필요로 하는
 * 동의 판정은 provider가 아니라 순수 함수(`household-consent.ts`)로 임포트해 모듈
 * 순환을 피한다.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { HouseholdPrivacyController } from './household-privacy.controller';
import { HouseholdPrivacyService } from './household-privacy.service';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';
import { InvitationController } from './invitation.controller';

@Module({
  imports: [AuthModule, DevicesModule],
  controllers: [
    HouseholdController,
    HouseholdPrivacyController,
    InvitationController,
  ],
  providers: [HouseholdService, HouseholdPrivacyService],
})
export class HouseholdModule {}
