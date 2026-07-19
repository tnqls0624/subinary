import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  evaluationRunCreateRequestSchema,
  modelCanaryEvaluateRequestSchema,
  modelAliasRollbackRequestSchema,
  modelApprovalRequestSchema,
  modelPromotionRequestSchema,
  modelRegistryCreateRequestSchema,
  modelRegistryListQuerySchema,
  modelTrafficPolicyCreateRequestSchema,
  modelTrafficPolicyPauseRequestSchema,
  type EvaluationRunSummary,
  type ModelCanaryEvaluationSummary,
  type ModelAliasSummary,
  type ModelRegistryListResponse,
  type ModelRegistrySummary,
  type ModelTrafficPolicySummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { LearningModelService } from './learning-model.service';

class ModelRegistryCreateDto extends createZodDto(
  modelRegistryCreateRequestSchema,
) {}
class ModelRegistryListQueryDto extends createZodDto(
  modelRegistryListQuerySchema,
) {}
class EvaluationRunCreateDto extends createZodDto(
  evaluationRunCreateRequestSchema,
) {}
class ModelApprovalDto extends createZodDto(modelApprovalRequestSchema) {}
class ModelPromotionDto extends createZodDto(modelPromotionRequestSchema) {}
class ModelAliasScopeDto extends createZodDto(
  modelAliasRollbackRequestSchema,
) {}
class ModelCanaryEvaluateDto extends createZodDto(
  modelCanaryEvaluateRequestSchema,
) {}
class ModelTrafficPolicyCreateDto extends createZodDto(
  modelTrafficPolicyCreateRequestSchema,
) {}
class ModelTrafficPolicyPauseDto extends createZodDto(
  modelTrafficPolicyPauseRequestSchema,
) {}
class ModelParamDto extends createZodDto(
  z.object({ modelId: z.string().uuid() }),
) {}
class AliasParamDto extends createZodDto(
  z.object({ alias: z.string().trim().min(1).max(100) }),
) {}
class TrafficPolicyParamDto extends createZodDto(
  z.object({ policyId: z.string().uuid() }),
) {}

/** owner/admin 전용 offline 평가와 모델 승격 제어 평면 API. */
@Controller('learning')
export class LearningModelController {
  constructor(private readonly modelService: LearningModelService) {}

  @Post('models')
  registerModel(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ModelRegistryCreateDto,
  ): Promise<ModelRegistrySummary> {
    return this.modelService.registerModel(user.userId, dto);
  }

  @Get('models')
  async listModels(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ModelRegistryListQueryDto,
  ): Promise<ModelRegistryListResponse> {
    return { items: await this.modelService.listModels(user.userId, query) };
  }

  @Post('evaluations')
  recordEvaluation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EvaluationRunCreateDto,
  ): Promise<EvaluationRunSummary> {
    return this.modelService.recordEvaluation(user.userId, dto);
  }

  @Post('models/:modelId/approve')
  approveModel(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ModelParamDto,
    @Body() dto: ModelApprovalDto,
  ): Promise<ModelRegistrySummary> {
    return this.modelService.approveModel(user.userId, params.modelId, dto);
  }

  @Post('models/:modelId/promote')
  promoteModel(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ModelParamDto,
    @Body() dto: ModelPromotionDto,
  ): Promise<ModelAliasSummary> {
    return this.modelService.promoteModel(user.userId, params.modelId, dto);
  }

  @Get('model-aliases/:alias')
  getAlias(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: AliasParamDto,
    @Query() query: ModelAliasScopeDto,
  ): Promise<ModelAliasSummary> {
    return this.modelService.getAlias(user.userId, params.alias, query);
  }

  @Post('model-aliases/:alias/rollback')
  rollbackAlias(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: AliasParamDto,
    @Body() dto: ModelAliasScopeDto,
  ): Promise<ModelAliasSummary> {
    return this.modelService.rollbackAlias(user.userId, params.alias, dto);
  }

  @Post('model-aliases/:alias/canary/evaluate')
  evaluateCanary(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: AliasParamDto,
    @Body() dto: ModelCanaryEvaluateDto,
  ): Promise<ModelCanaryEvaluationSummary> {
    return this.modelService.evaluateCanary(user.userId, params.alias, dto);
  }

  @Post('model-traffic-policies')
  createTrafficPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ModelTrafficPolicyCreateDto,
  ): Promise<ModelTrafficPolicySummary> {
    return this.modelService.createTrafficPolicy(user.userId, dto);
  }

  @Post('model-traffic-policies/:policyId/pause')
  pauseTrafficPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: TrafficPolicyParamDto,
    @Body() dto: ModelTrafficPolicyPauseDto,
  ): Promise<ModelTrafficPolicySummary> {
    return this.modelService.pauseTrafficPolicy(
      user.userId,
      params.policyId,
      dto,
    );
  }
}
