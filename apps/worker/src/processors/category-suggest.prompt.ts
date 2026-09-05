/**
 * 가맹점 카테고리 제안 프롬프트 — v2.
 *
 * ## 왜 바꿨나 (2026-09-05 실측)
 *
 * v1의 정밀도는 **68.6%**였다(사람이 판단한 70건 중 48건 동의, 22건 뒤집음).
 * 뒤집힌 22건의 혼동 패턴이 개선 방향을 그대로 가리켰다:
 *
 *   장보기 → 식비                    5건
 *   기타   → 식비·카페·쇼핑·관리비   7건   ← 전체 오답의 32%
 *   식비   → 카페                    2건
 *   쇼핑   → 구독                    2건
 *
 * ### 문제 1: "모르겠다"를 말할 수단이 없었다
 *
 * v1은 "가장 알맞은 slug 하나를 고르세요"라고만 했다. 확신이 없어도 반드시 하나를
 * 골라야 하니 모델이 **`기타`로 던졌고**, 그것이 오답의 3분의 1이다.
 *
 * `기타`는 정보가 없는 답이고 사용자가 어차피 고쳐야 한다. 그럴 바에는 **미분류로
 * 두는 편이 정직하다** — 미분류는 "아직 안 정했다"이고, `기타`는 "정했는데 기타"라서
 * 화면이 사실과 다른 말을 한다.
 *
 * 미분류로 두는 경로는 이미 있었다(`no_valid_suggestion`). 모델에게 그 문을 알려
 * 주지 않았을 뿐이다.
 *
 * ### 문제 2: 이 가족이 어떻게 분류하는지 알려주지 않았다
 *
 * 사람이 확정한 규칙이 109건 쌓여 있는데 프롬프트는 가맹점명 하나와 slug 목록만
 * 줬다. "편의점을 식비로 볼지 장보기로 볼지"는 보편 정답이 없고 **가족마다 다른
 * 습관**이다. 실측 혼동의 최다 패턴(장보기→식비 5건)이 정확히 그것이다.
 *
 * 그래서 이 가족의 확정 예시를 함께 보낸다. 모델이 규칙을 새로 배우는 것이 아니라
 * **이 집의 기준을 참고**하게 하는 것이다.
 *
 * ## PII
 *
 * 보내는 것은 가맹점명과 카테고리뿐이다. 금액·날짜·구성원은 넣지 않는다 — 지시서
 * §3-5가 정한 최소 전송 원칙이고, 예시를 더한다고 그 경계가 바뀌지 않는다.
 */

/**
 * ## 개선을 어떻게 확인하는가
 *
 * 기준선은 v1의 **68.6%**다(2026-09-05). 같은 방식으로 다시 세면 v2를 판정할 수 있다.
 *
 * ```sql
 * -- 모델 예측을 사람이 뒤집었는가
 * with p as (
 *   select distinct on (target_id) target_id, label->>'categoryId' cat
 *   from feedback_events
 *   where target_type='merchant-category' and source='model_prediction'
 *   order by target_id, occurred_at desc
 * ), h as (
 *   select distinct on (target_id) target_id, label->>'categoryId' cat
 *   from feedback_events
 *   where target_type='merchant-category' and source='human_confirmed'
 *   order by target_id, occurred_at desc
 * )
 * select count(*) filter (where h.cat = p.cat)                        as 동의,
 *        count(*) filter (where h.cat is not null and h.cat <> p.cat) as 뒤집힘
 * from p left join h using (target_id);
 * ```
 *
 * **주의 — 이 수치는 즉시 움직이지 않는다.** 분모는 "사람이 판단한 예측"이라 새 예측이
 * 쌓이고 사용자가 그것을 보고 고치거나 두어야 채워진다. v1 표본 70건이 두 달치였으므로
 * v2도 비슷한 시간이 필요하다. 배포 다음 날 재고 "개선됐다"고 말하면 안 된다.
 *
 * v1과 v2를 나눠 세려면 `ai_invocations.prompt_version`으로 기간을 가른다 —
 * `feedback_events`에는 버전이 없으므로 시각으로 잇는다.
 *
 * ## 이 변경이 실패할 수 있는 지점
 *
 * `{"slug":null}`이 늘면 정밀도는 오르지만 **자동 분류량이 준다.** 사용자가 직접
 * 분류해야 하는 건수가 늘면 그건 개선이 아니다. 그래서 정밀도와 함께
 * `outcome='no_valid_suggestion'` 비율도 봐야 한다(로그에 남는다).
 */

