import { describe, expect, it } from 'vitest';

import {
  assertMerchantClassifierModel,
  evaluateMerchantClassifier,
  normalizeMerchantFeature,
  predictMerchantCategory,
  trainMerchantClassifier,
  type MerchantClassifierTrainingRow,
} from './merchant-classifier.js';

const rows: MerchantClassifierTrainingRow[] = [
  { merchantPattern: '스타벅스 강남', categoryId: 'cafe', categorySlug: 'cafe', split: 'train' },
  { merchantPattern: '스타벅스 역삼', categoryId: 'cafe', categorySlug: 'cafe', split: 'train' },
  { merchantPattern: '투썸플레이스 강남', categoryId: 'cafe', categorySlug: 'cafe', split: 'validation' },
  { merchantPattern: 'GS25 강남', categoryId: 'store', categorySlug: 'convenience', split: 'train' },
  { merchantPattern: 'GS25 역삼', categoryId: 'store', categorySlug: 'convenience', split: 'train' },
  { merchantPattern: 'GS25 선릉', categoryId: 'store', categorySlug: 'convenience', split: 'validation' },
];

describe('merchant classifier', () => {
  it('동일 입력으로 동일 모델을 만들고 유사 가맹점을 분류한다', () => {
    const first = trainMerchantClassifier(rows);
    const second = trainMerchantClassifier([...rows].reverse());

    expect(first).toEqual(second);
    expect(predictMerchantCategory(first, '스타벅스 서초').categoryId).toBe(
      'cafe',
    );
    expect(predictMerchantCategory(first, 'GS25 서초').categoryId).toBe(
      'store',
    );
    expect(evaluateMerchantClassifier(first, rows, 'validation')).toMatchObject({
      rowCount: 2,
      correctCount: 2,
      accuracy: 1,
      macroF1: 1,
    });
  });

  it('유니코드와 공백을 일관되게 정규화한다', () => {
    expect(normalizeMerchantFeature('  ＧＳ２５   강남  ')).toBe('gs25 강남');
  });

  it('손상된 모델과 단일 클래스 학습을 거부한다', () => {
    expect(() =>
      trainMerchantClassifier(rows.filter((row) => row.categoryId === 'cafe')),
    ).toThrow('at least two label classes');
    expect(() =>
      assertMerchantClassifierModel({
        schemaVersion: 'merchant-char-ngram-nb-v1',
        algorithm: 'multinomial-naive-bayes',
      }),
    ).toThrow('metadata is invalid');
  });

  it('빈 평가 split은 0 지표로 안전하게 반환한다', () => {
    const model = trainMerchantClassifier(rows);
    expect(evaluateMerchantClassifier(model, rows, 'test')).toEqual({
      rowCount: 0,
      correctCount: 0,
      accuracy: 0,
      macroF1: 0,
    });
  });
});
