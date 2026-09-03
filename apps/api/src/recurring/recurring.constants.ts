/**
 * 정기 지출 Radar의 판별 상수와 활성화 게이트 (C-5).
 *
 * **전부 한 곳에 모아 두는 이유**: 이 값들은 운영 표본 없이 정한 보수적 추정이다
 * (PO 판정 Q1 `[가설]`: "허용 변동폭은 운영 표본 없이 확정하지 않는다"). 코드 곳곳에
 * 흩어 두면 나중에 실제 데이터로 조정할 때 무엇을 얼마나 움직였는지 말할 수 없다.
 * 값을 바꾸면 {@link RECURRING_ALGORITHM_VERSION}을 함께 올려 과거 결과와 구분한다.
 */

/**
 * 판별 알고리즘 버전. 규칙·상수를 바꾸면 반드시 올린다.
 *
 * 저장된 series의 `algorithm_version`과 비교해 "이 후보가 어떤 규칙으로 만들어졌는지"를
 * 사후에 말할 수 있어야 한다. 버전 없이 규칙만 바꾸면 정밀도 변화의 원인을 추적할 수 없다.
 */
export const RECURRING_ALGORITHM_VERSION = 1;

/** 판별 창(개월). 로드맵 C-5의 "최근 3~6개월". */
export const RECURRING_LOOKBACK_MONTHS = 6;

/**
 * 같은 series로 묶을 금액 허용 변동폭(basis points, 500 = 5%).
 *
 * 왜 범위인가: 금액 변동형 구독(사용량 과금·환율 연동)을 "동일 금액"으로 묶으면
 * 영원히 후보가 되지 못한다. 왜 5%인가: 운영 표본이 없어 **좁게** 잡았다. 넓히면
 * 서로 다른 요금제가 한 series로 합쳐져 사용자가 확정한 신원이 오염된다 —
 * 좁아서 놓치는 것은 다음 재계산에서 회복되지만, 잘못 합친 것은 사용자 판단을 오염시킨다.
 */
export const RECURRING_AMOUNT_TOLERANCE_BPS = 500;

/**
 * 금액 밴드의 절대 하한(minor units). 소액 결제에서 5%가 몇 십 원이 되어 반올림
 * 차이만으로 밴드가 갈리는 것을 막는다.
 */
export const RECURRING_AMOUNT_TOLERANCE_FLOOR = 100;

/** 월 주기로 인정할 간격(일). 28~31일 결제일 + 주말 이월을 담되 두 달을 넘지 않는다. */
export const RECURRING_MONTHLY_MIN_DAYS = 25;
export const RECURRING_MONTHLY_MAX_DAYS = 35;

/** 주 주기로 인정할 간격(일). */
export const RECURRING_WEEKLY_MIN_DAYS = 6;
export const RECURRING_WEEKLY_MAX_DAYS = 8;

/**
 * 월 주기 최소 관측 수와 **서로 다른 달** 수.
 *
 * 서로 다른 달을 요구한 원래 이유는 P0-10(파서 앵커링) 미해결이었다 — 그 오탐은
 * 대부분 같은 문자·같은 날짜 근처에 몰려서, 한 달 안의 3회를 정기로 보면 오탐이
 * 그대로 "정기 결제"로 승격됐다.
 *
 * **P0-10은 2026-09-03에 해결됐다**(ADR-0027 6단계 파서 게이트, 운영 문자 264건 전수
 * 재생 검증). 그래도 두 상수를 낮추지 않는다. 근거가 바뀌었을 뿐 결론은 같다:
 *
 * **2회로는 주기를 검증할 수 없다.** 관측 2개는 간격이 하나뿐이고, 간격 하나로는
 * "31일마다 반복"과 "우연히 31일 뒤에 또 샀다"를 가를 방법이 없다. 3회여야 간격이
 * 둘이 되고, 그 둘이 비슷한지를 물을 수 있다.
 *
 * 실측이 이 값의 대가를 보여준다(2026-09-04 recompute): `ANTHROPIC*CLAUDESUB`가
 * 07-20 · 08-20으로 **간격 31일의 정확한 월 구독**인데 2회라서 탈락했다. 9/20에 세
 * 번째가 들어오면 후보가 된다. 놓치는 쪽을 택한 것이다 — 잘못 잡은 정기는 사용자가
 * 확정해 버리면 되돌리기 번거롭고, 놓친 것은 다음 결제에 회복된다.
 *
 * 값을 바꾸면 {@link RECURRING_ALGORITHM_VERSION}을 함께 올린다.
 */
export const RECURRING_MONTHLY_MIN_OCCURRENCES = 3;
export const RECURRING_MONTHLY_MIN_DISTINCT_MONTHS = 3;

