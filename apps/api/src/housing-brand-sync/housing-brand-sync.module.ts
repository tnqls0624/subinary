import { Module } from '@nestjs/common';
import { FinanceVault } from '../finance-connections/finance-vault';
import { HousingBrandRegistry } from './brand-registry';
import { HousingBrandSyncController } from './housing-brand-sync.controller';
import { HousingBrandSyncService } from './housing-brand-sync.service';
import { SujainAdapter } from './sujain-adapter';
import { SujainBrowserClient } from './sujain-browser';

@Module({
  controllers: [HousingBrandSyncController],
  providers: [HousingBrandSyncService, HousingBrandRegistry, SujainAdapter, SujainBrowserClient, FinanceVault],
  exports: [HousingBrandSyncService],
})
export class HousingBrandSyncModule {}
