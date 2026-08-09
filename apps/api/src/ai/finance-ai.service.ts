/**
 * Finance AI service — 자연어 가계부 질의 + 월간 인사이트/예산 코칭.
 *
 * 절대 규약(#1): LLM 호출 실패 / JSON 파싱 실패 / 무효 응답이 파이프라인을
 * 절대 중단시키지 않는다. 모든 LLM 단계에는 결정적 폴백이 있다:
 *  - 의도 추출 실패 → 정규식/부분일치 휴리스틱 (`extractIntentHeuristically`)
 *  - 답변 생성 실패 → 집계값 직접 포맷 템플릿 (`templateAnswer`)
 *  - 인사이트 문구 다듬기 실패 → 서버 계산 사실 문구 그대로 사용
 * AI_PROVIDER=mock에서는 LLM이 JSON을 내놓지 않으므로 두 흐름 모두
 * `method: 'fallback'`으로 완주한다(검증 스크립트가 이 경로를 확인한다).
 *
 * 수치는 전부 서버가 계산한다: 집계는 {@link AnalyticsService}의 SQL 집계
 * (household 멤버십 403 + 공개범위 스코프 포함)를 재사용하고, LLM은 수치를
 * 만들거나 계산하지 않는다(문장화만 담당).
 *
 * 로그 정책: 질문 원문/가맹점명/금액/프롬프트를 로그에 남기지 않는다 —
 * 식별자·경로(method)·건수만 남긴다.
 *
 * 정직한 거부(로드맵 C-6 / PO B8): 지원하는 집계 축(총지출·카테고리·가맹점)을
 * 하나도 알아보지 못한 질문에는 **월 총지출로 때우지 않고 명시적으로 거부**한다
 * (`refused: true` + 물어볼 수 있는 예시). 경계 판정은 순수 모듈
 * {@link ./finance-intent}에 있고, 거부 기준은 "분류 경로"가 아니라 "분류 결과"다
 * — LLM이 한 번 흔들렸다고 답할 수 있는 질문까지 거부하지 않는다.
 *
 * 관측(로드맵 C-6): 질의 1건 = `pipeline_runs`/`pipeline_step_runs` 1건으로 남겨
 * 거부율·폴백율을 SQL로 셀 수 있게 한다. 원문은 담지 않고 집계 축·거부 여부·거부
 * 갈래만 `metrics`에 남긴다.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { ProviderSet } from '@family/ai-providers';
import type {
  FinanceQueryData,
  FinanceQueryItem,
  FinanceQueryResponse,
  MonthlyInsight,
  MonthlyInsightsResponse,
} from '@family/contracts';
import {
  schema,
  trackPipelineExecution,
  type Db,
  notTransferCategory,
  redactedMerchantLabel,
  spendPeriodWindow,
  visibilityScope,
} from '@family/database';
import { DEFAULT_CATEGORIES } from '@family/shared';

import { AnalyticsService } from '../analytics/analytics.service';
import { DB } from '../database/database.constants';
import { AI_PROVIDERS } from './ai.constants';
import {
  MONTH_PATTERN,
  REFUSAL_ANSWER,
  REFUSAL_SUGGESTIONS,
  classifyUnsupportedKind,
  currentSeoulMonth,
  extractIntentHeuristically,
  previousMonth,
  seoulMonthRange,
  type FinanceIntent,
  type ResolvedAggregate,
  type SupportedFinanceIntent,
  type UnsupportedKind,
} from './finance-intent';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** UUID v4-ish shape guard (query-string 파라미터 방어 — 잘못된 값은 400). */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** byCategory/byMerchant 응답 data.items 상위 노출 개수. */
const TOP_ITEMS = 5;

/** 전월 대비 카테고리 증감 인사이트 최대 개수(±20% 이상만). */
const TREND_TOP_N = 2;

/** 증감 인사이트 최소 변화율(±20%). */
const TREND_MIN_RATE = 0.2;

/** 이상 지출 판정 배수(월 평균 결제액의 3배 이상 단건). */
const ANOMALY_MULTIPLIER = 3;

/**
 * 예산 선형 외삽 시 월 경과율 하한. 월초(경과 0에 수렴)에는 외삽이 발산하므로
 * 최소 하루치(≈1/31)로 클램프해 결정적이고 온건한 예측을 유지한다.
 */
const MIN_ELAPSED_RATE = 1 / 31;

/** 타 구성원 summary_only 가맹점 마스킹 라벨(analytics.merchants와 동일). */
const LABEL_UNKNOWN_MERCHANT = '미확인 가맹점';

