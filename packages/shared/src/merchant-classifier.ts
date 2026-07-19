/** 가맹점명 문자 n-gram 기반 결정적 다항 나이브 베이즈 분류기. */

export type MerchantDatasetSplit = 'train' | 'validation' | 'test';

export interface MerchantClassifierTrainingRow {
  merchantPattern: string;
  categoryId: string;
  categorySlug: string;
  split: MerchantDatasetSplit;
}

export interface MerchantClassifierFeatureConfig {
  normalization: 'nfkc-lower-whitespace-v1';
  minimumNgramSize: number;
  maximumNgramSize: number;
  alpha: number;
}

export interface MerchantClassifierLabelModel {
  categoryId: string;
  categorySlug: string;
  documentCount: number;
  totalTokenCount: number;
  tokenCounts: Record<string, number>;
}

export interface MerchantClassifierModel {
  schemaVersion: 'merchant-char-ngram-nb-v1';
  algorithm: 'multinomial-naive-bayes';
  featureConfig: MerchantClassifierFeatureConfig;
  trainingDocumentCount: number;
  vocabulary: string[];
  labels: MerchantClassifierLabelModel[];
}

export interface MerchantClassifierPrediction {
  categoryId: string;
  categorySlug: string;
  confidence: number;
  scores: Record<string, number>;
}

export interface MerchantClassifierMetrics {
  rowCount: number;
  correctCount: number;
  accuracy: number;
  macroF1: number;
}

const DEFAULT_FEATURE_CONFIG: MerchantClassifierFeatureConfig = {
  normalization: 'nfkc-lower-whitespace-v1',
  minimumNgramSize: 2,
  maximumNgramSize: 4,
  alpha: 1,
};

