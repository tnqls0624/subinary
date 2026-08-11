/**
 * 취소 연결 후보 **표시용** 좁히기 — 가맹점·금액·날짜 부분 일치.
 *
 * ## 자격 규칙이 아니다
 *
 * 어떤 승인이 후보가 될 수 있는지는 **서버만** 판단한다
 * (`GET /v1/transactions/:id/cancellation-candidates`). 규칙이 두 벌이 되면 "목록에
 * 보이는데 저장하면 거부되는" 후보가 생기고, 그게 지금보다 나쁘다. 여기 있는 것은
 * 이미 자격을 통과한 목록에서 **사용자가 원하는 항목을 찾게 해 주는 검색**이다.
 *
 * ## 왜 서버 `q`가 아니라 클라이언트인가
 *
 * 후보 응답에 LIMIT이 없어 전량이 이미 손에 있다 — 왕복 없이 즉시 좁혀진다. 그리고
 * 서버 목록 검색(`searchScope`)은 가맹점·메모만 보므로 **금액으로 찾을 수 없다**.
 * 취소 연결에서 사용자가 가장 확실하게 기억하는 단서가 금액이라 그쪽을 포기할 수 없다.
 *
 * 후보가 수천 건 규모가 되면 서버 페이지네이션 + 서버 검색으로 옮긴다.
 */

/** 검색 대상이 되는 후보의 최소 형태. */
export interface CandidateSearchFields {
  /** 화면에 보이는 가맹점 라벨(마스킹된 행은 "(비공개)"). */
  merchant: string;
  /** 승인 원금(minor units). */
  amount: number;
  /** 남은 잔액(minor units). */
  remaining: number;
  /** 화면에 보이는 날짜 문자열(예: "2026. 8. 3."). */
  dateLabel: string;
}

/** 금액 검색용: 자릿수만 남긴다("12,000원" · "12000" · "₩12,000" → "12000"). */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * 검색어가 후보와 맞는지. 빈 검색어는 **전부 통과**(필터를 걸지 않음).
 *
 * 텍스트는 가맹점·날짜 라벨에 대해 대소문자 무시 부분 일치. 숫자를 포함한 검색어는
 * 금액(원금·잔액)의 자릿수 부분 일치도 함께 본다 — 사용자가 "12,000"이라고 쳐도
 * 쉼표 없이 저장된 값과 맞아야 한다.
 *
 * 텍스트 조건과 금액 조건은 **OR**다: "스타벅스"는 가맹점으로, "4500"은 금액으로
 * 각각 찾히길 기대하는 게 자연스럽다.
 */
export function matchesCandidateSearch(
  candidate: CandidateSearchFields,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim();
  if (query === '') return true;

  const lowered = query.toLowerCase();
  if (candidate.merchant.toLowerCase().includes(lowered)) return true;
  if (candidate.dateLabel.toLowerCase().includes(lowered)) return true;

  const queryDigits = digitsOnly(query);
  if (queryDigits !== '') {
    if (String(candidate.amount).includes(queryDigits)) return true;
    if (String(candidate.remaining).includes(queryDigits)) return true;
  }

  return false;
}

/**
 * 선택값이 좁혀진 목록 안에 남아 있는지 확인한다.
 *
 * 왜 필요한가: 사용자가 후보를 고른 **뒤** 검색어를 바꿔 그 후보가 목록에서 사라지면,
 * 선택값은 그대로 남아 화면에 보이지 않는 승인에 연결 버튼이 활성화된다. 실제로
 * 엉뚱한 결제에 취소가 붙는 경로다.
 */
export function retainSelection(
  selected: string,
  visibleIds: readonly string[],
): string {
  return visibleIds.includes(selected) ? selected : '';
}
