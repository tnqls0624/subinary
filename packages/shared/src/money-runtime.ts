/**
 * 금액 계약 전환 런타임 — 모드 스위치 · 쓰기 펜스 · 승격 일시정지의 **공용 어휘**
 * (ADR-0027 롤아웃 5단계 선행).
 *
 * ## 왜 이 파일이 있는가
 *
 * ADR 5단계는 이렇게 요구한다: *"API와 worker의 enforce 플래그를 모두 v2로 바꾼 뒤 다시
 * 연다. **한 경로라도 legacy인 동안 사용자 쓰기를 재개하지 않는다.**"* 그리고 명시적으로
 * *"쓰기 펜스를 사용할 수 없는 배포 환경이면 이 전환은 진행하지 않는다."*
 *
 * 두 앱이 각자 자기 이름의 플래그를 읽으면 **순차 전환이 구조적으로 가능해진다** — ADR이
 * 금지한 바로 그 상태다. 그래서 모드 이름·Redis 키·문구를 여기 한 곳에 두고 두 앱이 같은
 * 것을 읽는다. 이름이 갈리면 컴파일이 깨지도록.
 *
 * ## 여기 없는 것
 *
 * **금액 계산은 한 줄도 없다.** 환산·상계·재계산은 `@family/transaction-domain`이
 * 소유한다(ADR-0027 §1). 이 파일은 "지금 어느 모드인가 / 지금 쓰기를 막는가"만 안다.
 *
 * ## 의존성
 *
 * 순수 상수·문자열 함수뿐이다. Redis 클라이언트는 각 앱이 자기 것을 갖고 있고(둘 다
 * `ioredis` 의존), 이 패키지는 **키 이름만** 정해 준다. 저장소를 여기서 잡으면 shared가
 * 인프라를 끌고 오게 되고 스크립트에서도 못 쓴다.
 */

/* -------------------------------------------------------------------------- */
/* 모드                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 금액 계약 모드.
 *
 * - `legacy`: 기존 쓰기 그대로, shadow 관측도 하지 않는다.
 * - `shadow`: 기존 쓰기 그대로 + 새 계약의 예상 결과를 대조해 미적용 manifest로 남긴다.
 *   **현재 운영 동작이자 기본값이다.**
 * - `v2`: enforce. 새 계약이 금액 쓰기의 유일한 초크포인트가 된다.
 *
 * ✅ **enforce 배선 완료(2026-08-18).** 금액 쓰기 6개 경로가 모두 `MoneyWriteService`를
 * 통해 `TransactionMoneyService`를 부른다 — API 4곳(수동 입력·사람 검토·거래 수정·취소
 * 연결), worker 2곳(승인 승격·취소 승격). `v2`로 부팅하면 실제로 enforce된다.
 *
 * ⚠️ **여전히 두 앱을 함께 바꿔야 한다.** 한쪽만 `v2`면 같은 가구의 거래가 두 계약으로
 * 갈려 쓰이고, 그 상태는 사후에 어느 쪽이 맞는지 구분할 수 없다. ADR 롤아웃 5단계가
 * 쓰기 펜스를 요구하는 이유이며, 모드 불일치는 {@link verifyMoneyModeAgreement}가
 * 잡는다.
 */
export const MONEY_CONTRACT_MODES = ['legacy', 'shadow', 'v2'] as const;
export type MoneyContractMode = (typeof MONEY_CONTRACT_MODES)[number];

/** 현재 운영 동작. 스위치를 만들어도 기본값이 바뀌면 그건 전환이다. */
export const DEFAULT_MONEY_CONTRACT_MODE: MoneyContractMode = 'shadow';

/** 알 수 없는 값은 `null`. 호출부가 "조용히 기본값"과 "잘못된 설정"을 구분하게 한다. */
export function parseMoneyContractMode(
  value: string | undefined | null,
): MoneyContractMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (MONEY_CONTRACT_MODES as readonly string[]).includes(normalized)
    ? (normalized as MoneyContractMode)
    : null;
}

