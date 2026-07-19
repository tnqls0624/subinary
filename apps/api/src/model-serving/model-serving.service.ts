import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  EmbeddingProvider,
  GenerateRequest,
  GenerateResponse,
  LlmProvider,
  RerankerProvider,
} from '@family/ai-providers';
import { executeLlmTraffic } from '@family/ai-providers';
import type { AppConfig } from '@family/config';
import {
  ModelAliasResolutionError,
  ModelTrafficResolutionError,
  modelAliasTraceMetadata,
  resolveModelAlias,
  resolveModelTrafficPolicy,
  type Db,
  type ResolvedModelAlias,
  type ResolvedModelTrafficPolicy,
} from '@family/database';
import { assignModelTraffic } from '@family/shared';

import { DB } from '../database/database.constants';

export interface ModelServingScope {
  workspaceId?: string;
  householdId?: string;
}

type RuntimeProvider = LlmProvider | EmbeddingProvider | RerankerProvider;

/** API AI 호출 직전 scope별 production alias와 runtime provider를 대조한다. */
@Injectable()
export class ModelServingService {
  private readonly logger = new Logger(ModelServingService.name);
  private readonly aliasRequired: boolean;
  private readonly embeddingModelRevision: string | undefined;
  private readonly candidateLlmModelRevision: string | undefined;
  private readonly fallbackWarnings = new Set<string>();
  private readonly trafficWarnings = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    configService: ConfigService,
  ) {
    const ai = configService.get<AppConfig['ai']>('ai');
    this.aliasRequired = ai?.modelAliasRequired ?? false;
    this.embeddingModelRevision = ai?.embeddingModelRevision;
    this.candidateLlmModelRevision = ai?.candidateLlmModelRevision;
  }

  async assertLlm(
    scope: ModelServingScope,
    task: string,
    provider: LlmProvider,
  ): Promise<ResolvedModelAlias> {
    return this.assertRuntime(scope, task, provider);
  }

  /**
   * production alias를 검증한 뒤 활성 정책에 따라 LLM을 결정적으로 실행한다.
   * shadow 후보 실패와 live 후보 실패는 모두 primary 호출로 격리한다.
   */
  async generateLlm(
    scope: ModelServingScope,
    task: string,
    routingKey: string,
    primaryProvider: LlmProvider,
    candidateProvider: LlmProvider | null,
    request: GenerateRequest,
  ): Promise<GenerateResponse> {
    const primary = await this.assertLlm(scope, task, primaryProvider);
    let policy: ResolvedModelTrafficPolicy | null = null;

    try {
      policy = await resolveModelTrafficPolicy(this.db, {
        primary,
        candidateRuntime:
          candidateProvider !== null &&
          this.candidateLlmModelRevision !== undefined
            ? {
                provider: candidateProvider.provider,
                model: candidateProvider.model,
                version: this.candidateLlmModelRevision,
              }
            : null,
      });
    } catch (error: unknown) {
      const code =
        error instanceof ModelTrafficResolutionError
          ? error.code
          : 'resolver_unavailable';
      this.warnTrafficFallback(task, code);
    }

    if (policy === null || candidateProvider === null) {
      return primaryProvider.generate({
        ...request,
        metadata: {
          ...request.metadata,
          ...modelAliasTraceMetadata(primary),
        },
      });
    }

    const assignment = assignModelTraffic({
      mode: policy.mode,
      trafficBasisPoints: policy.trafficBasisPoints,
      routingKey,
      routingSalt: policy.routingSalt,
    });
    const primaryRequest = this.withTrafficMetadata(
      request,
      primary,
      policy,
      assignment.bucket,
      'primary',
      assignment.selectedRole === 'primary',
    );

    if (!assignment.executeCandidate) {
      return primaryProvider.generate(primaryRequest);
    }

    const candidateRequest = this.withTrafficMetadata(
      request,
      primary,
      policy,
      assignment.bucket,
      'candidate',
      assignment.selectedRole === 'candidate',
    );
    return executeLlmTraffic({
      mode: policy.mode,
      executeCandidate: assignment.executeCandidate,
      primaryProvider,
      candidateProvider,
      primaryRequest,
      candidateRequest,
      onCandidateError: () => {
        this.logger.warn(
          `${policy.mode} candidate failed task=${task}; primary result preserved`,
        );
      },
    });
  }

  async assertEmbedding(
    scope: ModelServingScope,
    task: string,
    provider: EmbeddingProvider,
  ): Promise<ResolvedModelAlias> {
    return this.assertRuntime(
      scope,
      task,
      provider,
      provider.dimensions,
      this.embeddingModelRevision ?? provider.model,
    );
  }

  async assertReranker(
    scope: ModelServingScope,
    task: string,
    provider: RerankerProvider,
  ): Promise<ResolvedModelAlias> {
    return this.assertRuntime(scope, task, provider);
  }

  private async assertRuntime(
    scope: ModelServingScope,
    task: string,
    provider: RuntimeProvider,
    dimensions?: number,
    version?: string,
  ): Promise<ResolvedModelAlias> {
    try {
      const resolved = await resolveModelAlias(this.db, {
        ...scope,
        task,
        provider: provider.provider,
        model: provider.model,
        ...(version !== undefined ? { version } : {}),
        ...(dimensions !== undefined ? { dimensions } : {}),
        required: this.aliasRequired,
      });
      if (
        resolved.source === 'configuration' &&
        !this.fallbackWarnings.has(task)
      ) {
        this.fallbackWarnings.add(task);
        this.logger.warn(
          `model alias missing for task=${task}; using configured provider`,
        );
      }
      return resolved;
    } catch (error: unknown) {
      const code =
        error instanceof ModelAliasResolutionError
          ? error.code
          : 'resolver_unavailable';
      throw new ServiceUnavailableException(
        `model serving unavailable: ${code}`,
      );
    }
  }

  private withTrafficMetadata(
    request: GenerateRequest,
    primary: ResolvedModelAlias,
    policy: ResolvedModelTrafficPolicy,
    bucket: number,
    role: 'primary' | 'candidate',
    selected: boolean,
  ): GenerateRequest {
    const primaryTrace = modelAliasTraceMetadata(primary);
    return {
      ...request,
      metadata: {
        ...request.metadata,
        ...primaryTrace,
        modelRegistryId:
          role === 'candidate'
            ? policy.candidateModelRegistryId
            : primaryTrace.modelRegistryId,
        trafficPolicyId: policy.id,
        trafficMode: policy.mode,
        trafficRole: role,
        trafficBucket: bucket,
        trafficSelected: selected,
      },
    };
  }

  private warnTrafficFallback(task: string, code: string): void {
    const warningKey = `${task}:${code}`;
    if (this.trafficWarnings.has(warningKey)) {
      return;
    }
    this.trafficWarnings.add(warningKey);
    this.logger.warn(
      `model traffic unavailable task=${task} code=${code}; using primary provider`,
    );
  }
}
