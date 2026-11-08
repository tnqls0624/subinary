/**
 * 가져온 항목을 기존 납부 일정과 맞춘다. 브랜드와 무관하다(HousingBrandFetchedItem 만 본다).
 * sujain-parse.ts 에서 글자 그대로 옮겼다 — 맞추기 규칙이 바뀌면 확정 일정 옆에 중복 줄이 생긴다.
 */
import type { HousingBrandFetchedItem, ManualHousingPaymentKind } from '@family/contracts';

/**
 * 기존 일정과 맞춰 확인 목록을 만든다.
 * - 값이 같고 unread도 없으면 목록에서 뺀다 (달라진 값만).
 * - 이름은 맞았지만 금액 등을 못 읽은 행은 unread와 함께 남겨 미확인으로 보이게 한다.
 */
export function matchFetchedItems(
  fetched: HousingBrandFetchedItem[],
  existing: Array<{
    id: string;
    kind: ManualHousingPaymentKind;
    installment: number | null;
    label: string | null;
    amount: string | null;
    dueDate: string | null;
    paidAmount: string | null;
    paidDate: string | null;
  }>,
): HousingBrandFetchedItem[] {
  type ExistingPayment = (typeof existing)[number];
  const used = new Set<string>();
  const take = (
    item: HousingBrandFetchedItem,
    test: (payment: ExistingPayment) => boolean,
  ): ExistingPayment | undefined => {
    const found = existing.find((payment) => !used.has(payment.id) && payment.kind === item.kind && test(payment));
    if (found) used.add(found.id);
    return found;
  };
  // 1) 정확히 같은 일정부터 모두 맞춘다: 옵션은 같은 이름(둘 다 이름이 없으면 같은 금액),
  //    그 밖은 같은 회차(계약금1차·2차, 중도금 N차, 회차 없는 잔금끼리).
  const matches = fetched.map((item) => {
    if (item.kind === 'option') {
      return take(item, (payment) => (
        item.label && payment.label
          ? payment.label === item.label
          : payment.label == null && item.label == null && payment.amount === item.scheduledAmount
      ));
    }
    return take(item, (payment) => payment.installment === item.installment);
  });
  // 2) 계약금·잔금만, 남은 줄을 한쪽 회차가 없는(직접 입력한) 첫 미사용 일정에 맞춘다.
  //    정확한 맞춤을 먼저 다 끝내야 한다 — 한 번에 훑으면 앞쪽의 회차 없는 일정이 먼저 잡혀,
  //    뒤의 같은 회차 일정이 갱신되지 않고 같은 회차가 두 줄 생긴다. 중도금은 회차가 곧 이름이라 대체하지 않는다.
  fetched.forEach((item, index) => {
    if (matches[index] || item.kind === 'interim' || item.kind === 'option') return;
    matches[index] = take(item, (payment) => item.installment === null || payment.installment === null);
  });
  return fetched.map((item, index) => {
    const match = matches[index];
    if (!match) {
      const changedFields: HousingBrandFetchedItem['changedFields'] = [];
      if (item.scheduledAmount !== null) changedFields.push('scheduledAmount');
      if (item.dueDate !== null) changedFields.push('dueDate');
      if (item.paidAmount !== null) changedFields.push('paidAmount');
      if (item.paidDate !== null) changedFields.push('paidDate');
      if (item.actualPaidDate !== null) changedFields.push('actualPaidDate');
      if (item.label !== null) changedFields.push('label');
      if (item.installment !== null) changedFields.push('installment');
      return { ...item, matchedPaymentId: null, changedFields };
    }
    used.add(match.id);
    const changedFields: HousingBrandFetchedItem['changedFields'] = [];
    if (item.scheduledAmount !== null && item.scheduledAmount !== match.amount) changedFields.push('scheduledAmount');
    if (item.dueDate !== null && item.dueDate !== match.dueDate) changedFields.push('dueDate');
    if (item.paidAmount !== null && item.paidAmount !== match.paidAmount) changedFields.push('paidAmount');
    if (item.paidDate !== null && item.paidDate !== match.paidDate) changedFields.push('paidDate');
    if (item.actualPaidDate !== null && item.actualPaidDate !== match.paidDate) changedFields.push('actualPaidDate');
    if (item.label !== null && item.label !== match.label) changedFields.push('label');
    if (item.installment !== null && item.installment !== match.installment) changedFields.push('installment');
    return { ...item, matchedPaymentId: match.id, changedFields };
  }).filter((item) => (
    item.matchedPaymentId === null
    || item.changedFields.length > 0
    || item.unreadFields.length > 0
  ));
}
