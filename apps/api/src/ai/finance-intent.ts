/**
 * 가계부 질의 의도 해석 — 결정적·순수 로직(로드맵 C-6 / PO B8).
 *
 * ## 왜 별도 모듈인가
 * 여기가 "답할 수 있는 질문"과 "답할 수 없는 질문"의 경계다. 이 경계가 틀리면
 * 사용자는 **자기 질문의 답이 아닌 숫자**를 자기 질문의 답이라고 믿는다. 서비스
 * 클래스(DB·LLM 의존)에서 떼어 내 순수 함수로 두어 경계 자체를 테스트한다.
 *
 * ## 이 변경의 핵심: 기본값 `total` 제거
 * 예전 휴리스틱은 아무 신호도 못 찾으면 조용히 `aggregate='total'`로 떨어졌다.
 * 그래서 "지난달이랑 비교해줘"처럼 지원하지 않는 질문에도 **월 총지출**이 답으로
 * 나갔다(로드맵 C-6 §문제 정의). 이제 `total`은 총지출을 묻는 말을 **실제로
 * 알아봤을 때만** 나오고, 못 알아보면 `'unsupported'` → 정직한 거부다.
 *
 * ## 회귀 방어
 * 반대 방향 사고("잘 되던 질문이 거부됨")가 더 조용하고 더 나쁘다. 그래서
 * {@link TOTAL_SIGNAL}에 금액을 묻는 말투를 넉넉히 넣고, 그 목록을 테스트가
 * 지킨다. 판정 순서(카테고리 → 가맹점 → 총지출)는 기존 동작 그대로다.
 *
 * ## 거부는 LLM/휴리스틱 어느 경로에서든 나온다
 * "분류 경로가 `fallback`이면 거부"가 아니다 — LLM이 한 번 흔들렸다는 이유로
 * 답할 수 있는 질문까지 거부하면 프로젝트 절대 규약 #1(LLM 실패가 파이프라인을
 * 중단시키지 않는다)을 어긴다. 거부의 기준은 **경로가 아니라 결과**다: 두 경로
 * 모두 `'unsupported'`를 낼 수 있고, 그때만 거부한다.
 */
import type { FinanceAggregateKind } from '@family/contracts';
import { DEFAULT_CATEGORIES } from '@family/shared';

/* -------------------------------------------------------------------------- */
/* 시간 헬퍼(Asia/Seoul 고정 UTC+9 — analytics와 동일 규약)                     */
/* -------------------------------------------------------------------------- */

/** Fixed Asia/Seoul (KST) offset in milliseconds — UTC+9, no DST. */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `YYYY-MM` (01–12). */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** (year, monthNumber 1~12 범위 밖 롤오버 허용) → 'YYYY-MM'. */
export function toMonthString(year: number, monthNumber: number): string {
  // Date.UTC의 월 인덱스 정규화로 0/13 등의 롤오버를 흡수한다.
  const rolled = new Date(Date.UTC(year, monthNumber - 1, 1));
  const y = rolled.getUTCFullYear();
  const m = rolled.getUTCMonth() + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/** 현재 Asia/Seoul 월 'YYYY-MM'(고정 UTC+9 — analytics와 동일 규약). */
export function currentSeoulMonth(): string {
  const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
  return toMonthString(seoulNow.getUTCFullYear(), seoulNow.getUTCMonth() + 1);
}

/** 'YYYY-MM' → 전월 'YYYY-MM'. */
export function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return toMonthString(year, monthNumber - 1);
}

/** 'YYYY-MM'의 [월초, 익월초) UTC 경계(Asia/Seoul 벽시계, 고정 UTC+9). */
export function seoulMonthRange(month: string): { from: Date; to: Date } {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return {
    from: new Date(Date.UTC(year, monthNumber - 1, 1) - KST_OFFSET_MS),
    to: new Date(Date.UTC(year, monthNumber, 1) - KST_OFFSET_MS),
  };
}

/* -------------------------------------------------------------------------- */
/* 의도 타입                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 해석된 집계 축. `'unsupported'`는 계약(`FinanceAggregateKind`)에 없는
 * **내부 전용** 값이다 — 응답의 `data.aggregate`로는 절대 나가지 않는다
 * (거부 응답은 `data` 자체를 싣지 않는다).
 */
export type ResolvedAggregate = FinanceAggregateKind | 'unsupported';

/** 해석된 질의 의도(월/카테고리/집계 형태). */
export interface FinanceIntent {
  month: string;
  categorySlug: string | null;
  aggregate: ResolvedAggregate;
}

/**
 * 거부 분기를 지나 살아남은 의도 — 집계 축이 계약상의 셋 중 하나로 확정됐다.
 * 집계 함수가 이 타입만 받으므로, `'unsupported'`가 SQL 집계까지 흘러가는 경로가
 * 타입 수준에서 막힌다.
 */
export interface SupportedFinanceIntent extends FinanceIntent {
  aggregate: FinanceAggregateKind;
}

/**
 * 거부 사유의 갈래 — **질문 원문 대신** 이것을 관측 지표로 남긴다.
 * 원문을 저장하지 않고도 "다음에 무엇을 지원해야 하는가"를 셀 수 있게 하는 축이다.
 */
export type UnsupportedKind = 'comparison' | 'count' | 'forecast' | 'other';

/* -------------------------------------------------------------------------- */
/* 신호 패턴                                                                    */
/* -------------------------------------------------------------------------- */

/** 카테고리 축 질문 신호(카테고리 이름이 직접 안 나오는 경우). */
const CATEGORY_SIGNAL = /카테고리|항목별|분류별/;

