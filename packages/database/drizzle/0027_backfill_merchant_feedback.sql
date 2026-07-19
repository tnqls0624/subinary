/*
 * feedback_events 도입 전에 사람이 만든 가맹점 규칙은 0013에서
 * human_confirmed/confirmed_at으로 분류됐지만 append-only feedback 계보가 없다.
 * 현재 규칙과 동일한 확정 feedback이 없는 경우에만 멱등 보강한다.
 * target_id는 애플리케이션의 SHA-256(JSON.stringify([householdId, merchantPattern]))와
 * 동일하게 공백 없는 JSON 배열을 만든다.
 */
INSERT INTO "feedback_events" (
  "household_id",
  "target_type",
  "target_id",
  "label_schema_version",
  "label",
  "source",
  "actor_user_id",
  "occurred_at"
)
SELECT
  rule."household_id",
  'merchant-category',
  encode(
    sha256(
      convert_to(
        '[' || to_jsonb(rule."household_id"::text)::text || ',' ||
        to_jsonb(rule."merchant_pattern")::text || ']',
        'UTF8'
      )
    ),
    'hex'
  ),
  'merchant-category-v1',
  jsonb_build_object('categoryId', rule."category_id"),
  'human_confirmed',
  rule."created_by",
  rule."confirmed_at"
FROM "merchant_category_rules" AS rule
WHERE rule."source" = 'human_confirmed'
  AND rule."confirmed_at" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "feedback_events" AS feedback
    WHERE feedback."household_id" = rule."household_id"
      AND feedback."target_type" = 'merchant-category'
      AND feedback."target_id" = encode(
        sha256(
          convert_to(
            '[' || to_jsonb(rule."household_id"::text)::text || ',' ||
            to_jsonb(rule."merchant_pattern")::text || ']',
            'UTF8'
          )
        ),
        'hex'
      )
      AND feedback."source" = 'human_confirmed'
      AND feedback."label" ->> 'categoryId' = rule."category_id"::text
  );