/**
 * 부팅 시 남길 경고(없으면 `null`).
 *
 * enforce 배선이 없던 동안 이 함수는 "`v2`를 켜도 실제로는 안 켜진다"를 알렸다. 배선이
 * 생긴 뒤로는 반대 방향이 위험해졌다 — **`v2`는 이제 진짜로 금액 쓰기를 바꾼다.**
 * 그래서 경고는 "켜졌다는 사실"과 그 전제(두 앱 동시 전환·쓰기 펜스)를 상기시킨다.
 */
export function moneyModeBootWarning(mode: MoneyContractMode): string | null {
  if (mode !== 'v2') return null;
  return (
    'MONEY_CONTRACT_MODE=v2 — 금액 쓰기가 새 계약(TransactionMoneyService)으로 enforce됩니다. ' +
    'API와 worker가 **모두** v2인지 확인하십시오. 한쪽만 v2인 동안 사용자 쓰기가 흐르면 ' +
    '두 계약의 거래가 섞이고 사후에 구분할 수 없습니다(ADR-0027 롤아웃 5단계).'
  );
}

/* -------------------------------------------------------------------------- */
/* 런타임 스위치 저장소 (Redis 키)                                             */
/* -------------------------------------------------------------------------- */

/**
 * 왜 Redis인가 (DB 행이 아니라).
 *
 * 1. **재시작 없이 토글돼야 한다.** 펜스가 환경변수면 켜려고 재시작해야 하고, 그 재시작
 *    구간이 정확히 무방비 구간이 된다(전환 순서 1번이 "재시작 없이 즉시"인 이유).
 * 2. **자동 만료가 공짜다.** `SET ... EX <ttl>`이 곧 "사람이 끄는 것을 잊어도 풀린다"이다.
 *    DB 행이면 만료를 도는 잡을 또 만들어야 하고, 그 잡이 죽으면 펜스가 영구히 남는다.
 * 3. **두 앱이 이미 Redis에 붙어 있다**(BullMQ). 새 의존성·새 마이그레이션이 없다.
 *
 * 대가: Redis가 죽으면 펜스 상태를 읽을 수 없다. 그때의 판정은 각 앱이 갖는다
 * (API 가드는 **fail-closed** — 근거는 가드 주석 참조).
 */

/** 키 접두 — BullMQ prefix를 재사용해 스택(dev/prod/verify)끼리 섞이지 않게 한다. */
export function moneyRuntimeKeyPrefix(queuePrefix: string): string {
  return `${queuePrefix}:money`;
}

/** 쓰기 펜스 플래그. 존재 = 켜짐. TTL이 곧 자동 해제 시각이다. */
export function moneyWriteFenceKey(queuePrefix: string): string {
  return `${moneyRuntimeKeyPrefix(queuePrefix)}:write-fence`;
}

/** 승격 소비 일시정지 플래그. 존재 = 정지. */
export function moneyPromotionPauseKey(queuePrefix: string): string {
  return `${moneyRuntimeKeyPrefix(queuePrefix)}:promotion-pause`;
}

/**
 * 각 서비스가 자기 모드를 **관측 가능하게** 올려 두는 키.
 *
 * 부팅 로그만으로는 불일치를 알 수 없다 — 두 로그 스트림을 사람이 눈으로 맞춰야 하고,
 * 전환 중에 그럴 여유가 없다. 두 값을 한 번에 읽어 비교할 수 있어야 한다.
 * TTL을 두는 이유: 죽은 서비스의 옛 모드가 영원히 남아 "일치"로 보이면 안 된다.
 */
export function moneyServiceModeKey(
  queuePrefix: string,
  service: MoneyRuntimeService,
): string {
  return `${moneyRuntimeKeyPrefix(queuePrefix)}:mode:${service}`;
}

/** 모드를 게시하는 서비스. */
export const MONEY_RUNTIME_SERVICES = ['api', 'worker'] as const;
export type MoneyRuntimeService = (typeof MONEY_RUNTIME_SERVICES)[number];

