/**
 * 카드 문자 LLM span 추출 (ADR-0023 §3, S2).
 *
 * **이 파일이 카드 문자 원문이 외부로 나가는 유일한 경계다.** 원문은 여기서만
 * {@link maskForLlm}을 거쳐 전송되고, 다른 어떤 경로도 LLM에 카드 문자를 보내지 않는다.
 *
 * 규약(절대):
 * - **LLM은 값을 만들지 않는다.** 원문 인용구(quote)만 받고, 위치 확정·정규화는
 *   `@family/card-parsers`의 결정적 함수가 한다(PRD §3.3).
 * - **LLM 실패 = 결정적 폴백.** 호출 실패·JSON 파싱 실패·인용구 불일치는 잡을
 *   실패시키지 않고 `null`을 돌려준다(category-suggest 프로세서의 기존 관례).
 * - 로그에 원문·프롬프트·응답을 남기지 않는다 — 식별자와 지문, 결과 상태만.
 * - 일일 상한을 넘으면 호출하지 않는다. 예산 소진이 파이프라인 실패가 되어선 안 된다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildResultFromSpans,
  maskForLlm,
  templateFingerprint,
  type CardSmsInput,
  type CardSmsParseResult,
  type CardSmsQuote,
  type SpanField,
} from '@family/card-parsers';
import {
  createProviders,
  instrumentProviders,
  type LlmProvider,
} from '@family/ai-providers';
import type { AppConfig } from '@family/config';
import { createDbAiInvocationObserver, schema, type Db } from '@family/database';
import { createLogger, MODEL_SERVING_TASKS } from '@family/shared';
import { and, count, eq, gte } from 'drizzle-orm';

import { DB } from '../database/database.module';
import { WorkerModelServingService } from '../model-serving/model-serving.service';

/** 응답 상한. quote 4개짜리 JSON이면 충분하다(비용·지연 최소화). */
const EXTRACT_MAX_TOKENS = 512;

/** 인용구 개수 상한 — 필드가 4개뿐이라 그 이상은 응답 오염으로 본다. */
const MAX_QUOTES = 8;

const PROMPT_VERSION = 'card-sms-span-v1';

const SYSTEM_PROMPT = [
  '당신은 한국 카드 결제 문자에서 **원문 조각을 인용**하는 추출기입니다.',
  '값을 새로 만들거나 계산하지 마세요. 원문에 **그대로 존재하는 문자열**만 인용해야 합니다.',
  '인용구가 원문과 한 글자라도 다르면 그 필드는 폐기됩니다.',
  '',
  '아래 JSON 하나만 출력하세요(설명·코드펜스 금지):',
  '{"transactionType":"approval|cancellation|declined|unknown",',
  ' "quotes":[{"field":"amount|occurredAt|merchant|installment","quote":"<원문 그대로>","occurrence":1}]}',
  '',
  '규칙:',
  '- amount 인용에는 반드시 통화 표시를 포함하세요(예: "1,169원", "USD 22.00").',
  '  숫자만 인용하면 통화를 확정할 수 없어 폐기됩니다.',
  '- occurredAt은 날짜와 시각을 함께(예: "07/20 14:32").',
  '- merchant는 가맹점명만. 금액·시각·카드사명은 제외.',
  '- installment는 "일시불" 또는 "3개월" 같은 조각.',
  '- 해당 정보가 원문에 없으면 그 field를 아예 넣지 마세요. 추측 금지.',
  '- occurrence는 같은 문자열이 여러 번 나올 때 몇 번째인지(1부터).',
  '- 숫자가 •로 가려진 부분은 카드번호입니다. 절대 인용하지 마세요.',
].join('\n');

/** LLM 응답에서 첫 JSON 객체를 관대하게 추출한다(코드펜스·서두 텍스트 허용). */
function extractJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SPAN_FIELDS: readonly string[] = ['amount', 'occurredAt', 'merchant', 'installment'];

/** 응답을 검증된 인용구 목록으로 좁힌다. 형식 위반 항목은 조용히 버린다. */
function toQuotes(value: unknown): CardSmsQuote[] {
  if (!isRecord(value) || !Array.isArray(value.quotes)) return [];
  const quotes: CardSmsQuote[] = [];
  for (const raw of value.quotes.slice(0, MAX_QUOTES)) {
    if (!isRecord(raw)) continue;
    const { field, quote, occurrence } = raw;
    if (typeof field !== 'string' || !SPAN_FIELDS.includes(field)) continue;
    if (typeof quote !== 'string' || quote.length === 0) continue;
    const nth = occurrence === undefined ? 1 : Number(occurrence);
    if (!Number.isInteger(nth) || nth < 1) continue;
    quotes.push({ field: field as SpanField, quote, occurrence: nth });
  }
  return quotes;
}

function toTransactionType(value: unknown): CardSmsParseResult['transactionType'] {
  const raw = isRecord(value) ? value.transactionType : undefined;
  return raw === 'approval' || raw === 'cancellation' || raw === 'declined' ? raw : 'unknown';
}

/** {@link LlmSpanExtractorService.extract} 결과. */
export interface LlmSpanExtraction {
  readonly result: CardSmsParseResult;
  readonly rejected: string[];
  readonly fingerprint: string;
  readonly traceId: string | null;
}