/** 가맹점 축 질문 신호. */
const MERCHANT_SIGNAL = /가맹점|매장|상호|어디서|어디에/;

/**
 * 총지출 질문 신호 — **금액을 묻는 말투만** 넣는다.
 *
 * 이 목록이 곧 "총지출로 답해도 되는 질문"의 정의다. 넓히면 미지원 질문에 총지출이
 * 새어 나가고, 좁히면 잘 되던 질문이 거부된다. 그래서 `결제`처럼 지출 이외 맥락
 * ("결제 실패 왜 났어?")에서도 흔한 낱말은 제외하고 `결제액`만 넣는다.
 */
const TOTAL_SIGNAL =
  /얼마|얼만|총액|총지출|지출|사용액|결제액|소비액|합계|썼|쓴|나갔/;

/** 거부 사유 갈래 판정용 패턴(관측 전용 — 답변 경로에 영향 없음). */
const COMPARISON_SIGNAL = /비교|대비|보다|늘었|줄었|증가|감소|차이|저번보다/;
const COUNT_SIGNAL = /몇번|몇건|몇회|횟수|건수|몇개/;
const FORECAST_SIGNAL = /예상|예측|남을|남았|남은|앞으로|될까|얼마나더/;

/* -------------------------------------------------------------------------- */
/* 거부 문구                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 거부 답변. **실패가 아니라 정직**이다 — 사과·오류 톤을 쓰지 않고, 무엇을 할 수
 * 있는지 곧바로 알려 준다(기존 해요체 유지).
 */
export const REFUSAL_ANSWER =
  '이 질문은 아직 답하기 어려워요. 지금은 기간·카테고리·가맹점 기준의 지출 집계만 알려드릴 수 있어요.';

/** 거부와 함께 내려보내는 "대신 이렇게 물어보세요" 예시(화면에서 탭 가능). */
export const REFUSAL_SUGGESTIONS: readonly string[] = [
  '이번 달 총 지출 얼마야?',
  '이번 달 식비 얼마 썼어?',
  '이번 달 어디서 제일 많이 썼어?',
];

/* -------------------------------------------------------------------------- */
/* 판정                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 결정적 휴리스틱 의도 추출(LLM 폴백 경로).
 *  - 월: '지난달/저번달' → 전월, '이번달/이달' → 당월, 'YYYY-MM'/'YYYY년 M월'
 *    /'N월'(당해 연도) 순으로 해석, 없으면 당월.
 *  - 카테고리: DEFAULT_CATEGORIES name/slug 부분일치(첫 일치 승).
 *  - 집계: 카테고리 일치/카테고리 신호 → byCategory, 가맹점 신호 → byMerchant,
 *    총지출 신호 → total, **아무 축도 못 찾으면 unsupported**(예전에는 여기서
 *    조용히 total이었다).
 */
export function extractIntentHeuristically(question: string): FinanceIntent {
  const compact = question.replace(/\s+/g, '');

  // 월 해석.
  let month: string | null = null;
  const explicit = /(\d{4})-(0[1-9]|1[0-2])/.exec(compact);
  const koreanYm = /(\d{4})년(\d{1,2})월/.exec(compact);
  const monthOnly = /(?:^|[^\d-])(\d{1,2})월/.exec(compact);
  if (/지난달|저번달|전달/.test(compact)) {
    month = previousMonth(currentSeoulMonth());
  } else if (/이번달|이달|금월/.test(compact)) {
    month = currentSeoulMonth();
  } else if (explicit) {
    month = `${explicit[1]}-${explicit[2]}`;
  } else if (koreanYm) {
    month = toMonthString(Number(koreanYm[1]), Number(koreanYm[2]));
  } else if (monthOnly) {
    const current = currentSeoulMonth();
    month = toMonthString(Number(current.slice(0, 4)), Number(monthOnly[1]));
  }

  // 카테고리 부분일치(DEFAULT_CATEGORIES name/slug).
  let categorySlug: string | null = null;
  const lower = question.toLowerCase();
  for (const category of DEFAULT_CATEGORIES) {
    if (question.includes(category.name) || lower.includes(category.slug)) {
      categorySlug = category.slug;
      break;
    }
  }

  // 집계 축. 판정 순서는 기존 동작 그대로(카테고리 → 가맹점) + 총지출 명시 판정.
  let aggregate: ResolvedAggregate;
  if (categorySlug !== null || CATEGORY_SIGNAL.test(compact)) {
    aggregate = 'byCategory';
  } else if (MERCHANT_SIGNAL.test(compact)) {
    aggregate = 'byMerchant';
  } else if (TOTAL_SIGNAL.test(compact)) {
    aggregate = 'total';
  } else {
    // 월만 알아본 것은 분류가 아니다("지난달이랑 비교해줘"에는 월이 있다).
    // 무엇을 집계할지 모르면 총지출로 때우지 않고 거부한다.
    aggregate = 'unsupported';
  }

  return { month: month ?? currentSeoulMonth(), categorySlug, aggregate };
}

/**
 * 거부된 질문이 어떤 기능을 요구했는지 갈래로 분류한다(관측 전용).
 *
 * 질문 원문은 로그·DB 어디에도 남기지 않는다(서비스 로그 정책). 대신 이 갈래
 * 카운트를 보고 "다음에 무엇을 지원할지"를 정한다.
 */
export function classifyUnsupportedKind(question: string): UnsupportedKind {
  const compact = question.replace(/\s+/g, '');
  if (COMPARISON_SIGNAL.test(compact)) return 'comparison';
  if (COUNT_SIGNAL.test(compact)) return 'count';
  if (FORECAST_SIGNAL.test(compact)) return 'forecast';
  return 'other';
}
