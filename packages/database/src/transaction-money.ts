/**
 * 금액 계약 공용 상수·체크섬 (ADR-0027, 마이그레이션 `0049`).
 *
 * 여기 있는 것은 **DB 행에 대한 사실**뿐이다 — 어떤 컬럼이 금액 서비스 전용인지, 한 행의
 * 금액 상태를 무엇으로 요약하는지. 환산 산술(`minor units × 환율 → KRW`)과 취소 체인
 * 재계산은 `@family/transaction-domain`의 `TransactionMoneyService`가 소유한다. 여기에
 * 두면 도메인 규칙이 다시 두 곳으로 갈라져 ADR-0027이 없애려는 상태로 돌아간다.
 *
 * schema.ts가 아니라 별도 파일인 이유: schema.ts는 테이블 선언만 담는다는 관습을 지킨다.
 */
import { createHash } from 'node:crypto';

/** 마이그레이션 `0049` 이전의 계약. 기존 행과 롤백 창의 이전 바이너리가 만드는 행. */
export const MONEY_CONTRACT_VERSION_V1 = 1;

/** ADR-0027 계약. 새 금액 서비스만 이 값을 **명시적으로** 쓴다. */
export const MONEY_CONTRACT_VERSION_V2 = 2;

/**
 * `TransactionMoneyService`만 쓸 수 있는 `card_transactions` 컬럼 (ADR-0027 §1).
 *
 * 아키텍처 테스트가 이 목록을 근거로 "금액 도메인 패키지 밖에서 이 컬럼들을 쓰는 코드가
 * 남아 있는지"를 본다. 목록이 코드에 있어야 하는 이유가 그것이다 — 규약을 문서와 코드
 * 리뷰 기억에만 두면 새 진입점이 생길 때마다 조용히 우회한다(D-2·D-3이 그렇게 생겼다).
 *
 * `status`가 들어 있는 것은 ADR §1이 "금액에서 파생되는 status"를 서비스 소유로 정했기
 * 때문이다. 다만 `duplicate_suspected`처럼 금액과 무관한 전이도 같은 컬럼을 쓴다 —
 * 중복 탐지기가 이 값을 바꾸면 체크섬도 함께 바뀌어 자동 되돌림이 보수적으로 멈춘다.
 * 멈추는 쪽이 사용자 수정을 덮어쓰는 쪽보다 안전하므로 그대로 둔다.
 *
 * `excludedAt`은 여기 없다. 집계 포함 여부 플래그일 뿐 금액이 아니고, 사용자가 언제든
 * 토글한다(ADR-0026).
 */
export const MONEY_PROTECTED_COLUMNS = [
  'amount',
  'currency',
  'originalAmount',
  'originalCurrency',
  'exchangeRate',
  'fxRateSnapshotId',
  'cancelledAmount',
  'originalCancelledAmount',
  'netAmount',
  'parentTransactionId',
  'status',
  'moneyContractVersion',
] as const;

export type MoneyProtectedColumn = (typeof MONEY_PROTECTED_COLUMNS)[number];

/**
 * 위 목록의 DB 컬럼명. 순서는 {@link MONEY_PROTECTED_COLUMNS}와 1:1로 같다.
 *
 * 왜 따로 두는가: 아키텍처 테스트와 수리 작업은 Drizzle 표현식만 보는 게 아니라 원시 SQL
 * (`sql\`\``·검증 스크립트)도 훑어야 한다. 그쪽은 snake_case로 적혀 있다.
 */
export const MONEY_PROTECTED_DB_COLUMNS = [
  'amount',
  'currency',
  'original_amount',
  'original_currency',
  'exchange_rate',
  'fx_rate_snapshot_id',
  'cancelled_amount',
  'original_cancelled_amount',
  'net_amount',
  'parent_transaction_id',
  'status',
  'money_contract_version',
] as const;

/**
 * 체크섬 대상 = 쓰기 보호 집합 + `approvedAt`.
 *
 * `approvedAt`은 서비스 전용 컬럼이 아니지만 **환율 기준일의 입력**이다(ADR-0027 §3).
 * 사용자가 승인시각을 고치면 같은 금액이라도 다른 날 환율로 재계산돼야 하므로, 수리
 * 적용·되돌림 판단에서 "그 사이 아무도 손대지 않았다"의 범위에 포함해야 한다.
 */
