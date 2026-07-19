import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  memoryCandidateDatasetCreateRequestSchema,
  merchantCategoryDatasetCreateRequestSchema,
  datasetSnapshotRevokeRequestSchema,
  ragEmbeddingDatasetCreateRequestSchema,
  ragRetrievalFeedbackCreateRequestSchema,
  learningScopeSchema,
  type DatasetSnapshotApprovalResponse,
  type DatasetSnapshotRevokeResponse,
  type DatasetSnapshotListResponse,
  type DatasetSnapshotSummary,
  type RagRetrievalFeedbackResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { LearningDatasetService } from './learning-dataset.service';
import { LearningMerchantDatasetService } from './learning-merchant-dataset.service';
import { LearningRagDatasetService } from './learning-rag-dataset.service';

class MemoryCandidateDatasetCreateDto extends createZodDto(
  memoryCandidateDatasetCreateRequestSchema,
) {}

class DatasetListQueryDto extends createZodDto(learningScopeSchema) {}
class MerchantCategoryDatasetCreateDto extends createZodDto(
  merchantCategoryDatasetCreateRequestSchema,
) {}
class RagRetrievalFeedbackCreateDto extends createZodDto(
  ragRetrievalFeedbackCreateRequestSchema,
) {}
class RagEmbeddingDatasetCreateDto extends createZodDto(
  ragEmbeddingDatasetCreateRequestSchema,
) {}
class DatasetSnapshotParamDto extends createZodDto(
  z.object({ datasetSnapshotId: z.string().uuid() }),
) {}
class DatasetSnapshotRevokeDto extends createZodDto(
  datasetSnapshotRevokeRequestSchema,
) {}

/** workspace owner/household owner·admin 데이터셋 API. artifact는 노출하지 않는다. */
@Controller('learning')
export class LearningDatasetController {
  constructor(
    private readonly learningDatasetService: LearningDatasetService,
    private readonly merchantDatasetService: LearningMerchantDatasetService,
    private readonly ragDatasetService: LearningRagDatasetService,
  ) {}

  /** 승인된 memory candidate feedback으로 immutable snapshot을 생성한다. */
  @Post('datasets/memory-candidate')
  createMemoryCandidateSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MemoryCandidateDatasetCreateDto,
  ): Promise<DatasetSnapshotSummary> {
    return this.learningDatasetService.createMemoryCandidateSnapshot(
      user.userId,
      dto,
    );
  }

  /** 사람 확정 가맹점 규칙으로 household-only Gold snapshot을 생성한다. */
  @Post('datasets/merchant-category')
  createMerchantCategorySnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MerchantCategoryDatasetCreateDto,
  ): Promise<DatasetSnapshotSummary> {
    return this.merchantDatasetService.createSnapshot(user.userId, dto);
  }

  /** owner가 질의–관련 청크 pair를 명시적 동의와 함께 확정한다. */
  @Post('feedback/rag-retrieval')
  createRagRetrievalFeedback(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RagRetrievalFeedbackCreateDto,
  ): Promise<RagRetrievalFeedbackResponse> {
    return this.ragDatasetService.recordFeedback(user.userId, dto);
  }

  /** 확정 검색 관련성 피드백으로 rag-embedding 평가 snapshot을 생성한다. */
  @Post('datasets/rag-embedding')
  createRagEmbeddingSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RagEmbeddingDatasetCreateDto,
  ): Promise<DatasetSnapshotSummary> {
    return this.ragDatasetService.createSnapshot(user.userId, dto);
  }

  /** 단일 workspace/household의 snapshot 메타데이터를 최신순으로 조회한다. */
  @Get('datasets')
  async listSnapshots(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DatasetListQueryDto,
  ): Promise<DatasetSnapshotListResponse> {
    return {
      items: query.workspaceId
        ? await this.learningDatasetService.listSnapshots(
            user.userId,
            query.workspaceId,
          )
        : await this.merchantDatasetService.listSnapshots(
            user.userId,
            query.householdId!,
          ),
    };
  }

  /** 검증된 immutable snapshot을 offline 평가에 사용할 수 있도록 승인한다. */
  @Post('datasets/:datasetSnapshotId/approve')
  approveSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: DatasetSnapshotParamDto,
  ): Promise<DatasetSnapshotApprovalResponse> {
    return this.learningDatasetService.approveSnapshot(
      user.userId,
      params.datasetSnapshotId,
    );
  }

  /** 개인정보 철회 시 dataset·평가·학습 artifact를 revoke하고 storage에서 삭제한다. */
  @Post('datasets/:datasetSnapshotId/revoke')
  revokeSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: DatasetSnapshotParamDto,
    @Body() dto: DatasetSnapshotRevokeDto,
  ): Promise<DatasetSnapshotRevokeResponse> {
    return this.learningDatasetService.revokeSnapshot(
      user.userId,
      params.datasetSnapshotId,
      dto.reason,
    );
  }
}
