/**
 * LLM 가맹점 카테고리 제안 프로세서 (`category-suggest` 큐).
 *
 * 승격 파이프라인이 카테고리를 null 로 결정한 거래의 가맹점을 **가맹점 단위 1회**
 * (jobId `catsug_${householdId}_${md5(merchantNormalized)}`, 콜론 금지)로 받아,
 * LLM 에게 시스템 카테고리 slug 하나를 제안받는다. 채택되면
 * `merchant_category_rules` 에 upsert 해 자가학습하고, 같은 household·같은
 * merchantNormalized 의 미분류 거래를 일괄 분류한다.
 *
 * 규약(절대):
 * - **LLM 실패 = 결정적 폴백.** LLM 호출 실패 / JSON 파싱 실패 / 목록에 없는 slug
 *   응답은 잡을 실패시키지 않고 **조용히 종료(미분류 유지)** 한다. Mock LLM 은
 *   JSON 을 반환하지 않으므로 AI_PROVIDER=mock 에서는 항상 이 폴백 경로가 실행되고
 *   파이프라인이 무해하게 통과한다.
 * - provider 는 `createProviders(config.ai)` 로만 접근한다(rag-index 패턴).
 * - 경쟁 방지: 이미 (householdId, merchantNormalized) 규칙이 있으면 스킵하고,
 *   upsert 는 `onConflictDoNothing`(사용자 규칙이 항상 이긴다).
 * - 로그에는 가맹점 원문/프롬프트/응답 원문을 남기지 않는다 — 식별자와
 *   정규화명 md5 해시(일부), 결과 상태만.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createProviders,
  instrumentProviders,
  type LlmProvider,
} from '@family/ai-providers';
import type { AppConfig } from '@family/config';
import {
  createDbAiInvocationObserver,
  schema,
  trackPipelineExecution,
  type Db,
} from '@family/database';
import { createLogger, MODEL_SERVING_TASKS, QUEUE_NAMES } from '@family/shared';
import type { Job } from 'bullmq';
import { and, eq, isNull, or } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { DB } from '../database/database.module';
import { LocalMerchantClassifierService } from '../model-serving/local-merchant-classifier.service';
import { WorkerModelServingService } from '../model-serving/model-serving.service';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';

/** category-suggest 잡 payload(승격 파이프라인이 enqueue). */
interface CategorySuggestJobData {
  householdId: string;
  merchantNormalized: string;
  merchantRaw: string;
}

/**
 * 잡 결과(모두 "성공" 종료 — LLM 실패/무효 응답도 폴백이지 에러가 아니다).
 * - `rule_exists`: 규칙이 이미 있어 스킵(경쟁 방지).
 * - `llm_failed`: LLM 호출 자체가 실패 → 미분류 유지.
 * - `no_valid_suggestion`: 응답에서 유효한 시스템 slug 를 얻지 못함(미분류 유지).
 *   Mock LLM 은 JSON 을 주지 않으므로 mock 검증에서는 항상 이 경로다.
 * - `category_missing`: slug 는 유효하나 시스템 카테고리 시드가 없음(미분류 유지).
 * - `classified`: 규칙 저장 + 미분류 거래 일괄 분류 완료.
 */
type CategorySuggestJobResult = {
  householdId: string;
  merchantHash: string;
  outcome:
    | 'rule_exists'
    | 'llm_failed'
    | 'no_valid_suggestion'
    | 'category_missing'
    | 'classified';
  slug?: string;
  updatedTransactionCount?: number;
};

/** LLM 응답 상한(JSON {"slug":"..."} 한 줄이면 충분 — 비용/지연 최소화). */
const SUGGEST_MAX_TOKENS = 64;

/** 로그용 가맹점 해시(원문 미기록 정책). md5 hex 앞 12자만 사용한다. */
function merchantHashOf(merchantNormalized: string): string {
  return createHash('md5')
    .update(merchantNormalized)
    .digest('hex')
    .slice(0, 12);
}

/** feedback 상관키. 로그용 축약 hash와 달리 충돌 위험을 낮춘 SHA-256 전체값이다. */
function merchantFeedbackTargetId(
  householdId: string,
  merchantNormalized: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([householdId, merchantNormalized]), 'utf8')
    .digest('hex');
}