/** 모드 게시 하트비트 주기(ms). TTL은 이것의 3배 — 한 번 놓쳐도 사라지지 않는다. */
export const MONEY_MODE_HEARTBEAT_MS = 20_000;
/** 게시된 모드의 TTL(초). */
export const MONEY_MODE_TTL_SEC = 60;

/* -------------------------------------------------------------------------- */
/* 펜스 TTL                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 펜스 기본 TTL(초). 전환 리허설이 몇 분이면 끝나므로 15분이면 넉넉하고, 잊고 퇴근해도
 * 15분 뒤 저절로 풀린다. **켜고 못 끄는 것이 스스로 만든 장애다.**
 */
export const MONEY_FENCE_DEFAULT_TTL_SEC = 900;

/**
 * 펜스 최대 TTL(초). 1시간을 넘겨 거는 것은 "전환 중"이 아니라 "잊었다"이다.
 * 더 필요하면 다시 켜면 된다 — 다시 켜는 비용이 영구 펜스보다 훨씬 싸다.
 */
export const MONEY_FENCE_MAX_TTL_SEC = 3_600;

/* -------------------------------------------------------------------------- */
/* 사용자 응답                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 펜스가 켜졌을 때 사용자에게 보이는 문구.
 *
 * 영문 예외 메시지를 그대로 노출하지 않는다(P1-4에서 이미 고친 문제다). 사용자는
 * "내가 뭘 잘못했나"가 아니라 "잠시 후 다시 하면 된다"를 알아야 한다.
 */
export const MONEY_FENCE_MESSAGE_KO =
  '지금은 금액 기록을 잠시 멈춰 두었어요. 몇 분 뒤에 다시 시도해 주세요.';

/** 503과 함께 보내는 `Retry-After`(초). */
export const MONEY_FENCE_RETRY_AFTER_SEC = 60;

/* -------------------------------------------------------------------------- */
/* 불일치 판정                                                                 */
/* -------------------------------------------------------------------------- */

/** 두 서비스가 게시한 모드의 스냅샷. 값이 없으면(=미게시/만료) `null`. */
export interface MoneyModeSnapshot {
  api: MoneyContractMode | null;
  worker: MoneyContractMode | null;
}

/** 불일치 판정 결과. */
export interface MoneyModeVerdict {
  /** 두 서비스가 **같은 모드로 확인**됐는가. 한쪽이라도 모르면 false. */
  agreed: boolean;
  /** 확인된 공통 모드(합의했을 때만). */
  mode: MoneyContractMode | null;
  /** 사람이 읽는 판정 사유(한국어). */
  reason: string;
}

/**
 * 두 서비스의 모드가 일치하는지 판정한다.
 *
 * **"모르는 것"을 "일치"로 접지 않는다.** 한쪽이 응답하지 않으면 그 서비스가 어떤 계약으로
 * 쓰고 있는지 모르는 것이고, ADR이 금지한 상태(한 경로가 legacy인 채 쓰기 재개)를
 * 배제할 수 없다. 그러니 `agreed: false`다.
 */
export function verifyMoneyModeAgreement(
  snapshot: MoneyModeSnapshot,
): MoneyModeVerdict {
  const { api, worker } = snapshot;
  if (api === null && worker === null) {
    return {
      agreed: false,
      mode: null,
      reason: 'API·worker 둘 다 모드를 게시하지 않았어요 (미기동이거나 Redis 연결 실패)',
    };
  }
  if (api === null) {
    return { agreed: false, mode: null, reason: 'API가 모드를 게시하지 않았어요' };
  }
  if (worker === null) {
    return { agreed: false, mode: null, reason: 'worker가 모드를 게시하지 않았어요' };
  }
  if (api !== worker) {
    return {
      agreed: false,
      mode: null,
      reason: `모드가 갈렸어요 — API=${api} · worker=${worker}. 한 경로라도 다르면 사용자 쓰기를 재개하면 안 됩니다`,
    };
  }
  return { agreed: true, mode: api, reason: `두 서비스 모두 ${api}` };
}
