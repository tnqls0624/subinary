/**
 * 파싱 품질 관측 payload 회귀 테스트(ADR-0023 §관측).
 *
 * 왜 테스트하는가: 이 payload는 `pipeline_step_runs.metrics`에 그대로 들어가고, 집계
 * 쿼리(`readCardSmsParserQuality`)가 **키 이름과 정수 타입**을 그대로 가정한다.
 * 키를 바꾸거나 boolean으로 되돌리면 SQL이 실패하지 않고 **조용히 0을 돌려준다** —
 * "거절률 0%"로 보이는 상태가 되어 문구 개편 감지가 죽는다.
 *
 * PII 검사도 여기서 한다. 나중에 누가 디버깅 편의로 가맹점명·문자 원문을 넣으면
 * 원문 없는 관측 규약(ADR-0017 · 스펙 §1.1)이 깨진다.
 */
import { describe, expect, it } from 'vitest';

import { createParseQualityProbe, parseQualityMetrics } from './parse-quality';

describe('parseQualityMetrics', () => {
  it('L0에서 끝난 건은 L1·L2 시도를 세지 않는다', () => {
    const probe = createParseQualityProbe();

    expect(parseQualityMetrics(probe, 'parsed')).toEqual({
      parseStatus: 'parsed',
      parseSource: 'rule',
      recipeAttempted: 0,
      recipeHit: 0,
      llmAttempted: 0,
      llmSpanRejected: 0,
      llmRejectedSpans: 0,
    });
  });

  it('레시피 히트는 시도와 히트를 함께 센다(분모 없이 비율을 만들 수 없다)', () => {
    const probe = createParseQualityProbe();
    probe.recipeAttempted = true;
    probe.recipeHit = true;
    probe.parseSource = 'recipe';

    const metrics = parseQualityMetrics(probe, 'parsed');

    expect(metrics.recipeAttempted).toBe(1);
    expect(metrics.recipeHit).toBe(1);
    expect(metrics.parseSource).toBe('recipe');
  });

  it('LLM 거절은 결과를 적용하지 않은 shadow 모드에서도 기록된다', () => {
    // shadow: 호출은 했고 유효 span도 못 냈지만 파싱 상태는 그대로 parse_failed.
    const probe = createParseQualityProbe();
    probe.recipeAttempted = true;
    probe.llmAttempted = true;
    probe.llmSpanRejected = true;
    probe.llmRejectedSpans = 3;

    const metrics = parseQualityMetrics(probe, 'parse_failed');

    expect(metrics.llmAttempted).toBe(1);
    expect(metrics.llmSpanRejected).toBe(1);
    expect(metrics.llmRejectedSpans).toBe(3);
    // 결과를 적용하지 않았으므로 확정 레이어는 여전히 rule이다.
    expect(metrics.parseSource).toBe('rule');
  });

  it('boolean이 아니라 0/1 정수로 저장한다(집계가 ::int 캐스팅을 쓴다)', () => {
    const probe = createParseQualityProbe();
    probe.llmAttempted = true;

    for (const [key, value] of Object.entries(parseQualityMetrics(probe, 'quarantined'))) {
      if (key === 'parseStatus' || key === 'parseSource') continue;
      expect(typeof value, `${key}는 정수여야 한다`).toBe('number');
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('PII가 될 수 있는 자유형식 필드를 담지 않는다', () => {
    const probe = createParseQualityProbe();
    probe.parseSource = 'llm-span';

    const metrics = parseQualityMetrics(probe, 'quarantined');

    // 키 집합을 고정한다 — 원문·가맹점명·금액 필드가 늘어나면 여기서 잡힌다.
    expect(Object.keys(metrics).sort()).toEqual([
      'llmAttempted',
      'llmRejectedSpans',
      'llmSpanRejected',
      'parseSource',
      'parseStatus',
      'recipeAttempted',
      'recipeHit',
    ]);
    // 문자열 값은 닫힌 열거값 두 개뿐이다.
    expect(['rule', 'recipe', 'llm-span']).toContain(metrics.parseSource);
    expect(['parsed', 'pending_review', 'parse_failed', 'quarantined']).toContain(
      metrics.parseStatus,
    );
  });
});
