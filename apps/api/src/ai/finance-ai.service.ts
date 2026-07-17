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
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { ProviderSet } from '@family/ai-providers';
import type {
  FinanceAggregateKind,
  FinanceQueryData,
  FinanceQueryItem,
  FinanceQueryResponse,
  MonthlyInsight,
  MonthlyInsightsResponse,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { DEFAULT_CATEGORIES } from '@family/shared';

import { AnalyticsService } from '../analytics/analytics.service';
import { DB } from '../database/database.constants';
import { AI_PROVIDERS } from './ai.constants';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Fixed Asia/Seoul (KST) offset in milliseconds — UTC+9, no DST. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `YYYY-MM` (01–12). */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

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
const LABEL_REDACTED = '(비공개)';
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

/** ① 의도 추출 LLM 출력 스키마. 벗어나면 휴리스틱 폴백. */
const intentOutputSchema = z.object({
  month: z.string().regex(MONTH_PATTERN).optional().nullable(),
  categorySlug: z.string().optional().nullable(),
  aggregate: z.enum(['total', 'byCategory', 'byMerchant']),
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

/** 해석된 질의 의도(월/카테고리/집계 형태). */
interface FinanceIntent {
  month: string;
  categorySlug: string | null;
  aggregate: FinanceAggregateKind;
}

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
   * 자연어 가계부 질의: ① 의도 추출(LLM→휴리스틱) → ② SQL 집계(권한 검증 포함
   * analytics 재사용) → ③ 해요체 답변(LLM→템플릿). `method`는 최종 답변을
   * 만든 경로를 노출한다(mock에서는 항상 'fallback').
   */
  async financeQuery(
    userId: string,
    options: FinanceQueryOptions,
  ): Promise<FinanceQueryResponse> {
    const { householdId, question } = options;

    // ① 의도 추출 — LLM(JSON 강제), 실패/무효 시 결정적 휴리스틱.
    let intent: FinanceIntent;
    let intentMethod: 'llm' | 'fallback';
    try {
      intent = await this.extractIntentViaLlm(question);
      intentMethod = 'llm';
    } catch {
      intent = this.extractIntentHeuristically(question);
      intentMethod = 'fallback';
    }

    // ② 집계 — analytics의 SQL 집계 재사용(멤버십 403/공개범위 스코프 포함).
    //    권한 오류(403)는 그대로 전파한다(폴백 대상이 아님 — LLM 실패만 폴백).
    const data = await this.aggregate(userId, householdId, intent);

    // ③ 답변 생성 — LLM(JSON 강제), 실패/무효 시 집계값 직접 포맷 템플릿.
    let answer: string;
    let method: 'llm' | 'fallback';
    try {
      answer = await this.generateAnswerViaLlm(question, data);
      method = 'llm';
    } catch {
      answer = this.templateAnswer(data);
      method = 'fallback';
    }

    // 로그는 식별자/경로/집계형태만(질문 원문·금액 미포함).
    this.logger.log(
      `finance-query answered household=${householdId} ` +
        `aggregate=${data.aggregate} month=${data.month} ` +
        `intent=${intentMethod} answer=${method}`,
    );

    return { answer, data, method };
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

  /** LLM에 JSON만 출력하도록 요구해 의도를 추출한다. 무효면 throw(→휴리스틱). */
  private async extractIntentViaLlm(question: string): Promise<FinanceIntent> {
    const slugGuide = DEFAULT_CATEGORIES.map(
      (c) => `${c.slug}(${c.name})`,
    ).join(', ');
    const generated = await this.providers.llm.generate({
      system:
        '당신은 가계부 질의 분석기입니다. 사용자 질문에서 조회 의도를 추출해 ' +
        'JSON 객체 하나만 출력하세요. 설명·코드펜스·다른 텍스트를 절대 붙이지 마세요.\n' +
        '스키마: {"month"?: "YYYY-MM", "categorySlug"?: string, ' +
        '"aggregate": "total"|"byCategory"|"byMerchant"}\n' +
        `categorySlug는 다음 중 하나만 사용: ${slugGuide}. ` +
        '해당 없으면 생략하세요. month가 특정되지 않으면 생략하세요.',
      prompt: question,
      temperature: 0,
      maxTokens: 256,
    });

    const parsed = intentOutputSchema.parse(extractJson(generated.text));
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

  /**
   * 결정적 휴리스틱 의도 추출(LLM 폴백 경로 — mock의 기본 경로).
   *  - 월: '지난달/저번달' → 전월, '이번달/이달' → 당월, 'YYYY-MM'/'YYYY년 M월'
   *    /'N월'(당해 연도) 순으로 해석, 없으면 당월.
   *  - 카테고리: DEFAULT_CATEGORIES name/slug 부분일치(첫 일치 승).
   *  - 집계: 카테고리 일치 → byCategory, '어디/가맹점/매장' → byMerchant,
   *    '카테고리/항목별/분류별' → byCategory, 그 외 → total.
   */
  private extractIntentHeuristically(question: string): FinanceIntent {
    const compact = question.replace(/\s+/g, '');

    // 월 해석.
    let month: string | null = null;
    const explicit = /(\d{4})-(0[1-9]|1[0-2])/.exec(compact);
    const koreanYm = /(\d{4})년(\d{1,2})월/.exec(compact);
    const monthOnly = /(?:^|[^\d-])(\d{1,2})월/.exec(compact);
    if (/지난달|저번달|전달/.test(compact)) {
      month = previousMonth(currentSeoulMonth());
    } else if (/이번달|이달|금월/.test(compact)) {
      month = currentSeoulMonth();
    } else if (explicit) {
      month = `${explicit[1]}-${explicit[2]}`;
    } else if (koreanYm) {
      month = toMonthString(Number(koreanYm[1]), Number(koreanYm[2]));
    } else if (monthOnly) {
      const current = currentSeoulMonth();
      month = toMonthString(
        Number(current.slice(0, 4)),
        Number(monthOnly[1]),
      );
    }

    // 카테고리 부분일치(DEFAULT_CATEGORIES name/slug).
    let categorySlug: string | null = null;
    const lower = question.toLowerCase();
    for (const category of DEFAULT_CATEGORIES) {
      if (question.includes(category.name) || lower.includes(category.slug)) {
        categorySlug = category.slug;
        break;
      }
    }

    // 집계 형태.
    let aggregate: FinanceAggregateKind = 'total';
    if (categorySlug !== null || /카테고리|항목별|분류별/.test(compact)) {
      aggregate = 'byCategory';
    } else if (/가맹점|매장|상호|어디서|어디에/.test(compact)) {
      aggregate = 'byMerchant';
    }

    return {
      month: month ?? currentSeoulMonth(),
      categorySlug,
      aggregate,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* ② 집계(analytics 재사용 — 권한/공개범위는 그 안에서 강제)                  */
  /* ---------------------------------------------------------------------- */

  /** 의도에 맞는 SQL 집계 요약을 구성한다(모든 수치는 analytics SQL 결과). */
  private async aggregate(
    userId: string,
    householdId: string,
    intent: FinanceIntent,
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
    const merchantLabel = sql<string>`case
      when ${schema.cardTransactions.memberId} <> ${actorMemberId}::uuid
        and ${schema.cardTransactions.visibility} = 'summary_only'
        then ${LABEL_REDACTED}
      when ${schema.cardTransactions.merchantNormalized} is null
        then ${LABEL_UNKNOWN_MERCHANT}
      else ${schema.cardTransactions.merchantNormalized}
    end`;

    const [top] = await this.db
      .select({
        merchant: merchantLabel,
        amount: schema.cardTransactions.amount,
      })
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.householdId, householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          this.visibilityScope(actorMemberId),
          gte(schema.cardTransactions.approvedAt, from),
          lt(schema.cardTransactions.approvedAt, to),
        ),
      )
      .orderBy(desc(schema.cardTransactions.amount))
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

  /** 공개범위 WHERE 조각(analytics와 동일: 본인 ∪ household/summary_only). */
  private visibilityScope(actorMemberId: string): SQL {
    const scope = or(
      eq(schema.cardTransactions.memberId, actorMemberId),
      inArray(schema.cardTransactions.visibility, [
        'household',
        'summary_only',
      ]),
    );
    return scope as SQL;
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

/** (year, monthNumber 1~12 범위 밖 롤오버 허용) → 'YYYY-MM'. */
function toMonthString(year: number, monthNumber: number): string {
  // Date.UTC의 월 인덱스 정규화로 0/13 등의 롤오버를 흡수한다.
  const rolled = new Date(Date.UTC(year, monthNumber - 1, 1));
  const y = rolled.getUTCFullYear();
  const m = rolled.getUTCMonth() + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/** 현재 Asia/Seoul 월 'YYYY-MM'(고정 UTC+9 — analytics와 동일 규약). */
function currentSeoulMonth(): string {
  const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
  return toMonthString(seoulNow.getUTCFullYear(), seoulNow.getUTCMonth() + 1);
}

/** 'YYYY-MM' → 전월 'YYYY-MM'. */
function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return toMonthString(year, monthNumber - 1);
}

/** 'YYYY-MM'의 [월초, 익월초) UTC 경계(Asia/Seoul 벽시계, 고정 UTC+9). */
function seoulMonthRange(month: string): { from: Date; to: Date } {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return {
    from: new Date(Date.UTC(year, monthNumber - 1, 1) - KST_OFFSET_MS),
    to: new Date(Date.UTC(year, monthNumber, 1) - KST_OFFSET_MS),
  };
}

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