@Injectable()
export class LlmSpanExtractorService {
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly llm: LlmProvider;
  private readonly mode: 'off' | 'shadow' | 'on';
  private readonly dailyBudget: number;
  /** 같은 지문의 동시 유입이 LLM을 중복 호출하지 않게 하는 프로세스 내 단일화. */
  private readonly inFlight = new Map<string, Promise<LlmSpanExtraction | null>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly modelServing: WorkerModelServingService,
    configService: ConfigService,
  ) {
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:llm-span-extractor', {
      pretty: nodeEnv !== 'production',
    });
    const ai = configService.get<AppConfig['ai']>('ai');
    this.mode = ai?.cardSmsLlmMode ?? 'off';
    this.dailyBudget = ai?.cardSmsLlmDailyBudget ?? 0;
    this.llm = instrumentProviders(
      createProviders({
        provider: ai?.provider ?? 'mock',
        ...(ai?.geminiApiKey !== undefined ? { geminiApiKey: ai.geminiApiKey } : {}),
        ...(ai?.llmModel !== undefined ? { llmModel: ai.llmModel } : {}),
        strict: nodeEnv === 'production',
      }),
      {
        observer: createDbAiInvocationObserver(this.db),
        defaultTask: MODEL_SERVING_TASKS.CARD_SMS_EXTRACT,
      },
    ).llm;
  }

  /** 폴백이 꺼져 있으면 호출부가 LLM 경로를 건너뛴다. */
  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /** `on`에서만 파싱 상태를 바꾼다. `shadow`는 관찰만 하고 결과를 적용하지 않는다. */
  get appliesResult(): boolean {
    return this.mode === 'on';
  }

  /**
   * 마스킹된 원문을 LLM에 보내 인용구를 받고, **원문** 기준으로 span을 확정해
   * 결정적으로 정규화한 결과를 돌려준다. 실패는 전부 `null`(잡 실패 아님).
   */
  async extract(
    input: CardSmsInput,
    householdId: string,
    pipelineRunId: string,
  ): Promise<LlmSpanExtraction | null> {
    if (!this.enabled) return null;

    const fingerprint = templateFingerprint(input.sender, input.content);
    const existing = this.inFlight.get(fingerprint);
    if (existing) return existing;

    const pending = this.extractUncached(input, householdId, pipelineRunId, fingerprint).finally(
      () => {
        this.inFlight.delete(fingerprint);
      },
    );
    this.inFlight.set(fingerprint, pending);
    return pending;
  }

  private async extractUncached(
    input: CardSmsInput,
    householdId: string,
    pipelineRunId: string,
    fingerprint: string,
  ): Promise<LlmSpanExtraction | null> {
    const shortFingerprint = fingerprint.slice(0, 12);

    if (!(await this.withinDailyBudget())) {
      this.logger.warn(
        { householdId, fingerprint: shortFingerprint, outcome: 'budget_exhausted' },
        'card-sms llm extraction skipped: daily budget exhausted',
      );
      return null;
    }

    // 원문이 외부로 나가는 유일한 지점. 길이 보존 마스킹이라 인용구를 원문에서
    // 그대로 다시 찾을 수 있다(mask.ts 불변식).
    let masked: string;
    try {
      masked = maskForLlm(input.content);
    } catch {
      this.logger.warn(
        { householdId, fingerprint: shortFingerprint, outcome: 'mask_failed' },
        'card-sms llm extraction skipped: masking did not preserve length',
      );
      return null;
    }

    let responseText: string;
    let traceId: string | null = null;
    try {
      const response = await this.modelServing.generateLlm(
        { householdId },
        MODEL_SERVING_TASKS.CARD_SMS_EXTRACT,
        fingerprint,
        this.llm,
        null,
        {
          system: SYSTEM_PROMPT,
          prompt: `카드 문자 원문:\n"""\n${masked}\n"""`,
          temperature: 0,
          maxTokens: EXTRACT_MAX_TOKENS,
          metadata: {
            task: MODEL_SERVING_TASKS.CARD_SMS_EXTRACT,
            promptVersion: PROMPT_VERSION,
            pipelineRunId,
          },
        },
      );
      responseText = response.text;
      traceId = response.traceId ?? null;
    } catch {
      // 호출 실패 — 에러 원문은 로그하지 않는다(프롬프트에 원문이 들어 있다).
      this.logger.warn(
        { householdId, fingerprint: shortFingerprint, outcome: 'llm_failed' },
        'card-sms llm extraction fallback: llm call failed',
      );
      return null;
    }

    const parsed = extractJsonObject(responseText);
    if (parsed === undefined) {
      this.logger.warn(
        { householdId, fingerprint: shortFingerprint, outcome: 'invalid_json' },
        'card-sms llm extraction fallback: response had no parsable JSON',
      );
      return null;
    }

    // span 확정과 정규화는 **원문**(masked 아님) 기준. 길이가 같으므로 정합한다.
    const { result, rejected } = buildResultFromSpans(
      input,
      toQuotes(parsed),
      toTransactionType(parsed),
      // 발급사 라벨은 LLM이 만들지 않는다 — 규칙 파서가 못 정하면 미상으로 둔다.
      '카드',
    );

    this.logger.info(
      {
        householdId,
        fingerprint: shortFingerprint,
        outcome: 'extracted',
        rejectedCount: rejected.length,
        confidence: result.confidence,
        hasAmount: result.amount !== undefined,
      },
      'card-sms llm extraction completed',
    );

    return { result, rejected, fingerprint, traceId };
  }

  /** 오늘(UTC) 이 태스크의 LLM 호출 수가 상한 미만인지 확인한다. */
  private async withinDailyBudget(): Promise<boolean> {
    if (this.dailyBudget <= 0) return false;
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    try {
      const [row] = await this.db
        .select({ total: count() })
        .from(schema.aiInvocations)
        .where(
          and(
            eq(schema.aiInvocations.task, MODEL_SERVING_TASKS.CARD_SMS_EXTRACT),
            gte(schema.aiInvocations.startedAt, since),
          ),
        );
      return (row?.total ?? 0) < this.dailyBudget;
    } catch {
      // 카운트 실패 시 보수적으로 차단한다(비용 폭주 방지).
      return false;
    }
  }
}