/**
 * 주 주기 최소 관측 수와 최소 관측 기간(일).
 *
 * 주 주기는 한 달 안에 4회가 정상이라 "서로 다른 달"을 요구할 수 없다. 대신 관측
 * 기간으로 같은 역할을 시킨다 — 3주 이상 이어져야 우연한 연속 구매와 갈린다.
 */
export const RECURRING_WEEKLY_MIN_OCCURRENCES = 4;
export const RECURRING_WEEKLY_MIN_SPAN_DAYS = 21;

/**
 * 건너뛴 주기를 몇 번까지 봐 줄지.
 *
 * 1인 이유: 결제 실패(ADR-0024)나 한 달 정지로 한 번 거르는 것은 실제로 흔하다.
 * 그걸 배제하면 정작 사용자가 알고 싶어 하는 "끊길 뻔한 구독"이 후보에서 사라진다.
 * 2 이상은 분기 결제·비정기 반복 구매까지 빨아들여 정밀도가 무너진다.
 */
export const RECURRING_MAX_SKIPPED_CYCLES = 1;

/**
 * 1주기 간격이어야 하는 최소 비율(basis points, 6000 = 60%).
 *
 * 건너뜀을 허용하되 **대부분은 제 주기로 돌아와야** 정기 결제다. 이 하한이 없으면
 * 두 배 간격만 반복되는 격월 결제가 월 주기 series로 잡힌다.
 */
export const RECURRING_MIN_ON_CYCLE_RATIO_BPS = 6000;

/* -------------------------------------------------------------------------- */
/* 활성화 게이트                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 사용자 노출 flag. **기본 off.**
 *
 * ⛔ DB 마이그레이션(`0053`)이 끝났다는 이유로 켜지 마십시오. 금액 계약(ADR-0027)이
 * 아직 enforce 전이라 `net_amount`가 확정이 아니고, 그 위에서 계산한 결과를 사용자에게
 * 사실처럼 보여주면 틀린 예고가 된다. **스키마 배포와 노출은 분리한다**(PO 판정 Q5-3).
 *
 * `packages/config`의 `configSchema`가 아니라 env를 직접 읽는 이유: 이 flag는 곧
 * 제거될 임시 게이트이고, 공용 config 스키마는 이번 웨이브에서 다른 작업과 동시
 * 편집되는 공유 지점이다. 켜는 방법: `RECURRING_RADAR_ENABLED=true`.
 */
export function isRecurringRadarEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.RECURRING_RADAR_ENABLED?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/**
 * ⛔ **아직 만들지 않은 표면.**
 *
 * ## 열린 것 (선행 조건이 실제로 충족됐다)
 *
 * - ~~다음 결제 예상일~~ — 2026-08-18. `last_seen_at`·`interval_days`의 순수 함수라
 *   금액 계약과 무관했다.
 * - ~~월 정기 지출 총액~~ — 2026-09-03. ADR-0027이 8단계까지 끝나(전량 v2 + 제약
 *   VALIDATE) `net_amount`가 확정됐다. `GET /v1/recurring/upcoming`이 담당하고,
 *   근거에 v1이 섞인 series는 항목마다 `amountForecastable: false`로 합계에서 빠진다.
 *
 * - ~~알림 발송~~ — 2026-09-03(S3). **확정 series만** 대상이라 미확정 후보의 오탐이
 *   전달되지 않는다. 하루 전 1회, 사용자별로 묶어 보낸다(기획 D5). 새 kind
 *   `upcoming`을 쓴다 — `reminder`에 묶으면 확인 리마인더를 끌 때 예고도 꺼진다.
 *
 * - ~~해지 종료 처리~~ — 2026-09-03(S4). D4를 지켰다: **감지는 상태를 바꾸지 않는다.**
 *   유예 경과는 화면이 "해지하셨나요?"를 묻는 근거일 뿐이고, `ended`로 옮기는 것은
 *   사용자가 답할 때다. "계속 써요"는 상태를 그대로 두고 `stopped_dismissed_at`만
 *   기록해 한 주기 동안 다시 묻지 않는다.
 *
 * ## 남은 것과 이유
 *
 * - **카드 교체 CTA** — 기획 §6이 폐기했다. 앱 밖 행동이고 링크조차 카드사별로 달라
 *   유지가 안 된다.
 *
 * 여기에 기능을 추가하려면 해당 슬라이스의 DoD를 먼저 통과시켜라
 * (`docs/concept-upcoming-spend-2026-08.md` §4).
 */
export const RECURRING_DEFERRED_SURFACES = ['cancellation_cta'] as const;
