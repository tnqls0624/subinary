/**
 * 금액 명령 거절 → HTTP 응답 매핑 (ADR-0027 롤아웃 5단계).
 *
 * 거절 사유는 도메인 어휘(`MoneyRejectionReason | MoneyCommandRejection`)이고 사용자는
 * 그 단어를 모른다. 매핑을 경로마다 쓰면 같은 사유가 화면마다 다른 문장으로 나오므로
 * 한 곳에 둔다.
 *
 * ## 왜 "실패"가 옳은 응답인가
 *
 * 특히 `fx_snapshot_missing`은 "환율을 아직 모른다"는 뜻이다. 예전 경로는 이때 오늘
 * 환율로 대체하거나 minor unit을 그대로 원화로 넣었고(D-5), 그래서 화면마다 다른 금액이
 * 보였다. ADR의 판단은 명확하다 — **조용히 틀린 지출을 확정하는 것보다 반영을 미루는
 * 것이 안전하다.** 그 판단을 사용자에게 설명하는 것이 이 매핑의 일이다.
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

/** 사유 코드 → 사용자에게 보일 한국어 문장. 해요체(웹 카피 규약). */
const MESSAGES: Record<string, string> = {
  fx_snapshot_missing:
    '이 거래일의 환율 정보가 아직 없어요. 환율이 확정되면 다시 시도해 주세요.',
  currency_mismatch: '승인과 취소의 통화가 달라요. 취소를 연결할 수 없어요.',
  cancellation_exceeds_approval: '취소 금액이 승인 금액보다 커요.',
  invalid_amount: '금액이 올바르지 않아요.',
  unsupported_currency: '아직 지원하지 않는 통화예요.',
  invalid_rate: '환율 값이 올바르지 않아 계산할 수 없어요.',
  amount_out_of_range: '금액이 계산할 수 있는 범위를 벗어났어요.',
  transaction_not_found: '거래를 찾을 수 없어요.',
  transaction_type_mismatch: '이 거래에는 적용할 수 없는 요청이에요.',
  cancellation_already_linked: '이미 다른 승인에 연결된 취소예요.',
  household_mismatch: '다른 가족의 거래는 연결할 수 없어요.',
};

/**
 * 거절 사유를 그에 맞는 HTTP 예외로 바꾼다.
 *
 * 상태 코드를 사유별로 가르는 이유: 클라이언트가 재시도해도 되는 것(422 — 환율이
 * 생기면 성공한다)과 요청 자체가 잘못된 것(400), 대상이 없는 것(404), 상태가 충돌한
 * 것(409)은 다르게 다뤄야 한다.
 */
export function moneyRejectionToHttp(reason: string): Error {
  const message = MESSAGES[reason] ?? '금액을 계산할 수 없어 저장하지 못했어요.';
  switch (reason) {
    case 'transaction_not_found':
      return new NotFoundException(message);
    case 'cancellation_already_linked':
    case 'household_mismatch':
    case 'transaction_type_mismatch':
      return new ConflictException(message);
    case 'fx_snapshot_missing':
      // 입력이 틀린 게 아니라 **아직** 계산할 수 없다. 나중에 같은 요청이 성공한다.
      return new UnprocessableEntityException(message);
    default:
      return new BadRequestException(message);
  }
}
