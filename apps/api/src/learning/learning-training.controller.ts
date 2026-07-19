import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  trainingRunCreateRequestSchema,
  trainingRunListQuerySchema,
  type TrainingRunListResponse,
  type TrainingRunSummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { LearningTrainingService } from './learning-training.service';

class TrainingRunCreateDto extends createZodDto(
  trainingRunCreateRequestSchema,
) {}
class TrainingRunListQueryDto extends createZodDto(
  trainingRunListQuerySchema,
) {}

/** owner/admin 전용 학습 실행 제어 평면. */
@Controller('learning/training-runs')
export class LearningTrainingController {
  constructor(private readonly trainingService: LearningTrainingService) {}

  /** 준비도 게이트를 통과한 승인 snapshot의 실행 요청을 생성한다. */
  @Post()
  createRun(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TrainingRunCreateDto,
  ): Promise<TrainingRunSummary> {
    return this.trainingService.requestRun(user.userId, dto);
  }

  /** household 학습 실행 이력을 object key 없이 조회한다. */
  @Get()
  async listRuns(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TrainingRunListQueryDto,
  ): Promise<TrainingRunListResponse> {
    return {
      items: await this.trainingService.listRuns(user.userId, query),
    };
  }
}