/**
 * LLM 응답 텍스트에서 관대한 JSON 추출로 slug 를 뽑는다.
 * 텍스트 중 첫 `{...}` 매치를 JSON.parse 하고 `slug` 문자열을 반환한다.
 * 매치 없음/파싱 실패/slug 비문자열은 모두 null(폴백 경로).
 */
function extractSlug(text: string): string | null {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { slug?: unknown }).slug === 'string'
    ) {
      return (parsed as { slug: string }).slug;
    }
  } catch {
    // 파싱 실패 → 폴백(미분류 유지). 원문은 로그하지 않는다.
  }
  return null;
}

@Processor(QUEUE_NAMES.CATEGORY_SUGGEST)
export class CategorySuggestProcessor extends WorkerHost {
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly llm: LlmProvider;
  private readonly candidateLlm: LlmProvider | null;

  constructor(
    @Inject(DB) private readonly db: Db,
    configService: ConfigService,
    private readonly localClassifier: LocalMerchantClassifierService,
    private readonly modelServing: WorkerModelServingService,
    private readonly realtimePublisher: RealtimePublisherService,
  ) {
    super();
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:category-suggest-processor', {
      pretty: nodeEnv !== 'production',
    });
    // Provider 는 설정(config.ai)으로부터 생성한다(rag-index 패턴, fetch 직접 호출 금지).
    const ai = configService.get<AppConfig['ai']>('ai');
    const providers = instrumentProviders(
      createProviders({
        provider: ai?.provider ?? 'mock',
        ...(ai?.geminiApiKey !== undefined
          ? { geminiApiKey: ai.geminiApiKey }
          : {}),
        ...(ai?.llmModel !== undefined ? { llmModel: ai.llmModel } : {}),
        strict: nodeEnv === 'production',
      }),
      {
        observer: createDbAiInvocationObserver(this.db),
        defaultTask: 'worker-ai',
      },
    );
    this.llm = providers.llm;
    if (
      ai?.candidateProvider !== undefined &&
      ai.candidateLlmModel !== undefined &&
      ai.candidateLlmModelRevision !== undefined
    ) {
      this.candidateLlm = instrumentProviders(
        createProviders({
          provider: ai.candidateProvider,
          llmModel: ai.candidateLlmModel,
          ...(ai.candidateGeminiApiKey !== undefined ||
          ai.geminiApiKey !== undefined
            ? {
                geminiApiKey: ai.candidateGeminiApiKey ?? ai.geminiApiKey,
              }
            : {}),
          strict: nodeEnv === 'production',
        }),
        {
          observer: createDbAiInvocationObserver(this.db),
          defaultTask: 'worker-ai-candidate',
        },
      ).llm;
    } else {
      this.candidateLlm = null;
    }
  }

  async process(
    job: Job<CategorySuggestJobData>,
  ): Promise<CategorySuggestJobResult> {
    return trackPipelineExecution(
      this.db,
      {
        pipelineName: 'category-suggest',
        pipelineVersion: 'category-suggest-v2',
        stepName: 'llm-suggest-and-apply',
        stepVersion: 'llm-suggest-and-apply-v2',
        trigger: 'bullmq',
        scopeType: 'household',
        scopeId: job.data.householdId || 'missing',
        externalRunId: String(job.id ?? 'unknown'),
        attempt: job.attemptsMade + 1,
        maximumAttempts: job.opts?.attempts ?? 1,
        summarize: (result) => ({
          inputCount: 1,
          outputCount: result.outcome === 'classified' ? 1 : 0,
          rejectedCount:
            result.outcome === 'llm_failed' ||
            result.outcome === 'no_valid_suggestion' ||
            result.outcome === 'category_missing'
              ? 1
              : 0,
          metrics: {
            outcome: result.outcome,
            updatedTransactionCount: result.updatedTransactionCount ?? 0,
          },
        }),
      },
      ({ pipelineRunId }) => this.processTracked(job, pipelineRunId),
    );
  }

  /** 실제 분류 처리. 바깥 wrapper가 실행 상태와 AI trace 상관키를 관리한다. */
  private async processTracked(
    job: Job<CategorySuggestJobData>,
    pipelineRunId: string,
  ): Promise<CategorySuggestJobResult> {
    const { householdId, merchantNormalized, merchantRaw } = job.data;

    if (!householdId || !merchantNormalized) {
      // 방어: payload 결손은 재시도해도 무의미하므로 즉시 실패시킨다(민감정보 없음).
      this.logger.warn(
        { jobId: job.id, queue: job.queueName },
        'category-suggest job missing householdId/merchantNormalized',
      );
      throw new Error(
        'category-suggest job payload is missing householdId or merchantNormalized',
      );
    }

    const merchantHash = merchantHashOf(merchantNormalized);
    const base = { householdId, merchantHash };

    // ① 이미 규칙이 있으면 스킵(경쟁 방지 — 사용자/이전 제안 규칙이 이긴다).
    const [existingRule] = await this.db
      .select({ id: schema.merchantCategoryRules.id })
      .from(schema.merchantCategoryRules)
      .where(
        and(
          eq(schema.merchantCategoryRules.householdId, householdId),
          eq(schema.merchantCategoryRules.merchantPattern, merchantNormalized),
        ),
      )
      .limit(1);
    if (existingRule) {
      this.logger.info(
        { jobId: job.id, ...base, outcome: 'rule_exists' },
        'category suggestion skipped: rule already exists',
      );
      return { ...base, outcome: 'rule_exists' };
    }

    // 후보 카테고리 = 시스템 + 이 가족의 커스텀. 커스텀도 AI가 고를 수 있도록
    // 하드코딩(DEFAULT_CATEGORIES) 대신 DB에서 후보 목록/검증·해석 맵을 동적으로 만든다.
    const candidates = await this.db
      .select({
        id: schema.expenseCategories.id,
        slug: schema.expenseCategories.slug,
        name: schema.expenseCategories.name,
      })
      .from(schema.expenseCategories)
      .where(
        or(
          isNull(schema.expenseCategories.householdId),
          eq(schema.expenseCategories.householdId, householdId),
        ),
      );
    const idBySlug = new Map(candidates.map((c) => [c.slug, c.id]));

    // ② 승인된 로컬 production alias가 있으면 checksum 검증된 학습 artifact를
    // 먼저 실행한다. alias가 없을 때만 기존 LLM 경로를 사용한다.
    const localPrediction = await this.localClassifier.predict(
      householdId,
      merchantNormalized,
      pipelineRunId,
    );
    let slug: string | null;
    let categoryId: string | undefined;
    let predictionTraceId: string | null = null;
    if (localPrediction !== null) {
      slug = localPrediction.categorySlug;
      categoryId = idBySlug.get(slug);
      predictionTraceId = localPrediction.traceId;
      if (categoryId !== localPrediction.categoryId) {
        throw new Error('local merchant model category is unavailable');
      }
    } else {
      // LLM 호출 실패는 기존 정책대로 잡 실패가 아닌 결정적 폴백이다.
      const slugList = candidates
        .map((candidate) => `${candidate.slug}(${candidate.name})`)
        .join(', ');
      let responseText: string;
      try {
        const response = await this.modelServing.generateLlm(
          { householdId },
          MODEL_SERVING_TASKS.MERCHANT_CATEGORY,
          merchantHash,
          this.llm,
          this.candidateLlm,
          {
            system:
              '당신은 한국 가계부 카테고리 분류기입니다. 가맹점명을 보고 주어진 slug 목록에서 ' +
              '가장 알맞은 카테고리 slug 하나를 고르세요. 반드시 JSON {"slug":"..."} 형식만 출력하세요.',
            prompt: [
              `가맹점명: ${merchantRaw || merchantNormalized}`,
              `카테고리 slug 목록: ${slugList}`,
              '위 목록에 있는 slug 하나만 골라 JSON {"slug":"..."}만 출력하세요.',
            ].join('\n'),
            temperature: 0,
            maxTokens: SUGGEST_MAX_TOKENS,
            metadata: {
              task: 'category-suggest',
              promptVersion: 'merchant-category-v1',
              pipelineRunId,
            },
          },
        );
        responseText = response.text;
        predictionTraceId = response.traceId ?? null;
      } catch {
        // LLM 호출 실패 — 프롬프트/에러 원문은 로그하지 않는다. 미분류 유지.
        this.logger.warn(
          { jobId: job.id, ...base, outcome: 'llm_failed' },
          'category suggestion fallback: llm call failed; leaving unclassified',
        );
        return { ...base, outcome: 'llm_failed' };
      }
      slug = extractSlug(responseText);
      categoryId = slug !== null ? idBySlug.get(slug) : undefined;
    }

    // ③ 로컬 모델/LLM 결과가 현재 household 카테고리와 일치할 때만 적용한다.
    if (slug === null || categoryId === undefined) {
      this.logger.info(
        { jobId: job.id, ...base, outcome: 'no_valid_suggestion' },
        'category suggestion fallback: no valid slug in llm response; leaving unclassified',
      );
      return { ...base, outcome: 'no_valid_suggestion' };
    }

    // 규칙 upsert + 미분류 거래 일괄 분류(원자적). onConflictDoNothing 으로 경쟁 시
    // 기존(예: 사용자) 규칙을 덮어쓰지 않고, 그 규칙의 categoryId 로 일괄 분류한다.
    const updatedTransactionCount = await this.db.transaction(async (tx) => {
      const now = new Date();
      // AI 제안은 학습 gold가 아니라 model_prediction feedback으로만 남긴다.
      // target은 가맹점 원문 대신 동일한 SHA-256 상관키를 사용한다.
      await tx.insert(schema.feedbackEvents).values({
        householdId,
        targetType: 'merchant-category',
        targetId: merchantFeedbackTargetId(householdId, merchantNormalized),
        predictionTraceId,
        labelSchemaVersion: 'merchant-category-v1',
        label: { categoryId, slug },
        source: 'model_prediction',
        actorUserId: null,
        occurredAt: now,
      });
      const [insertedRule] = await tx
        .insert(schema.merchantCategoryRules)
        .values({
          householdId,
          merchantPattern: merchantNormalized,
          categoryId,
          source: 'model_prediction',
          predictionTraceId,
          confirmedAt: null,
          // LLM 제안 규칙은 특정 사용자가 만든 것이 아니다.
          createdBy: null,
        })
        .onConflictDoNothing({
          target: [
            schema.merchantCategoryRules.householdId,
            schema.merchantCategoryRules.merchantPattern,
          ],
        })
        .returning({ categoryId: schema.merchantCategoryRules.categoryId });

      let effectiveCategoryId = insertedRule?.categoryId;
      if (effectiveCategoryId === undefined) {
        // ①과 upsert 사이 경쟁으로 다른 규칙이 먼저 생성됨 — 그 규칙을 진실로 삼는다.
        const [winner] = await tx
          .select({ categoryId: schema.merchantCategoryRules.categoryId })
          .from(schema.merchantCategoryRules)
          .where(
            and(
              eq(schema.merchantCategoryRules.householdId, householdId),
              eq(
                schema.merchantCategoryRules.merchantPattern,
                merchantNormalized,
              ),
            ),
          )
          .limit(1);
        effectiveCategoryId = winner?.categoryId;
      }
      if (effectiveCategoryId === undefined) {
        return 0;
      }

      const updated = await tx
        .update(schema.cardTransactions)
        .set({ categoryId: effectiveCategoryId, updatedAt: now })
        .where(
          and(
            eq(schema.cardTransactions.householdId, householdId),
            eq(schema.cardTransactions.merchantNormalized, merchantNormalized),
            isNull(schema.cardTransactions.categoryId),
          ),
        )
        .returning({ id: schema.cardTransactions.id });
      return updated.length;
    });

    // 로그는 식별자/해시/slug/건수만(가맹점 원문·프롬프트·응답 원문 미기록).
    this.logger.info(
      {
        jobId: job.id,
        ...base,
        outcome: 'classified',
        slug,
        updatedTransactionCount,
      },
      'category suggestion applied',
    );
    // 카테고리 소급 분류가 화면에 반영되도록 실시간 힌트 발행(best-effort,
    // fire-and-forget — 잡 처리 지연 방지).
    if (updatedTransactionCount > 0) {
      void this.realtimePublisher.publish(householdId, 'categories.changed');
    }
    return { ...base, outcome: 'classified', slug, updatedTransactionCount };
  }
}
