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
