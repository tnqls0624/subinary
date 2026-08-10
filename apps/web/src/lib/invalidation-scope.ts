/* ---------------------------------------------------------------------------
 * 거래 변화가 갈아엎어야 하는 쿼리 접두 목록 (P2)
 *
 * `queries.ts`에서 떼어낸 이유는 **테스트하기 위해서**다. 저 파일은 "use client" +
 * react-query + API 클라이언트(네이티브 플러그인까지)를 끌고 와서 단위 테스트에
 * 올리기 무겁다. 목록만 순수 모듈로 두면 "무효화에서 빠진 화면" 회귀를 값싸게 막을 수
 * 있다 — 이 저장소가 반복해서 앓은 병이고, 증상은 **새로고침해야 보인다**였다.
 *
 * 여기 있는 문자열은 `queries.ts`의 `queryKeys` 팩토리가 만드는 키의 **첫 요소**와
 * 같아야 한다. react-query의 `invalidateQueries({ queryKey })`는 접두 일치다.
 * ------------------------------------------------------------------------- */

/** 실시간 힌트·거래 뮤테이션 이후 무효화할 쿼리 접두 키. */
export const TRANSACTION_SCOPE_KEYS: ReadonlyArray<ReadonlyArray<string>> = [
  ["transactions"],
  ["analytics"],
  ["budgets"],
  ["monthly-insights"],
  ["card-sms-events"],
  ["merchant-label-candidates"],
  // 카테고리 이름 변경/삭제(가족 원격 편집)가 목록·아이콘에 반영되도록 포함.
  ["categories"],
  // ↓ 아래 3종은 실시간 힌트가 와도 새로고침해야 보이던 것들이다(P2).
  // 결제 실패: 거절 문자는 거래로 승격되지 않아 ["transactions"]에 걸리지 않는다.
  ["card-sms-declines"],
  // 가맹점: 새 거래가 새 가맹점을 만들거나 지출 순위를 바꾼다.
  ["merchants"],
  // 카드: 처음 보는 카드번호로 문자가 오면 서버가 카드 행을 만든다.
  ["cards"],
];