/** 예산 이름이 없을 때 스코프별 대체 라벨. */
const BUDGET_SCOPE_LABEL: Record<string, string> = {
  household: '가족 전체',
  member: '구성원',
  category: '카테고리',
  card: '카드',
};

/* -------------------------------------------------------------------------- */
/* LLM 출력 검증 스키마(무효 응답 → 폴백)                                        */
/* -------------------------------------------------------------------------- */

/** 시스템 카테고리 slug 집합(휴리스틱/LLM 의도 검증 공용). */
const KNOWN_SLUGS = new Set(DEFAULT_CATEGORIES.map((c) => c.slug));

/**
 * ① 의도 추출 LLM 출력 스키마. 벗어나면 휴리스틱 폴백.
 *
 * `'unsupported'`가 열거형에 있는 것이 핵심이다 — 없으면 LLM은 답할 수 없는
 * 질문에도 억지로 셋 중 하나를 고르고, 그 결과가 사용자에게는 "자신 있는 오답"이
 * 된다. 이 값은 내부 전용이라 응답 계약(`FinanceAggregateKind`)에는 나가지 않는다.
 */
const intentOutputSchema = z.object({
  month: z.string().regex(MONTH_PATTERN).optional().nullable(),
  categorySlug: z.string().optional().nullable(),
  aggregate: z.enum(['total', 'byCategory', 'byMerchant', 'unsupported']),
});

/** ③ 답변 생성 LLM 출력 스키마. 벗어나면 템플릿 폴백. */
const answerOutputSchema = z.object({ answer: z.string().min(1) });

/** 인사이트 문구 다듬기 LLM 출력 스키마(kind/순서 보존 검증은 별도). */
const polishedInsightsSchema = z.array(
  z.object({
    kind: z.enum(['trend', 'anomaly', 'budget']),
    message: z.string().min(1),
  }),
);

/** {@link FinanceAiService.financeQuery} 옵션. */
export interface FinanceQueryOptions {
  householdId: string;
  question: string;
}

/** {@link FinanceAiService.monthlyInsights} 옵션. */
export interface MonthlyInsightsOptions {
  householdId: string;
  month?: string;
}

@Injectable()
export class FinanceAiService {
  private readonly logger = new Logger(FinanceAiService.name);

