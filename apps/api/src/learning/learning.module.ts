import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { LearningCanaryMonitorService } from './learning-canary-monitor.service';
import { LearningDataControlController } from './learning-data-control.controller';
import { LearningDataControlService } from './learning-data-control.service';
import { LearningDatasetController } from './learning-dataset.controller';
import { LearningDatasetService } from './learning-dataset.service';
import { LearningModelController } from './learning-model.controller';
import { LearningModelService } from './learning-model.service';
import { LearningOperationsController } from './learning-operations.controller';
import { LearningOperationsService } from './learning-operations.service';
import { LearningMerchantDatasetService } from './learning-merchant-dataset.service';
import { LearningRagDatasetService } from './learning-rag-dataset.service';
import { LearningTrainingController } from './learning-training.controller';
import { LearningTrainingService } from './learning-training.service';

/** AI 학습/평가 데이터셋 제어 평면 모듈. */
@Module({
  imports: [StorageModule],
  controllers: [
    LearningDatasetController,
    LearningDataControlController,
    LearningModelController,
    LearningOperationsController,
    LearningTrainingController,
  ],
  providers: [
    LearningDatasetService,
    LearningDataControlService,
    LearningModelService,
    LearningCanaryMonitorService,
    LearningOperationsService,
    LearningMerchantDatasetService,
    LearningRagDatasetService,
    LearningTrainingService,
  ],
})
export class LearningModule {}