/** 가맹점명을 모델과 추론에서 동일하게 정규화한다. */
export function normalizeMerchantFeature(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function extractCharacterNgrams(
  value: string,
  config: MerchantClassifierFeatureConfig,
): string[] {
  const normalized = normalizeMerchantFeature(value);
  if (normalized.length === 0) {
    throw new Error('merchant classifier input must not be empty');
  }
  const bounded = `^${normalized}$`;
  const tokens: string[] = [];
  for (
    let size = config.minimumNgramSize;
    size <= config.maximumNgramSize;
    size += 1
  ) {
    for (let index = 0; index + size <= bounded.length; index += 1) {
      tokens.push(bounded.slice(index, index + size));
    }
  }
  return tokens;
}

function validateFeatureConfig(config: MerchantClassifierFeatureConfig): void {
  if (
    config.normalization !== 'nfkc-lower-whitespace-v1' ||
    !Number.isInteger(config.minimumNgramSize) ||
    !Number.isInteger(config.maximumNgramSize) ||
    config.minimumNgramSize < 1 ||
    config.maximumNgramSize < config.minimumNgramSize ||
    config.maximumNgramSize > 8 ||
    !Number.isFinite(config.alpha) ||
    config.alpha <= 0
  ) {
    throw new Error('merchant classifier feature configuration is invalid');
  }
}

/** train split만 사용해 정렬 순서까지 결정적인 모델을 만든다. */
export function trainMerchantClassifier(
  rows: readonly MerchantClassifierTrainingRow[],
  featureConfig: MerchantClassifierFeatureConfig = DEFAULT_FEATURE_CONFIG,
): MerchantClassifierModel {
  validateFeatureConfig(featureConfig);
  const trainingRows = rows.filter((row) => row.split === 'train');
  if (trainingRows.length === 0) {
    throw new Error('merchant classifier requires at least one training row');
  }

  const labels = new Map<
    string,
    {
      categoryId: string;
      categorySlug: string;
      documentCount: number;
      totalTokenCount: number;
      tokenCounts: Map<string, number>;
    }
  >();
  const vocabulary = new Set<string>();

  for (const row of trainingRows) {
    if (
      row.categoryId.trim().length === 0 ||
      row.categorySlug.trim().length === 0
    ) {
      throw new Error('merchant classifier label must not be empty');
    }
    const existing = labels.get(row.categoryId);
    if (existing && existing.categorySlug !== row.categorySlug) {
      throw new Error('merchant classifier category identity is inconsistent');
    }
    const label = existing ?? {
      categoryId: row.categoryId,
      categorySlug: row.categorySlug,
      documentCount: 0,
      totalTokenCount: 0,
      tokenCounts: new Map<string, number>(),
    };
    const tokens = extractCharacterNgrams(row.merchantPattern, featureConfig);
    label.documentCount += 1;
    label.totalTokenCount += tokens.length;
    for (const token of tokens) {
      vocabulary.add(token);
      label.tokenCounts.set(token, (label.tokenCounts.get(token) ?? 0) + 1);
    }
    labels.set(row.categoryId, label);
  }
  if (labels.size < 2) {
    throw new Error('merchant classifier requires at least two label classes');
  }

  return {
    schemaVersion: 'merchant-char-ngram-nb-v1',
    algorithm: 'multinomial-naive-bayes',
    featureConfig: { ...featureConfig },
    trainingDocumentCount: trainingRows.length,
    vocabulary: [...vocabulary].sort(),
    labels: [...labels.values()]
      .sort((left, right) => left.categoryId.localeCompare(right.categoryId))
      .map((label) => ({
        categoryId: label.categoryId,
        categorySlug: label.categorySlug,
        documentCount: label.documentCount,
        totalTokenCount: label.totalTokenCount,
        tokenCounts: Object.fromEntries(
          [...label.tokenCounts.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      })),
  };
}

/** 모델 구조와 수치 불변식을 검사한다. */
export function assertMerchantClassifierModel(
  value: unknown,
): asserts value is MerchantClassifierModel {
  if (value === null || typeof value !== 'object') {
    throw new Error('merchant classifier model must be an object');
  }
  const model = value as Partial<MerchantClassifierModel>;
  if (
    model.schemaVersion !== 'merchant-char-ngram-nb-v1' ||
    model.algorithm !== 'multinomial-naive-bayes' ||
    model.featureConfig === undefined ||
    !Number.isInteger(model.trainingDocumentCount) ||
    (model.trainingDocumentCount ?? 0) < 1 ||
    !Array.isArray(model.vocabulary) ||
    !Array.isArray(model.labels) ||
    model.labels.length < 2
  ) {
    throw new Error('merchant classifier model metadata is invalid');
  }
  validateFeatureConfig(model.featureConfig);
  const vocabulary = new Set(model.vocabulary);
  if (
    vocabulary.size !== model.vocabulary.length ||
    model.vocabulary.some((token) => typeof token !== 'string' || token.length === 0)
  ) {
    throw new Error('merchant classifier vocabulary is invalid');
  }
  let documentCount = 0;
  const categoryIds = new Set<string>();
  for (const label of model.labels) {
    if (
      label === null ||
      typeof label !== 'object' ||
      typeof label.categoryId !== 'string' ||
      label.categoryId.length === 0 ||
      typeof label.categorySlug !== 'string' ||
      label.categorySlug.length === 0 ||
      !Number.isInteger(label.documentCount) ||
      label.documentCount < 1 ||
      !Number.isInteger(label.totalTokenCount) ||
      label.totalTokenCount < 1 ||
      label.tokenCounts === null ||
      typeof label.tokenCounts !== 'object'
    ) {
      throw new Error('merchant classifier label model is invalid');
    }
    if (categoryIds.has(label.categoryId)) {
      throw new Error('merchant classifier category is duplicated');
    }
    categoryIds.add(label.categoryId);
    documentCount += label.documentCount;
    const tokenCountEntries = Object.entries(label.tokenCounts);
    if (
      tokenCountEntries.some(
        ([token, count]) =>
          !vocabulary.has(token) || !Number.isInteger(count) || count < 1,
      ) ||
      tokenCountEntries.reduce((sum, [, count]) => sum + count, 0) !==
        label.totalTokenCount
    ) {
      throw new Error('merchant classifier token counts are invalid');
    }
  }
  if (documentCount !== model.trainingDocumentCount) {
    throw new Error('merchant classifier training count is inconsistent');
  }
}

/** 로그 확률을 안정적인 확률로 변환해 가장 높은 카테고리를 반환한다. */
export function predictMerchantCategory(
  model: MerchantClassifierModel,
  merchantPattern: string,
): MerchantClassifierPrediction {
  assertMerchantClassifierModel(model);
  const tokens = extractCharacterNgrams(merchantPattern, model.featureConfig);
  const tokenFrequency = new Map<string, number>();
  for (const token of tokens) {
    if (model.vocabulary.includes(token)) {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    }
  }
  const vocabularySize = Math.max(model.vocabulary.length, 1);
  const logScores = model.labels.map((label) => {
    let score = Math.log(label.documentCount / model.trainingDocumentCount);
    const denominator =
      label.totalTokenCount + model.featureConfig.alpha * vocabularySize;
    for (const [token, count] of tokenFrequency) {
      const numerator =
        (label.tokenCounts[token] ?? 0) + model.featureConfig.alpha;
      score += count * Math.log(numerator / denominator);
    }
    return { label, score };
  });
  logScores.sort(
    (left, right) =>
      right.score - left.score ||
      left.label.categoryId.localeCompare(right.label.categoryId),
  );
  const winner = logScores[0];
  if (!winner) {
    throw new Error('merchant classifier has no labels');
  }
  const maximum = winner.score;
  const denominator = logScores.reduce(
    (sum, item) => sum + Math.exp(item.score - maximum),
    0,
  );
  const probabilities = Object.fromEntries(
    logScores.map((item) => [
      item.label.categoryId,
      Math.exp(item.score - maximum) / denominator,
    ]),
  );
  return {
    categoryId: winner.label.categoryId,
    categorySlug: winner.label.categorySlug,
    confidence: probabilities[winner.label.categoryId] ?? 0,
    scores: probabilities,
  };
}

/** 지정 split의 accuracy와 macro F1을 원문 없이 계산한다. */
export function evaluateMerchantClassifier(
  model: MerchantClassifierModel,
  rows: readonly MerchantClassifierTrainingRow[],
  split: MerchantDatasetSplit,
): MerchantClassifierMetrics {
  const evaluationRows = rows.filter((row) => row.split === split);
  if (evaluationRows.length === 0) {
    return { rowCount: 0, correctCount: 0, accuracy: 0, macroF1: 0 };
  }
  const labels = new Set(model.labels.map((label) => label.categoryId));
  const truePositive = new Map<string, number>();
  const falsePositive = new Map<string, number>();
  const falseNegative = new Map<string, number>();
  let correctCount = 0;
  for (const row of evaluationRows) {
    const prediction = predictMerchantCategory(model, row.merchantPattern);
    labels.add(row.categoryId);
    if (prediction.categoryId === row.categoryId) {
      correctCount += 1;
      truePositive.set(
        row.categoryId,
        (truePositive.get(row.categoryId) ?? 0) + 1,
      );
    } else {
      falsePositive.set(
        prediction.categoryId,
        (falsePositive.get(prediction.categoryId) ?? 0) + 1,
      );
      falseNegative.set(
        row.categoryId,
        (falseNegative.get(row.categoryId) ?? 0) + 1,
      );
    }
  }
  const macroF1 =
    [...labels].reduce((sum, label) => {
      const tp = truePositive.get(label) ?? 0;
      const fp = falsePositive.get(label) ?? 0;
      const fn = falseNegative.get(label) ?? 0;
      const denominator = 2 * tp + fp + fn;
      return sum + (denominator === 0 ? 0 : (2 * tp) / denominator);
    }, 0) / labels.size;
  return {
    rowCount: evaluationRows.length,
    correctCount,
    accuracy: correctCount / evaluationRows.length,
    macroF1,
  };
}
