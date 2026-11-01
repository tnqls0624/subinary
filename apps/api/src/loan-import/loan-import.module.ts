import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { FinancialOverviewController, LoanImportController } from './loan-import.controller';
import { LoanImportService } from './loan-import.service';

@Module({ imports: [RealtimeModule], controllers: [LoanImportController, FinancialOverviewController], providers: [LoanImportService] })
export class LoanImportModule {}
