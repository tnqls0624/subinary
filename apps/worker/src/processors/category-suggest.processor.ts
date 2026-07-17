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
import { createProviders, type LlmProvider } from '@family/ai-providers';
import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';
import { createLogger, DEFAULT_CATEGORIES, QUEUE_NAMES } from '@family/shared';
import type { Job } from 'bullmq';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { DB } from '../database/database.module';

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

/** 시스템 카테고리 slug 집합(이 밖의 slug 는 무효 → 미분류 유지). */
const SYSTEM_SLUGS = new Set(DEFAULT_CATEGORIES.map((c) => c.slug));

/** 로그용 가맹점 해시(원문 미기록 정책). md5 hex 앞 12자만 사용한다. */
function merchantHashOf(merchantNormalized: string): string {
  return createHash('md5').update(merchantNormalized).digest('hex').slice(0, 12);
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

  constructor(
    @Inject(DB) private readonly db: Db,
    configService: ConfigService,
  ) {
    super();
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:category-suggest-processor', {
      pretty: nodeEnv !== 'production',
    });
    // Provider 는 설정(config.ai)으로부터 생성한다(rag-index 패턴, fetch 직접 호출 금지).
    const ai = configService.get<AppConfig['ai']>('ai');
    const providers = createProviders({
      provider: ai?.provider ?? 'mock',
      ...(ai?.geminiApiKey !== undefined ? { geminiApiKey: ai.geminiApiKey } : {}),
      ...(ai?.llmModel !== undefined ? { llmModel: ai.llmModel } : {}),
    });
    this.llm = providers.llm;
  }

  async process(job: Job<CategorySuggestJobData>): Promise<CategorySuggestJobResult> {
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

    // ② LLM 호출. 실패는 잡 실패가 아니라 결정적 폴백(미분류 유지)이다.
    const slugList = DEFAULT_CATEGORIES.map((c) => `${c.slug}(${c.name})`).join(', ');
    let responseText: string;
    try {
      const response = await this.llm.generate({
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
      });
      responseText = response.text;
    } catch {
      // LLM 호출 실패 — 프롬프트/에러 원문은 로그하지 않는다. 미분류 유지.
      this.logger.warn(
        { jobId: job.id, ...base, outcome: 'llm_failed' },
        'category suggestion fallback: llm call failed; leaving unclassified',
      );
      return { ...base, outcome: 'llm_failed' };
    }

    // ③ 관대한 JSON 추출 → 시스템 slug 검증. 무효면 조용히 종료(미분류 유지).
    //    Mock LLM 은 JSON 을 반환하지 않으므로 mock 검증에서는 항상 이 폴백이 실행된다.
    const slug = extractSlug(responseText);
    if (slug === null || !SYSTEM_SLUGS.has(slug)) {
      this.logger.info(
        { jobId: job.id, ...base, outcome: 'no_valid_suggestion' },
        'category suggestion fallback: no valid slug in llm response; leaving unclassified',
      );
      return { ...base, outcome: 'no_valid_suggestion' };
    }

    // ④ slug → 시스템 카테고리 id 해석(householdId IS NULL 시드, 승격 키워드 tier 와 동일).
    const [category] = await this.db
      .select({ id: schema.expenseCategories.id })
      .from(schema.expenseCategories)
      .where(
        and(
          eq(schema.expenseCategories.slug, slug),
          isNull(schema.expenseCategories.householdId),
        ),
      )
      .limit(1);
    if (!category) {
      // 시드 누락 등 — 제안은 유효하나 적용 불가. 미분류 유지(잡 실패 아님).
      this.logger.warn(
        { jobId: job.id, ...base, outcome: 'category_missing', slug },
        'category suggestion fallback: system category not found; leaving unclassified',
      );
      return { ...base, outcome: 'category_missing', slug };
    }

    // 규칙 upsert + 미분류 거래 일괄 분류(원자적). onConflictDoNothing 으로 경쟁 시
    // 기존(예: 사용자) 규칙을 덮어쓰지 않고, 그 규칙의 categoryId 로 일괄 분류한다.
    const updatedTransactionCount = await this.db.transaction(async (tx) => {
      const now = new Date();
      const [insertedRule] = await tx
        .insert(schema.merchantCategoryRules)
        .values({
          householdId,
          merchantPattern: merchantNormalized,
          categoryId: category.id,
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
              eq(schema.merchantCategoryRules.merchantPattern, merchantNormalized),
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
      { jobId: job.id, ...base, outcome: 'classified', slug, updatedTransactionCount },
      'category suggestion applied',
    );
    return { ...base, outcome: 'classified', slug, updatedTransactionCount };
  }
}
