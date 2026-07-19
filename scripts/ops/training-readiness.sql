/*
 * 원문·가맹점명을 출력하지 않는 merchant-category 학습 준비도 보고서.
 * scope_key는 household UUID의 SHA-256 앞 12자리이며 metric label로 사용하지 않는다.
 */
WITH human_rules AS (
  SELECT
    rule.household_id,
    rule.category_id,
    encode(
      sha256(
        convert_to(
          '[' || to_jsonb(rule.household_id::text)::text || ',' ||
          to_jsonb(rule.merchant_pattern)::text || ']',
          'UTF8'
        )
      ),
      'hex'
    ) AS target_id
  FROM merchant_category_rules AS rule
  WHERE rule.source = 'human_confirmed'
    AND rule.confirmed_at IS NOT NULL
),
class_counts AS (
  SELECT household_id, category_id, count(*) AS label_count
  FROM human_rules
  GROUP BY household_id, category_id
),
rule_stats AS (
  SELECT
    household_id,
    count(*) AS human_labels,
    count(DISTINCT category_id) AS class_count
  FROM human_rules
  GROUP BY household_id
),
class_stats AS (
  SELECT household_id, min(label_count) AS minimum_class_labels
  FROM class_counts
  GROUP BY household_id
),
lineage_stats AS (
  SELECT
    rule.household_id,
    count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM feedback_events AS feedback
        WHERE feedback.household_id = rule.household_id
          AND feedback.target_type = 'merchant-category'
          AND feedback.target_id = rule.target_id
          AND feedback.source = 'human_confirmed'
          AND feedback.label ->> 'categoryId' = rule.category_id::text
      )
    ) AS missing_lineage
  FROM human_rules AS rule
  GROUP BY rule.household_id
),
merchant_transactions AS (
  SELECT household_id, merchant_normalized, count(*) AS transaction_count
  FROM card_transactions
  WHERE merchant_normalized IS NOT NULL
    AND btrim(merchant_normalized) <> ''
  GROUP BY household_id, merchant_normalized
),
opportunity_stats AS (
  SELECT
    merchant.household_id,
    count(*) AS distinct_merchants,
    sum(merchant.transaction_count) AS transaction_count,
    count(*) FILTER (WHERE rule.source = 'human_confirmed') AS human_rule_merchants,
    count(*) FILTER (WHERE rule.source = 'model_prediction') AS model_prediction_merchants,
    count(*) FILTER (WHERE rule.id IS NULL) AS unlabeled_merchants
  FROM merchant_transactions AS merchant
  LEFT JOIN merchant_category_rules AS rule
    ON rule.household_id = merchant.household_id
   AND rule.merchant_pattern = merchant.merchant_normalized
  GROUP BY merchant.household_id
),
readiness AS (
  SELECT
    encode(sha256(convert_to(household.id::text, 'UTF8')), 'hex') AS scope_hash,
    coalesce(rule.human_labels, 0) AS human_labels,
    coalesce(rule.class_count, 0) AS class_count,
    coalesce(class.minimum_class_labels, 0) AS minimum_class_labels,
    coalesce(lineage.missing_lineage, 0) AS missing_lineage,
    coalesce(opportunity.distinct_merchants, 0) AS distinct_merchants,
    coalesce(opportunity.transaction_count, 0) AS transaction_count,
    coalesce(opportunity.human_rule_merchants, 0) AS human_rule_merchants,
    coalesce(opportunity.model_prediction_merchants, 0) AS model_prediction_merchants,
    coalesce(opportunity.unlabeled_merchants, 0) AS unlabeled_merchants
  FROM households AS household
  LEFT JOIN rule_stats AS rule ON rule.household_id = household.id
  LEFT JOIN class_stats AS class ON class.household_id = household.id
  LEFT JOIN lineage_stats AS lineage ON lineage.household_id = household.id
  LEFT JOIN opportunity_stats AS opportunity ON opportunity.household_id = household.id
)
SELECT
  left(scope_hash, 12) AS scope_key,
  human_labels,
  class_count AS classes,
  minimum_class_labels,
  missing_lineage,
  distinct_merchants,
  transaction_count AS transactions,
  human_rule_merchants,
  model_prediction_merchants,
  unlabeled_merchants,
  CASE
    WHEN missing_lineage = 0
      AND human_labels >= :minimum_labels
      AND class_count >= :minimum_classes
      AND minimum_class_labels >= :minimum_labels_per_class
    THEN 'READY'
    ELSE 'COLLECT_LABELS'
  END AS training_status,
  concat_ws(
    ', ',
    CASE WHEN missing_lineage > 0 THEN '계보 누락' END,
    CASE WHEN human_labels < :minimum_labels THEN '전체 라벨 부족' END,
    CASE WHEN class_count < :minimum_classes THEN '클래스 부족' END,
    CASE WHEN minimum_class_labels < :minimum_labels_per_class THEN '클래스별 라벨 부족' END
  ) AS blocking_reasons
FROM readiness
ORDER BY scope_key;