export const MONEY_CHECKSUM_COLUMNS = [
  ...MONEY_PROTECTED_COLUMNS,
  'approvedAt',
] as const;

export type MoneyChecksumColumn = (typeof MONEY_CHECKSUM_COLUMNS)[number];

/**
 * 체크섬 입력 포맷 버전. 정규화 방식을 바꾸면 **반드시 올린다** — 값 앞에 붙어 저장되므로
 * 옛 배치의 체크섬을 새 방식으로 잘못 비교하는 일이 생기지 않는다.
 */
export const MONEY_CHECKSUM_FORMAT = 'v1';

/**
 * 체크섬·before/after 이미지를 만들 수 있는 최소 행 모양.
 *
 * `CardTransaction` 전체를 요구하지 않는 이유: 수리 작업과 shadow 비교는 필요한 컬럼만
 * 골라 원시 SQL로 읽는다. 전체 행을 강요하면 그쪽이 캐스팅으로 우회하게 된다.
 */
export interface TransactionMoneyRowLike {
  id: string;
  amount: number;
  currency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  exchangeRate: number | null;
  fxRateSnapshotId: string | null;
  cancelledAmount: number;
  originalCancelledAmount: number | null;
  netAmount: number;
  parentTransactionId: string | null;
  status: string;
  moneyContractVersion: number;
  approvedAt: Date | string | null;
}

/** `transaction_money_repair_log.before_money` / `after_money`에 저장하는 모양. */
export type TransactionMoneyImage = {
  [K in MoneyProtectedColumn]: TransactionMoneyRowLike[K] | null;
};

/**
 * 보호 컬럼만 골라 **키 순서가 고정된** 객체로 만든다.
 *
 * 키 순서를 고정하는 이유: 이 객체가 체크섬 입력이자 jsonb 저장값이다. 순서가 호출자마다
 * 다르면 같은 행이 다른 체크섬을 내고, 그 순간 "적용 직전에 행이 바뀌었는지" 판정이
 * 무의미해진다.
 */
export function buildTransactionMoneyImage(
  row: TransactionMoneyRowLike,
): TransactionMoneyImage {
  const image: Record<string, unknown> = {};
  for (const column of MONEY_PROTECTED_COLUMNS) {
    image[column] = row[column] ?? null;
  }
  return image as TransactionMoneyImage;
}

/**
 * 한 거래의 금액 상태 체크섬 — `sha256:<hex>`.
 *
 * 두 곳에서 쓴다(ADR-0027 §데이터 마이그레이션 계획 §3·§4):
 * - **적용 직전**: manifest를 만든 뒤 새 거래·사용자 수정이 끼어들지 않았는지 확인한다.
 *   다르면 그 체인을 통째로 건너뛴다.
 * - **되돌릴 때**: 적용 후 사용자가 이 거래를 손댔는지 확인한다. 다르면 자동 되돌림을
 *   중단하고 사람이 병합한다 — 사용자 수정을 덮어쓰지 않는다.
 *
 * 메모·카테고리·가맹점·`excludedAt` 수정은 체크섬을 바꾸지 않는다. 금액과 무관한 편집
 * 때문에 수리가 막히면 사람이 확인할 일만 늘고 안전해지는 것은 없다.
 */
export function transactionMoneyChecksum(row: TransactionMoneyRowLike): string {
  const payload = JSON.stringify([
    MONEY_CHECKSUM_FORMAT,
    row.id,
    ...MONEY_CHECKSUM_COLUMNS.map((column) => canonicalize(row[column])),
  ]);
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

/**
 * 체크섬 입력 정규화.
 *
 * Date를 ISO 문자열로 바꾸는 이유: `JSON.stringify`는 Date를 UTC ISO로 직렬화하지만,
 * 같은 시각이 드라이버에 따라 Date로도 문자열로도 온다(원시 SQL 조회 vs Drizzle). 둘이
 * 같은 값을 내도록 여기서 한 번에 맞춘다.
 */
function canonicalize(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}
