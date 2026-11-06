import { Module } from '@nestjs/common';
import { FinanceVault } from '../finance-connections/finance-vault';
import { HousingBrandSyncController } from './housing-brand-sync.controller';
import { HousingBrandSyncService } from './housing-brand-sync.service';
import { SujainBrowserClient } from './sujain-browser';

@Module({
  controllers: [HousingBrandSyncController],
  providers: [HousingBrandSyncService, SujainBrowserClient, FinanceVault],
  exports: [HousingBrandSyncService],
})
export class HousingBrandSyncModule {}
