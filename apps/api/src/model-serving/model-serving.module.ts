import { Global, Module } from '@nestjs/common';

import { ModelServingService } from './model-serving.service';

/** API 전역에서 scope별 model alias gate를 제공한다. */
@Global()
@Module({
  providers: [ModelServingService],
  exports: [ModelServingService],
})
export class ModelServingModule {}
