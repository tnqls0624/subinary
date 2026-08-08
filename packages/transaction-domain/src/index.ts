/**
 * `@family/transaction-domain` — 거래 금액 계약의 공유 구현 (ADR-0027).
 *
 * API와 worker가 **같은 구현**을 가져다 쓰기 위한 프레임워크 중립 패키지다. Nest
 * 데코레이터가 없는 것은 의도한 것이다 — 한 앱의 서비스에 다른 앱이 의존하면
 * ADR §1이 없애려는 구조가 그대로 남는다. 각 앱은 얇은 provider로 감싼다.
 *
 * 롤아웃 3단계(shadow)인 지금 운영 경로가 실제로 부르는 것은 관찰기뿐이고,
 * `TransactionMoneyService`는 enforce 전환(5단계)에서 켜진다.
 */
export {
  FX_RATE_SCALE,
  MONEY_SETTLEMENT_CURRENCY,
  MONEY_SUPPORTED_CURRENCIES,
  convertToKrw,
  fxBaseDate,
  fxRateDisplayValue,
  isSupportedMoneyCurrency,
  moneyCurrencyExponent,
  parseFxRate,
} from './money-math.js';
export type { MoneyConversion, MoneyConversionFailure } from './money-math.js';

export {
  candidateCurrency,
  candidateRemaining,
  orderedLockIds,
  planChain,
  selectCancellationParent,
} from './plan.js';
export type {
  CancellationCandidate,
  CancellationEvidence,
  CancellationMatch,
  ChainApprovalInput,
  ChainCancellationInput,
  ChainPlan,
  FxSnapshotRef,
  MoneyColumnRecord,
  MoneyColumns,
  MoneyPlan,
  MoneyRejectionReason,
  MoneyReviewFlag,
  MoneyStatus,
  MoneyTransactionType,
} from './plan.js';

export {
  DrizzleFxSnapshotStore,
  RequestScopedFxSnapshotResolver,
} from './fx-snapshot-store.js';
export type {
  FxSnapshotKey,
  FxSnapshotOrigin,
  FxSnapshotResolver,
} from './fx-snapshot-store.js';

export {
  MONEY_ROW_COLUMNS,
  TransactionMoneyService,
  toCandidate,
} from './transaction-money.service.js';
export type {
  CancellationOutcome,
  ChainOutcome,
  CreateApprovalCommand,
  CreateCancellationCommand,
  MoneyCommandOptions,
  MoneyCommandRejection,
  MoneyCommandResult,
  MoneyRow,
  TransactionMetadata,
} from './transaction-money.service.js';

export { classifyMoneyShadow, summarizeMoneyShadow } from './shadow.js';
export type {
  ClassifyMoneyShadowInput,
  MoneyShadowActual,
  MoneyShadowPath,
  MoneyShadowRecord,
  MoneyShadowSummary,
  MoneyShadowVerdict,
} from './shadow.js';

export {
  MONEY_SHADOW_REASON_PREFIX,
  TransactionMoneyShadowSink,
} from './shadow-sink.js';
export type { MoneyShadowLogger, MoneyShadowSinkStats } from './shadow-sink.js';

export { TransactionMoneyShadowObserver } from './shadow-observer.js';

export {
  DYNAMIC_COLUMNS,
  MONEY_WRITE_PATTERNS,
  scanMoneyWriteViolations,
} from './architecture.js';
export type { MoneyWriteViolation, ScanTarget } from './architecture.js';
