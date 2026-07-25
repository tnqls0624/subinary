/**
 * L1 — 템플릿 레시피 추출 (ADR-0023 S4).
 *
 * 규칙 파서(L0)가 못 읽은 문자를 **LLM보다 먼저** 처리한다. 사람이 한 번 확정해
 * 레시피가 생긴 레이아웃이면 여기서 끝나고 LLM 호출이 0회가 된다.
 *
 * 지문 일치는 **exact match**다 — 확률 라우팅이 아니므로 "비슷한 템플릿"으로
 * 잘못 보내는 오탐이 원리적으로 없다. 미지 레이아웃은 그냥 미스가 나고 L2로 넘어간다.
 * 오탐(틀린 금액이 조용히 승격)이 미탐(사람이 한 번 더 확인)보다 훨씬 위험하다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  applyRecipe,
  templateFingerprint,
  type CardSmsInput,
  type SpanExtraction,
  type TemplateRecipe,
} from '@family/card-parsers';
import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';
import { createLogger } from '@family/shared';
import { eq, sql } from 'drizzle-orm';

import { DB } from '../database/database.module';

function isRecipe(value: unknown): value is TemplateRecipe {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<TemplateRecipe>;
  return (
    candidate.schemaVersion === 'card-sms-recipe-v1' &&
    typeof candidate.fingerprint === 'string' &&
    candidate.fields !== null &&
    typeof candidate.fields === 'object'
  );
}

@Injectable()
export class TemplateRecipeService {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    @Inject(DB) private readonly db: Db,
    configService: ConfigService,
  ) {
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:template-recipe', {
      pretty: nodeEnv !== 'production',
    });
  }

  /** 지문에 등록된 레시피가 있으면 적용 결과를, 없으면 null을 돌려준다. */
  async extract(input: CardSmsInput): Promise<SpanExtraction | null> {
    const fingerprint = templateFingerprint(input.sender, input.content);
    const [row] = await this.db
      .select({ recipe: schema.cardSmsTemplates.recipe })
      .from(schema.cardSmsTemplates)
      .where(eq(schema.cardSmsTemplates.fingerprint, fingerprint))
      .limit(1);
    if (!row || !isRecipe(row.recipe)) return null;

    const extraction = applyRecipe(input, row.recipe);

    // 적용 횟수는 관측용이라 실패해도 파싱을 막지 않는다.
    try {
      await this.db
        .update(schema.cardSmsTemplates)
        .set({ hitCount: sql`${schema.cardSmsTemplates.hitCount} + 1` })
        .where(eq(schema.cardSmsTemplates.fingerprint, fingerprint));
    } catch {
      // 무시 — 카운터는 best-effort.
    }

    this.logger.info(
      {
        fingerprint: fingerprint.slice(0, 12),
        rejectedCount: extraction.rejected.length,
        hasAmount: extraction.result.amount !== undefined,
      },
      'card-sms template recipe applied',
    );
    return extraction;
  }
}
