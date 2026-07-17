/**
 * Google Gemini 기반 LLM provider (PRD 3.4 — 모델 비종속 경계의 실제 구현체).
 *
 * `generateContent` REST API를 순수 fetch로 호출한다(신규 npm 의존성 없음).
 * 거래 자동 분류 / 자연어 가계부 질의 / 월간 인사이트 등 LLM 기능이 사용한다.
 *
 * 로그 정책: API 키·프롬프트 원문·응답 원문은 절대 로그/에러 메시지에 담지 않는다.
 * 실패는 상태코드만 담은 Error로 던지며, 호출부는 결정적 폴백을 갖는다
 * (LLM 실패가 파이프라인을 중단시키지 않는 것이 프로젝트 규약).
 */
import type { GenerateRequest, GenerateResponse, LlmProvider } from './types.js';

/** {@link GeminiLlmProvider} 생성 옵션. */
export interface GeminiLlmOptions {
  /** Gemini API 키 (필수). 로그로 출력하지 않는다. */
  apiKey: string;
  /** 모델명 (기본: 'gemini-2.0-flash' — 분류/추출 용도에 충분하고 저렴). */
  model?: string;
  /** API base URL (기본: Google Generative Language API v1beta). */
  baseUrl?: string;
  /** 요청 타임아웃 ms (기본 30_000). */
  timeoutMs?: number;
}

/** generateContent 응답에서 사용하는 최소 형태. */
interface GeminiApiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * GenerateRequest를 단일 사용자 텍스트로 조립한다.
 * RAG 흐름(question+context)과 단독 prompt 호출을 모두 지원한다(Mock과 동일 규약).
 */
function buildUserText(req: GenerateRequest): string {
  if (req.prompt !== undefined && req.prompt.length > 0) {
    return req.prompt;
  }
  const parts: string[] = [];
  if (req.context && req.context.length > 0) {
    const passages = req.context
      .map((p, i) => `[${i + 1}] (${p.id})\n${p.text}`)
      .join('\n\n');
    parts.push(`다음은 근거 자료입니다:\n\n${passages}`);
  }
  if (req.question !== undefined && req.question.length > 0) {
    parts.push(`질문: ${req.question}`);
  }
  return parts.join('\n\n');
}

/** Gemini finishReason → 경계 타입 매핑. */
function mapFinishReason(reason: string | undefined): GenerateResponse['finishReason'] {
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  return reason === undefined ? 'stop' : 'error';
}

/** Google Gemini `generateContent` 기반 {@link LlmProvider}. */
export class GeminiLlmProvider implements LlmProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: GeminiLlmOptions) {
    if (!options || typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new Error('[@family/ai-providers] GeminiLlmProvider requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gemini-2.0-flash';
    this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const userText = buildUserText(req);
    if (userText.length === 0) {
      throw new Error('[@family/ai-providers] GenerateRequest has no prompt/question');
    }

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
    };
    if (req.system !== undefined && req.system.length > 0) {
      body.systemInstruction = { parts: [{ text: req.system }] };
    }

    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 키는 헤더로 전달한다(URL 쿼리는 로그에 남을 수 있음).
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );

    if (!response.ok) {
      // 응답 본문(키/원문 포함 가능)은 에러 메시지에 담지 않는다.
      throw new Error(
        `[@family/ai-providers] Gemini generateContent failed: ${response.status}`,
      );
    }

    const payload = (await response.json()) as GeminiApiResponse;
    const candidate = payload.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');

    return {
      text,
      model: this.model,
      finishReason: mapFinishReason(candidate?.finishReason),
      usage: {
        inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