  constructor(
    private readonly analytics: AnalyticsService,
    @Inject(DB) private readonly db: Db,
    @Inject(AI_PROVIDERS) private readonly providers: ProviderSet,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* 기능 1 — POST /v1/ai/finance-query                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * 자연어 가계부 질의: ① 의도 추출(LLM→휴리스틱) → ①' 미지원이면 **정직한 거부**
   * → ② SQL 집계(권한 검증 포함 analytics 재사용) → ③ 해요체 답변(LLM→템플릿).
   * `method`는 최종 답변을 만든 경로를 노출한다.
   *
   * 거부는 ② 앞에서 끝난다 — 답하지 않을 질문에 집계 쿼리를 돌릴 이유가 없다.
   */
  async financeQuery(
    userId: string,
    options: FinanceQueryOptions,
  ): Promise<FinanceQueryResponse> {
    const { householdId, question } = options;

    // 권한(403)은 관측 블록 **밖에서** 먼저 확인한다. 안에서 던지면
    // trackPipelineExecution이 이를 `pipeline_failed` critical 운영 알림으로
    // 승격시켜, 사용자의 잘못된 householdId 하나가 당직을 깨운다.
    await this.requireMembership(householdId, userId);

    // summarize는 execute가 끝난 뒤 같은 클로저에서 실행되므로, 응답에 실리지 않는
    // 관측 축(분류 경로·거부 갈래)을 여기에 담아 넘긴다.
    let telemetry: {
      intentMethod: 'llm' | 'fallback';
      answerMethod: 'llm' | 'fallback' | 'refusal';
      aggregate: ResolvedAggregate;
      refused: boolean;
      unsupportedKind: UnsupportedKind | null;
      categoryResolved: boolean;
    } | null = null;

    return trackPipelineExecution<FinanceQueryResponse>(
      this.db,
      {
        pipelineName: 'finance-query',
        pipelineVersion: 'v1',
        stepName: 'answer',
        stepVersion: 'finance-query-v1',
        trigger: 'api',
        scopeType: 'household',
        scopeId: householdId,
        summarize: (result) => ({
          inputCount: 1,
          outputCount: result.refused ? 0 : 1,
          // 거부를 rejected로 세면 "거부율 = rejected/input"이 SQL 한 줄이 된다.
          rejectedCount: result.refused ? 1 : 0,
          // 질문 원문은 절대 담지 않는다 — 지원 우선순위를 정하는 데 필요한
          // 구조(집계 축·거부 갈래)만 남긴다.
          metrics: telemetry ?? {},
        }),
      },
      async (context) => {
        // ① 의도 추출 — LLM(JSON 강제), 실패/무효 시 결정적 휴리스틱.
        let intent: FinanceIntent;
        let intentMethod: 'llm' | 'fallback';
        try {
          intent = await this.extractIntentViaLlm(question, context.pipelineRunId);
          intentMethod = 'llm';
        } catch {
          intent = extractIntentHeuristically(question);
          intentMethod = 'fallback';
        }

        // ①' 미지원 의도 → 거부. 총지출로 때우지 않는다(로드맵 C-6 / PO B8).
        const resolved = intent.aggregate;
        if (resolved === 'unsupported') {
          const unsupportedKind = classifyUnsupportedKind(question);
          telemetry = {
            intentMethod,
            answerMethod: 'refusal',
            aggregate: 'unsupported',
            refused: true,
            unsupportedKind,
            categoryResolved: false,
          };
          this.logger.log(
            `finance-query refused household=${householdId} ` +
              `intent=${intentMethod} kind=${unsupportedKind}`,
          );
          return {
            answer: REFUSAL_ANSWER,
            refused: true,
            suggestions: [...REFUSAL_SUGGESTIONS],
            method: intentMethod,
          };
        }

        // ② 집계 — analytics의 SQL 집계 재사용(공개범위 스코프 포함).
        //    권한 오류(403)는 그대로 전파한다(폴백 대상이 아님 — LLM 실패만 폴백).
        const data = await this.aggregate(userId, householdId, {
          month: intent.month,
          categorySlug: intent.categorySlug,
          aggregate: resolved,
        });

        // ③ 답변 생성 — LLM(JSON 강제), 실패/무효 시 집계값 직접 포맷 템플릿.
        let answer: string;
        let method: 'llm' | 'fallback';
        try {
          answer = await this.generateAnswerViaLlm(
            question,
            data,
            context.pipelineRunId,
          );
          method = 'llm';
        } catch {
          answer = this.templateAnswer(data);
          method = 'fallback';
        }

        telemetry = {
          intentMethod,
          answerMethod: method,
          aggregate: data.aggregate,
          refused: false,
          unsupportedKind: null,
          categoryResolved: data.categorySlug !== null,
        };

        // 로그는 식별자/경로/집계형태만(질문 원문·금액 미포함).
        this.logger.log(
          `finance-query answered household=${householdId} ` +
            `aggregate=${data.aggregate} month=${data.month} ` +
            `intent=${intentMethod} answer=${method}`,
        );

        return {
          answer,
          data,
          method,
          refused: false,
          suggestions: [],
        };
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 기능 2 — GET /v1/ai/monthly-insights                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * 월간 인사이트: 사실(전월 대비 증감·이상 지출·예산 소진 예측)은 전부 서버가
   * 결정적으로 계산하고, LLM은 문구만 다듬는다. LLM 실패 시 서버 계산 문구를
   * 그대로 반환한다(mock 경로). 데이터가 없으면 `insights: []`.
   */
  async monthlyInsights(
    userId: string,
    options: MonthlyInsightsOptions,
  ): Promise<MonthlyInsightsResponse> {
    const householdId = this.requireHouseholdId(options.householdId);
    const month = this.resolveMonth(options.month);

    // 멤버십 검증(403, 존재 여부 비공개 — analytics 권한 패턴과 동일) +
    // 이상 지출 쿼리의 공개범위 스코프에 쓸 actor memberId 확보.
    const actorMemberId = await this.requireMembership(householdId, userId);

    const previous = previousMonth(month);
    const [monthly, categories, prevCategories] = await Promise.all([
      this.analytics.monthly(userId, householdId, { month }),
      this.analytics.categories(userId, householdId, { month }),
      this.analytics.categories(userId, householdId, { month: previous }),
    ]);

    const facts: MonthlyInsight[] = [];

    // ── 사실 1: 전월 대비 카테고리 증감 상위 2(±20% 이상만) ────────────────
    facts.push(...buildTrendFacts(categories.items, prevCategories.items));

    // ── 사실 2: 이상 지출(월 평균 결제액의 3배 이상 단건, 최대 1건) ─────────
    const anomaly = await this.buildAnomalyFact(
      householdId,
      actorMemberId,
      month,
      monthly.totalNet,
      monthly.transactionCount,
    );
    if (anomaly) facts.push(anomaly);

    // ── 사실 3: 예산 소진 예측(사용률/월 경과율 선형 외삽, 초과 예상 시) ────
    const budget = await this.buildBudgetFact(
      userId,
      householdId,
      month,
      monthly.totalNet,
      categories.items,
    );
    if (budget) facts.push(budget);

    if (facts.length === 0) {
      this.logger.log(
        `monthly-insights empty household=${householdId} month=${month}`,
      );
      return { month, insights: [], method: 'fallback' };
    }

    // LLM 문구 다듬기(JSON 배열 강제) — 실패/무효 시 서버 계산 문구 그대로.
    let insights: MonthlyInsight[];
    let method: 'llm' | 'fallback';
    try {
      insights = await this.polishInsightsViaLlm(facts);
      method = 'llm';
    } catch {
      insights = facts;
      method = 'fallback';
    }

    this.logger.log(
      `monthly-insights answered household=${householdId} month=${month} ` +
        `count=${insights.length} method=${method}`,
    );
    return { month, insights, method };
  }

  /* ---------------------------------------------------------------------- */
  /* ① 의도 추출                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * LLM에 JSON만 출력하도록 요구해 의도를 추출한다. 무효면 throw(→휴리스틱).
   *
   * 프롬프트가 `unsupported`를 **명시적으로 허용**하는 것이 핵심이다. 선택지가
   * 셋뿐이면 LLM은 "주말에 뭐 할까?"에도 셋 중 하나를 고르고, 그 결과는 사용자에게
   * 자신 있는 오답이 된다. `pipelineRunId`를 넘겨 `ai_invocations`가 이 질의의
   * pipeline run에 붙게 한다(거부율과 LLM 호출을 같은 축으로 조인).
   */
  private async extractIntentViaLlm(
    question: string,
    pipelineRunId: string,
  ): Promise<FinanceIntent> {
    const slugGuide = DEFAULT_CATEGORIES.map(
      (c) => `${c.slug}(${c.name})`,
    ).join(', ');
    const generated = await this.providers.llm.generate({
      system:
        '당신은 가계부 질의 분석기입니다. 사용자 질문에서 조회 의도를 추출해 ' +
        'JSON 객체 하나만 출력하세요. 설명·코드펜스·다른 텍스트를 절대 붙이지 마세요.\n' +
        '스키마: {"month"?: "YYYY-MM", "categorySlug"?: string, ' +
        '"aggregate": "total"|"byCategory"|"byMerchant"|"unsupported"}\n' +
        `categorySlug는 다음 중 하나만 사용: ${slugGuide}. ` +
        '해당 없으면 생략하세요. month가 특정되지 않으면 생략하세요.\n' +
        '이 시스템이 답할 수 있는 것은 특정 기간의 지출 금액·건수를 전체(total)/' +
        '카테고리별(byCategory)/가맹점별(byMerchant)로 집계하는 것뿐입니다. ' +
        '기간 비교, 미래 예측, 지출과 무관한 질문처럼 이 셋으로 답할 수 없는 ' +
        '질문이면 반드시 aggregate를 "unsupported"로 하세요. 억지로 고르지 마세요.',
      prompt: question,
      temperature: 0,
      maxTokens: 256,
      metadata: {
        task: 'finance-intent',
        promptVersion: 'finance-intent-v2',
        pipelineRunId,
      },
    });

    const parsed = intentOutputSchema.parse(extractJson(generated.text));
    if (parsed.aggregate === 'unsupported') {
      // LLM이 스스로 못 답한다고 했으면 그대로 존중한다(카테고리를 같이 뱉었더라도
      // 그건 모순이지 근거가 아니다).
      return {
        month: parsed.month ?? currentSeoulMonth(),
        categorySlug: null,
        aggregate: 'unsupported',
      };
    }
    const categorySlug =
      parsed.categorySlug != null && KNOWN_SLUGS.has(parsed.categorySlug)
        ? parsed.categorySlug
        : null;
    return {
      month: parsed.month ?? currentSeoulMonth(),
      categorySlug,
      aggregate:
        categorySlug !== null && parsed.aggregate === 'total'
          ? 'byCategory'
          : parsed.aggregate,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* ② 집계(analytics 재사용 — 권한/공개범위는 그 안에서 강제)                  */
  /* ---------------------------------------------------------------------- */

  /** 의도에 맞는 SQL 집계 요약을 구성한다(모든 수치는 analytics SQL 결과). */
  private async aggregate(
    userId: string,
    householdId: string,
    // 'unsupported'가 여기까지 흘러올 수 없게 타입으로 막는다(거부는 이 앞에서 끝난다).
    intent: SupportedFinanceIntent,
  ): Promise<FinanceQueryData> {
    const query = { month: intent.month };
    const monthly = await this.analytics.monthly(userId, householdId, query);

    if (intent.aggregate === 'byCategory') {
      const breakdown = await this.analytics.categories(
        userId,
        householdId,
        query,
      );

      if (intent.categorySlug !== null) {
        const matched = breakdown.items.find(
          (item) => item.categorySlug === intent.categorySlug,
        );
        const categoryName =
          matched?.categoryName ??
          DEFAULT_CATEGORIES.find((c) => c.slug === intent.categorySlug)
            ?.name ??
          intent.categorySlug;
        return {
          month: intent.month,
          aggregate: 'byCategory',
          categorySlug: intent.categorySlug,
          categoryName,
          totalNet: matched?.net ?? 0,
          transactionCount: matched?.count ?? 0,
          ...(matched
            ? {
                items: [
                  {
                    label: matched.categoryName,
                    net: matched.net,
                    count: matched.count,
                  },
                ],
              }
            : {}),
        };
      }

      return {
        month: intent.month,
        aggregate: 'byCategory',
        categorySlug: null,
        categoryName: null,
        totalNet: monthly.totalNet,
        transactionCount: monthly.transactionCount,
        items: breakdown.items.slice(0, TOP_ITEMS).map((item) => ({
          label: item.categoryName,
          net: item.net,
          count: item.count,
        })),
      };
    }

    if (intent.aggregate === 'byMerchant') {
      const breakdown = await this.analytics.merchants(
        userId,
        householdId,
        query,
      );
      return {
        month: intent.month,
        aggregate: 'byMerchant',
        categorySlug: null,
        categoryName: null,
        totalNet: monthly.totalNet,
        transactionCount: monthly.transactionCount,
        items: breakdown.items.slice(0, TOP_ITEMS).map((item) => ({
          label: item.merchant,
          net: item.net,
          count: item.count,
        })),
      };
    }

    return {
      month: intent.month,
      aggregate: 'total',
      categorySlug: null,
      categoryName: null,
      totalNet: monthly.totalNet,
      transactionCount: monthly.transactionCount,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* ③ 답변 생성                                                              */
  /* ---------------------------------------------------------------------- */

  /** LLM에 집계 JSON을 근거로 해요체 답변(JSON 강제)을 요청. 무효면 throw. */
  private async generateAnswerViaLlm(
    question: string,
    data: FinanceQueryData,
    pipelineRunId: string,
  ): Promise<string> {
    const generated = await this.providers.llm.generate({
      system:
        '당신은 가족 가계부 도우미입니다. 근거 자료(집계 JSON)에 제공된 수치만 ' +
        '사용해 한국어 해요체 한두 문장으로 답하세요. 수치를 새로 계산하거나 ' +
        '추측하지 마세요. 금액은 천단위 콤마와 "원"으로 표기하세요. ' +
        '출력은 JSON 객체 하나만: {"answer": "..."} — 설명·코드펜스 금지.',
      question,
      context: [{ id: 'aggregate-summary', text: JSON.stringify(data) }],
      temperature: 0,
      maxTokens: 512,
      metadata: {
        task: 'finance-answer',
        promptVersion: 'finance-answer-v1',
        pipelineRunId,
      },
    });

    return answerOutputSchema.parse(extractJson(generated.text)).answer;
  }

  /** 결정적 템플릿 답변(LLM 폴백 — 집계값 직접 포맷, mock의 기본 경로). */
  private templateAnswer(data: FinanceQueryData): string {
    const monthKo = monthLabel(data.month);

    if (data.aggregate === 'byCategory' && data.categorySlug !== null) {
      const name = data.categoryName ?? data.categorySlug;
      if (data.transactionCount === 0) {
        return `${monthKo}에는 ${name} 지출이 없어요.`;
      }
      return `${monthKo} ${name} 지출은 ${formatWon(data.totalNet)}이에요. (${data.transactionCount}건)`;
    }

    const top = data.items?.[0];
    if (data.aggregate === 'byCategory') {
      if (!top || data.transactionCount === 0) {
        return `${monthKo}에는 아직 지출 내역이 없어요.`;
      }
      return (
        `${monthKo}에는 ${top.label}에 가장 많이 썼어요 (${formatWon(top.net)}). ` +
        `전체 지출은 ${formatWon(data.totalNet)}이에요.`
      );
    }

    if (data.aggregate === 'byMerchant') {
      if (!top || data.transactionCount === 0) {
        return `${monthKo}에는 아직 지출 내역이 없어요.`;
      }
      return (
        `${monthKo}에는 ${top.label}에서 가장 많이 썼어요 (${formatWon(top.net)}). ` +
        `전체 지출은 ${formatWon(data.totalNet)}이에요.`
      );
    }

    if (data.transactionCount === 0) {
      return `${monthKo}에는 아직 지출 내역이 없어요.`;
    }
    return `${monthKo} 총 지출은 ${formatWon(data.totalNet)}이에요. (거래 ${data.transactionCount}건)`;
  }

  /* ---------------------------------------------------------------------- */
  /* 인사이트 사실 계산(결정적)                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * 이상 지출 사실: 해당 월 승인 거래 중 최고액 단건이 월 평균 결제액
   * (totalNet/transactionCount)의 3배 이상이면 1건 보고. 가맹점 라벨은
   * analytics.merchants와 동일하게 타 구성원 summary_only를 '(비공개)'로
   * 마스킹한다. 거래가 2건 미만이면 평균 비교가 무의미하므로 건너뛴다.
   */
  private async buildAnomalyFact(
    householdId: string,
    actorMemberId: string,
    month: string,
    totalNet: number,
    transactionCount: number,
  ): Promise<MonthlyInsight | null> {
    if (transactionCount < 2 || totalNet <= 0) return null;

    const { from, to } = seoulMonthRange(month);
    const merchantLabel = redactedMerchantLabel(
      actorMemberId,
      LABEL_UNKNOWN_MERCHANT,
    );

    // netAmount(취소 반영 순액)로 최고액을 뽑고 isNull(excludedAt)로 '제외' 거래를
    // 배제한다 — 평균(totalNet/count)도 net·제외반영 기준이므로 분자/분모를 정렬해
    // 전액취소(net≈0)나 사용자가 제외한 거래가 이상지출로 되살아나지 않게 한다.
    const [top] = await this.db
      .select({
        merchant: merchantLabel,
        amount: schema.cardTransactions.netAmount,
      })
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.householdId, householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          isNull(schema.cardTransactions.excludedAt),
          // 자산 이동(현금 인출·선불 충전)은 이상 지출 후보가 아니다 — 분모인
          // totalNet/transactionCount는 analytics 집계(transfer 제외)에서 오므로,
          // 여기에 조건이 없으면 ATM 인출이 "평소보다 큰 지출"로 되살아난다(ADR-0026).
          notTransferCategory(),
          // KRW 전용(평균·formatWon이 원 기준). 외화 minor units가 최고액 정렬을
          // 오염시키지 않게 한다(grounding 정확성 = LLM 답변 정확성).
          eq(schema.cardTransactions.currency, 'KRW'),
          visibilityScope(actorMemberId),
          // 기간 창도 analytics와 같은 공통 헬퍼로 — 분자(최고액)와 분모(평균)의
          // 모집단이 어긋나면 3배 판정 자체가 흔들린다.
          spendPeriodWindow(from, to),
        ),
      )
      .orderBy(desc(schema.cardTransactions.netAmount))
      .limit(1);

    if (!top) return null;

    const average = Math.round(totalNet / transactionCount);
    if (average <= 0 || top.amount < average * ANOMALY_MULTIPLIER) return null;

    return {
      kind: 'anomaly',
      message:
        `평소보다 큰 지출이 있었어요. ${top.merchant}에서 ` +
        `${formatWon(top.amount)}을 한 번에 결제했는데, 이 달 평균 결제액` +
        `(${formatWon(average)})의 3배가 넘어요.`,
    };
  }

  /**
   * 예산 소진 예측 사실: 각 예산의 현재 사용률을 월 경과율로 선형 외삽해
   * 100% 초과가 예상되는 예산 중 가장 심한 1건을 보고. spent는 스코프별
   * analytics SQL 집계에서 읽는다(직접 합산 금지). 초과 예상이 없으면 null.
   */
  private async buildBudgetFact(
    userId: string,
    householdId: string,
    month: string,
    totalNet: number,
    categoryItems: readonly {
      categoryId: string | null;
      net: number;
    }[],
  ): Promise<MonthlyInsight | null> {
    const budgets = await this.db
      .select({
        id: schema.budgets.id,
        name: schema.budgets.name,
        scopeType: schema.budgets.scopeType,
        scopeRefId: schema.budgets.scopeRefId,
        amount: schema.budgets.amount,
      })
      .from(schema.budgets)
      .where(eq(schema.budgets.householdId, householdId));
    if (budgets.length === 0) return null;

    const elapsed = monthElapsedRate(month);
    if (elapsed <= 0) return null; // 미래 월 — 외삽 불가.

    // member/card 스코프 예산이 있을 때만 해당 breakdown을 지연 조회한다.
    let memberNets: Map<string, number> | null = null;
    let cardNets: Map<string, number> | null = null;

    let worst: {
      label: string;
      amount: number;
      spent: number;
      projectedRate: number;
    } | null = null;

    for (const budget of budgets) {
      if (budget.amount <= 0) continue;

      let spent: number;
      if (budget.scopeType === 'household') {
        spent = totalNet;
      } else if (budget.scopeType === 'category') {
        spent =
          categoryItems.find((item) => item.categoryId === budget.scopeRefId)
            ?.net ?? 0;
      } else if (budget.scopeType === 'member') {
        if (memberNets === null) {
          const breakdown = await this.analytics.members(userId, householdId, {
            month,
          });
          memberNets = new Map(
            breakdown.items.map((item) => [item.memberId, item.net]),
          );
        }
        spent = memberNets.get(budget.scopeRefId ?? '') ?? 0;
      } else {
        if (cardNets === null) {
          const breakdown = await this.analytics.cards(userId, householdId, {
            month,
          });
          cardNets = new Map(
            breakdown.items
              .filter((item) => item.cardId !== null)
              .map((item) => [item.cardId as string, item.net]),
          );
        }
        spent = cardNets.get(budget.scopeRefId ?? '') ?? 0;
      }

      if (spent <= 0) continue;
      const projectedRate = spent / budget.amount / elapsed;
      if (
        projectedRate > 1 &&
        (worst === null || projectedRate > worst.projectedRate)
      ) {
        worst = {
          label: budget.name ?? BUDGET_SCOPE_LABEL[budget.scopeType] ?? '예산',
          amount: budget.amount,
          spent,
          projectedRate,
        };
      }
    }

    if (worst === null) return null;

    const projectedPercent = Math.min(999, Math.round(worst.projectedRate * 100));
    return {
      kind: 'budget',
      message:
        `'${worst.label}' 예산 ${formatWon(worst.amount)} 중 ` +
        `${formatWon(worst.spent)}을 썼어요. 이 속도면 예산의 약 ` +
        `${projectedPercent}%까지 쓸 것 같아요. 남은 기간 조금만 아껴봐요.`,
    };
  }

  /** LLM에 사실 목록을 주고 문구만 다듬게 한다(JSON 배열 강제). 무효면 throw. */
  private async polishInsightsViaLlm(
    facts: readonly MonthlyInsight[],
  ): Promise<MonthlyInsight[]> {
    const generated = await this.providers.llm.generate({
      system:
        '아래 가계부 인사이트 사실 목록의 각 항목을 자연스러운 한국어 해요체 ' +
        '한 문장으로 다듬으세요. 수치·비교 대상은 절대 바꾸지 말고, 같은 순서와 ' +
        '같은 kind를 유지하세요. 출력은 JSON 배열 하나만: ' +
        '[{"kind":"trend"|"anomaly"|"budget","message":"..."}] — 설명·코드펜스 금지.',
      prompt: JSON.stringify(facts),
      temperature: 0,
      maxTokens: 1024,
      metadata: {
        task: 'finance-insight-polish',
        promptVersion: 'finance-insight-v1',
      },
    });

    const polished = polishedInsightsSchema.parse(extractJson(generated.text));
    if (polished.length !== facts.length) {
      throw new Error('polished insights length mismatch');
    }
    facts.forEach((fact, index) => {
      if (polished[index].kind !== fact.kind) {
        throw new Error('polished insights kind mismatch');
      }
    });
    return polished;
  }

  /* ---------------------------------------------------------------------- */
  /* 권한/입력 검증(analytics 패턴 재사용)                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * `userId`가 `householdId`의 활성 구성원인지 강제하고 memberId를 반환한다.
   * 비구성원은 가족 존재 여부를 노출하지 않는 403(PRD §26) —
   * analytics.service의 requireMembership과 동일 패턴.
   */
  private async requireMembership(
    householdId: string,
    userId: string,
  ): Promise<string> {
    const [member] = await this.db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);

    if (!member) {
      throw new ForbiddenException('not a household member');
    }
    return member.id;
  }

  /** 쿼리스트링 householdId 검증(형식 오류 400, 누락 400). */
  private requireHouseholdId(householdId: string | undefined): string {
    if (!householdId) {
      throw new BadRequestException('householdId is required');
    }
    if (!UUID_PATTERN.test(householdId)) {
      throw new BadRequestException('householdId must be a UUID');
    }
    return householdId;
  }

  /** `month=YYYY-MM` 검증(기본: 현재 Asia/Seoul 월). */
  private resolveMonth(month: string | undefined): string {
    if (month === undefined || month === '') {
      return currentSeoulMonth();
    }
    if (!MONTH_PATTERN.test(month)) {
      throw new BadRequestException('month must be formatted as YYYY-MM');
    }
    return month;
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level helpers (결정적 · 순수)                                        */
/* -------------------------------------------------------------------------- */

/**
 * LLM 출력에서 JSON 페이로드를 추출해 파싱한다. 코드펜스/서문이 붙어도 첫
 * `{`/`[`부터 마지막 짝 문자까지 잘라 시도하고, 실패하면 throw(→ 폴백 경로).
 */
function extractJson(text: string): unknown {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  let start: number;
  let end: number;
  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    start = arrayStart;
    end = text.lastIndexOf(']');
  } else {
    start = objectStart;
    end = text.lastIndexOf('}');
  }
  if (start === -1 || end === -1 || end <= start) {
    throw new SyntaxError('no JSON payload found');
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

/** KRW 정수 → '123,456원' (로케일/ICU 비의존 결정적 포맷, 음수 지원). */
function formatWon(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.trunc(amount) : 0;
  const digits = String(Math.abs(safe)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ',',
  );
  return `${safe < 0 ? '-' : ''}${digits}원`;
}

/** `YYYY-MM` → '2026년 7월'. */
function monthLabel(month: string): string {
  const matched = /^(\d{4})-(\d{2})$/.exec(month);
  if (!matched) return month;
  return `${matched[1]}년 ${Number(matched[2])}월`;
}

// 월 계산 헬퍼(toMonthString/currentSeoulMonth/previousMonth/seoulMonthRange)는
// 의도 해석과 같은 순수 로직이라 ./finance-intent 로 옮겨 한 곳에서 테스트한다.

/**
 * 해당 월의 경과율(0~1). 과거 월 = 1, 미래 월 = 0, 당월은
 * (now - 월초)/(월길이)를 {@link MIN_ELAPSED_RATE} 하한으로 클램프.
 */
function monthElapsedRate(month: string): number {
  const { from, to } = seoulMonthRange(month);
  const now = Date.now();
  if (now >= to.getTime()) return 1;
  if (now <= from.getTime()) return 0;
  const raw = (now - from.getTime()) / (to.getTime() - from.getTime());
  return Math.max(MIN_ELAPSED_RATE, raw);
}

/**
 * 전월 대비 카테고리 증감 사실(±20% 이상, |변화율| 내림차순 상위 2).
 * 전월 순지출이 0 이하인 카테고리는 비교 대상에서 제외한다(비율 정의 불가).
 */
function buildTrendFacts(
  current: readonly {
    categoryId: string | null;
    categoryName: string;
    net: number;
  }[],
  previous: readonly {
    categoryId: string | null;
    net: number;
  }[],
): MonthlyInsight[] {
  const prevByKey = new Map(
    previous.map((item) => [item.categoryId ?? 'uncategorized', item.net]),
  );

  const changes: { name: string; prev: number; cur: number; rate: number }[] =
    [];
  for (const item of current) {
    const prevNet = prevByKey.get(item.categoryId ?? 'uncategorized');
    if (prevNet === undefined || prevNet <= 0) continue;
    const rate = (item.net - prevNet) / prevNet;
    if (Math.abs(rate) < TREND_MIN_RATE) continue;
    changes.push({
      name: item.categoryName,
      prev: prevNet,
      cur: item.net,
      rate,
    });
  }

  changes.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
  return changes.slice(0, TREND_TOP_N).map((change) => ({
    kind: 'trend' as const,
    message:
      `${change.name} 지출이 지난달보다 ${Math.round(Math.abs(change.rate) * 100)}% ` +
      `${change.rate > 0 ? '늘었어요' : '줄었어요'} ` +
      `(${formatWon(change.prev)} → ${formatWon(change.cur)}).`,
  }));
}

/** 타입 참조 유지(문서화 목적) — data.items의 요소 형태. */
export type { FinanceQueryItem };
