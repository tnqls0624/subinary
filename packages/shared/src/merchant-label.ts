import { createHash } from 'node:crypto';

/**
 * 가맹점 원문을 feedback 계보에 저장하지 않도록 household 범위의 안정적인
 * target id를 생성한다. dataset 생성과 라벨 확정 경로가 반드시 함께 사용한다.
 */
export function createMerchantCategoryTargetId(
  householdId: string,
  merchantPattern: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([householdId, merchantPattern]), 'utf8')
    .digest('hex');
}

/**
 * 병합 후보 **묶음**의 안정적인 target id.
 *
 * `createMerchantCategoryTargetId`와 같은 이유로 해시다 — 가맹점 원문을 feedback
 * 계보에 남기지 않는다. feedback_events는 append-only이고 데이터셋 스냅샷으로
 * 흘러가므로, 거기에 이름을 넣으면 개인 소비 이력이 학습 자산에 영구히 박힌다.
 *
 * **이름 집합을 정렬해서** 해시하는 이유: 같은 묶음이 목록 정렬 순서나 대표 선택에
 * 따라 다른 순서로 들어와도 같은 id여야 한다. 그렇지 않으면 사용자가 거절한 후보가
 * 다음 렌더에서 다른 id로 다시 올라온다 — S3의 DoD가 정확히 그것을 금지한다.
 *
 * 대표(canonical)를 id에 넣지 않는 것도 같은 이유다. "이 이름들은 같은 가게가
 * 아니다"라는 거절은 **어느 것을 대표로 삼든** 유효한 판단이다.
 */
export function createMerchantIdentityTargetId(
  householdId: string,
  names: readonly string[],
): string {
  const sorted = [...new Set(names)].sort();
  return createHash('sha256')
    .update(JSON.stringify([householdId, sorted]), 'utf8')
    .digest('hex');
}