/** 프롬프트 버전. `ai_invocations.prompt_version`에 남아 v1과 정밀도를 비교할 수 있다. */
export const CATEGORY_PROMPT_VERSION = 'merchant-category-v2';

/**
 * few-shot 예시의 카테고리당 개수.
 *
 * 2인 이유: 카테고리 하나에 예시가 하나뿐이면 그 가맹점의 특수성인지 카테고리의
 * 성격인지 구분되지 않는다. 셋 이상은 프롬프트가 길어져 비용이 늘고, 실측 카테고리가
 * 15개라 2개씩만 해도 30줄이 된다.
 */
export const EXAMPLES_PER_CATEGORY = 2;

/** 프롬프트에 넣을 확정 예시 하나. */
export interface CategoryExample {
  merchantPattern: string;
  slug: string;
}

/** 후보 카테고리 하나. */
export interface CategoryCandidate {
  slug: string;
  name: string;
}

/**
 * 사람이 확정한 규칙에서 few-shot 예시를 고른다.
 *
 * **결정적으로 고른다** — 카테고리별로 가맹점명 사전순 앞에서 {@link EXAMPLES_PER_CATEGORY}개.
 * 무작위나 최근순으로 뽑으면 같은 입력이 호출마다 다른 프롬프트를 만들고, 그러면
 * 정밀도가 변해도 원인이 프롬프트인지 예시인지 말할 수 없다.
 *
 * 예측 대상 자신은 제외한다. 답을 프롬프트에 넣고 맞히게 하는 것은 측정이 아니다
 * (실제로는 규칙이 있으면 LLM을 부르지도 않지만, 이 함수만 따로 쓰일 수 있다).
 */
export function selectCategoryExamples(
  rules: readonly CategoryExample[],
  targetMerchant: string,
  perCategory = EXAMPLES_PER_CATEGORY,
): CategoryExample[] {
  const bySlug = new Map<string, CategoryExample[]>();
  for (const rule of rules) {
    if (rule.merchantPattern === targetMerchant) continue;
    const bucket = bySlug.get(rule.slug) ?? [];
    bucket.push(rule);
    bySlug.set(rule.slug, bucket);
  }
  const picked: CategoryExample[] = [];
  // slug 사전순으로 순회해 결과 순서까지 고정한다.
  for (const slug of [...bySlug.keys()].sort()) {
    const bucket = (bySlug.get(slug) as CategoryExample[])
      .slice()
      .sort((a, b) => a.merchantPattern.localeCompare(b.merchantPattern));
    picked.push(...bucket.slice(0, perCategory));
  }
  return picked;
}

/** system 프롬프트. */
export function buildCategorySystemPrompt(): string {
  return (
    '당신은 한국 가계부 카테고리 분류기입니다. 가맹점명을 보고 주어진 slug 목록에서 ' +
    '가장 알맞은 카테고리 slug 하나를 고르세요. ' +
    // 이 한 줄이 v2의 핵심이다. 확신 없는 답을 강요하면 모델은 `기타`로 던지고,
    // 그것이 v1 오답의 32%였다.
    '확신이 없으면 억지로 고르지 말고 {"slug":null}을 출력하세요. ' +
    '모르는 것을 "기타"로 분류하는 것보다 비워 두는 편이 낫습니다. ' +
    '반드시 JSON {"slug":"..."} 또는 {"slug":null} 형식만 출력하세요.'
  );
}

/**
 * user 프롬프트.
 *
 * 예시가 없으면(첫 사용자·신규 가구) 그 절을 통째로 뺀다 — 빈 목록을 "참고 예시:"
 * 라는 제목과 함께 보내면 모델이 "예시가 없다"를 신호로 읽는다.
 */
export function buildCategoryUserPrompt(input: {
  merchantName: string;
  candidates: readonly CategoryCandidate[];
  examples: readonly CategoryExample[];
}): string {
  const slugList = input.candidates
    .map((c) => `${c.slug}(${c.name})`)
    .join(', ');
  const lines = [`가맹점명: ${input.merchantName}`, `카테고리 slug 목록: ${slugList}`];

  if (input.examples.length > 0) {
    lines.push(
      '',
      '이 가족이 지금까지 확정한 분류(같은 기준으로 판단하세요):',
      ...input.examples.map((e) => `- ${e.merchantPattern} → ${e.slug}`),
    );
  }

  lines.push(
    '',
    '위 목록에 있는 slug 하나만 골라 JSON {"slug":"..."}로 출력하세요.',
    '판단이 어려우면 {"slug":null}을 출력하세요.',
  );
  return lines.join('\n');
}
