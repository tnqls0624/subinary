/**
 * 템플릿 스켈레톤과 지문 (ADR-0023 §4).
 *
 * 같은 카드사의 같은 레이아웃이면 금액·시각·가맹점이 달라도 **같은 지문**이 나와야
 * 한다. 지문이 갈리면 캐시가 안 맞아 LLM을 계속 호출하게 된다.
 *
 * **숫자만 접으면 안 된다** — 프로덕션 52건 실측:
 *
 * | 스켈레톤 | 고유 템플릿 | 2건 이상 템플릿 커버율 |
 * | --- | --- | --- |
 * | 숫자런만 `#` | 37종 | 46% |
 * | 숫자런 `#` + 자유 토큰 `@` | 22종 | 73% |
 *
 * 숫자만 치환하면 가맹점명이 스켈레톤에 그대로 남아 **가맹점이 바뀔 때마다 새 지문**이
 * 된다. 그래서 고정 어휘({@link TEMPLATE_KEYWORDS}) 밖의 토큰은 전부 슬롯(`@`)으로
 * 접는다. 남는 파편화는 대부분 가맹점명 속 괄호·숫자(`(주)브로트아트`) 때문이다.
 *
 * 이 함수는 라벨링·캐시 조회·레시피 서빙이 **모두 같은 것을 호출**해야 한다. 사본을
 * 만들면 키 공간이 갈라져 캐시가 영구 미스가 된다.
 */
import { createHash } from 'node:crypto';

/**
 * 카드 문자에서 레이아웃을 특징짓는 **고정부** 어휘. 이 목록 밖의 토큰(가맹점명,
 * 사람 이름 등)은 가변 슬롯으로 간주해 접는다.
 *
 * 발급사명이 여기 없어도 무방하다 — 지문에 `sender`가 포함되므로 발급사는 그쪽에서
 * 구분된다. 새 발급사 문구를 추가하면 기존 지문이 바뀌므로(캐시 무효화) 레시피
 * 재유도가 필요하다는 점만 유의한다.
 */
export const TEMPLATE_KEYWORDS: ReadonlySet<string> = new Set([
  'Web발신',
  '승인',
  '승인거절',
  '거절',
  '취소',
  '환불',
  '결제',
  '일시불',
  '개월',
  '누적',
  '누계',
  '잔액',
  '원',
  '카드',
  '체크카드',
  '신용카드',
  '국내',
  '해외',
  '해외승인',
  '분실카드',
  '뒷자리',
  '님의',
  '통장',
  '토스뱅크',
  '삼성',
  '현대',
  '네이버',
  '신한',
  'KB',
  '국민',
  '롯데',
  '하나',
  '우리',
  'BC',
  'NH',
  '농협',
  '씨티',
]);

/** 숫자런(금액·시각·날짜·카드뒷자리 전부) → `#`. */
const NUMBER_RUN_RE = /[0-9][0-9,.:/ ]*[0-9]|[0-9]/g;
/** 토큰 경계. 숫자는 이미 `#`이 되어 여기 걸리지 않는다. */
const TOKEN_RE = /[0-9A-Za-z가-힣]+/g;
/** 연속 슬롯(가맹점 여러 어절) 병합. */
const SLOT_RUN_RE = /(@\s*)+/g;
/** 개행을 제외한 수평 공백 정규화. */
const HORIZONTAL_WS_RE = /[^\S\n]+/g;

/**
 * 문자를 레이아웃만 남긴 스켈레톤으로 접는다. 금액·시각은 `#`, 가맹점·이름 등
 * 자유 토큰은 `@`가 된다.
 */
export function templateSkeleton(content: string): string {
  const normalized = content.normalize('NFKC').replace(NUMBER_RUN_RE, '#');
  const slotted = normalized.replace(TOKEN_RE, (token) =>
    TEMPLATE_KEYWORDS.has(token) ? token : '@',
  );
  return slotted.replace(SLOT_RUN_RE, '@ ').replace(HORIZONTAL_WS_RE, ' ').trim();
}

/**
 * 발신번호 + 스켈레톤의 안정적 해시. 같은 발신처의 같은 레이아웃이면 항상 같다.
 *
 * `sender`를 포함하는 이유: 스켈레톤만으로는 서로 다른 발급사의 동일 레이아웃이
 * 충돌할 수 있다.
 */
export function templateFingerprint(sender: string, content: string): string {
  // NUL 구분자: sender·스켈레톤 어디에도 나타날 수 없어 경계가 모호해지지 않는다.
  return createHash('sha256')
    .update(`${sender}\u0000${templateSkeleton(content)}`, 'utf8')
    .digest('hex');
}
