/**
 * ADR-0023 파서 품질 지표 파생 규칙 회귀 테스트.
 *
 * 왜 여기서 테스트하는가: 이 지표의 존재 이유는 **카드사 문구 개편 조기 감지**다.
 * 표본이 0일 때 비율을 `0`으로 내보내면 "거절률 0% — 파서 완벽"으로 읽히는데 실제
 * 뜻은 "LLM을 한 번도 안 불렀다"다(현재 `CARD_SMS_LLM_MODE=off`). 그 혼동이 생기면
 * 지표가 있으나 없으나 같아지므로 `null` 구분을 고정한다. DB는 필요 없다.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CARD_SMS_FEEDBACK_TARGET_TYPE,
  CARD_SMS_PARSE_PIPELINE,
  CARD_SMS_PARSE_STEP,
  CARD_SMS_REVIEW_BACKLOG_STATUSES,
  computeCardSmsParserQuality,
} from '../dist/index.js';

const WINDOW_START = new Date('2026-08-01T00:00:00.000Z');

function counts(overrides = {}) {
  return {
    llmAttempted: 0,
    llmSpanRejected: 0,
    recipeAttempted: 0,
    recipeHit: 0,
    parsedEvents: 0,
    humanCorrections: 0,
    ...overrides,
  };
}

describe('computeCardSmsParserQuality', () => {
  it('표본이 없으면 0이 아니라 null을 돌려준다', () => {
    const quality = computeCardSmsParserQuality(counts(), 0, WINDOW_START);

    assert.equal(quality.llmSpanRejectRate, null);
    assert.equal(quality.humanCorrectionRate, null);
    assert.equal(quality.templateCacheHitRate, null);
    assert.equal(quality.reviewBacklogCount, 0);
    assert.equal(quality.windowStart, '2026-08-01T00:00:00.000Z');
  });

  it('거절이 0건이어도 호출이 있었다면 0.0을 보고한다(null과 구분된다)', () => {
    const quality = computeCardSmsParserQuality(
      counts({ llmAttempted: 12, llmSpanRejected: 0 }),
      0,
      WINDOW_START,
    );

    assert.equal(quality.llmSpanRejectRate, 0);
    assert.notEqual(quality.llmSpanRejectRate, null);
  });

  it('세 비율을 각자의 분모로 계산한다', () => {
    const quality = computeCardSmsParserQuality(
      counts({
        llmAttempted: 8,
        llmSpanRejected: 2,
        recipeAttempted: 5,
        recipeHit: 4,
        parsedEvents: 40,
        humanCorrections: 3,
      }),
      7,
      WINDOW_START,
    );

    assert.equal(quality.llmSpanRejectRate, 0.25);
    assert.equal(quality.templateCacheHitRate, 0.8);
    assert.equal(quality.humanCorrectionRate, 0.075);
    assert.equal(quality.reviewBacklogCount, 7);
  });

  it('소수 4자리로 끊는다', () => {
    const quality = computeCardSmsParserQuality(
      counts({ llmAttempted: 3, llmSpanRejected: 1 }),
      0,
      WINDOW_START,
    );

    assert.equal(quality.llmSpanRejectRate, 0.3333);
  });

  it('원자료를 함께 돌려준다 — 비율만으로는 표본 크기를 알 수 없다', () => {
    const raw = counts({ llmAttempted: 1, llmSpanRejected: 1 });
    const quality = computeCardSmsParserQuality(raw, 0, WINDOW_START);

    // 1/1 = 100%지만 표본 1건이다. 임계값 판단은 counts를 봐야 한다.
    assert.equal(quality.llmSpanRejectRate, 1);
    assert.deepEqual(quality.counts, raw);
  });

  it('집계 식별자가 워커/리뷰 서비스와 같은 값이다', () => {
    // 이 값이 어긋나면 쿼리는 성공하고 지표만 0이 된다 — 가장 조용한 고장이다.
    assert.equal(CARD_SMS_PARSE_PIPELINE, 'card-sms-parse');
    assert.equal(CARD_SMS_PARSE_STEP, 'parse-and-promote');
    assert.equal(CARD_SMS_FEEDBACK_TARGET_TYPE, 'card-sms-parse');
    // pending_review는 이미 거래로 승격되므로 적체가 아니다.
    assert.deepEqual([...CARD_SMS_REVIEW_BACKLOG_STATUSES], [
      'quarantined',
      'parse_failed',
    ]);
  });
});
