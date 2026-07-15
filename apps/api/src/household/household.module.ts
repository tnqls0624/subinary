/**
 * Household module (Phase 1 Build Spec §4.3).
 *
 * Imports {@link AuthModule} to consume its exported `TokenService`
 * (`hashToken` is used for invitation token hashing). The `DB` provider comes
 * from the global `DatabaseModule`, so it is not re-imported here.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';
import { InvitationController } from './invitation.controller';

@Module({
  imports: [AuthModule],
  controllers: [HouseholdController, InvitationController],
  providers: [HouseholdService],
})
export class HouseholdModule {}
