/**
 * 생체인식 게이트의 재시도 판정.
 *
 * 실제로 있었던 일: 5시간 이상 앱을 안 쓰면 안드로이드가 프로세스를 회수하고,
 * 다음 실행은 콜드 스타트가 된다. 그때 앱이 다 뜨기 전에 생체인식 프롬프트를
 * 띄우면 OS가 거둬 가는데(`systemCancel`/`appCancel`), 그것을 사용자 취소와
 * 같이 다루는 동안 **아무 조작도 하지 않은 사용자가 로그인 화면으로 튕겼다.**
 * 서버 세션은 만료 2027년으로 멀쩡했고, 앱이 스스로 세션을 닫은 것이었다.
 */
import { describe, expect, it } from 'vitest';

import {
  BIOMETRIC_MAX_ATTEMPTS,
  shouldRetryBiometric,
  type BiometricResult,
} from './biometric';

describe('shouldRetryBiometric', () => {
  it('시스템 취소만 재시도한다', () => {
    expect(shouldRetryBiometric('interrupted', 1)).toBe(true);
  });

  it('사용자 취소는 재시도하지 않는다 — 취소가 불가능해진다', () => {
    // 재시도하면 프롬프트가 계속 다시 떠서 사용자가 앱을 못 벗어난다.
    expect(shouldRetryBiometric('cancelled', 1)).toBe(false);
  });

  it('실패·미지원·성공은 재시도하지 않는다', () => {
    for (const r of ['failed', 'unsupported', 'ok'] as BiometricResult[]) {
      expect(shouldRetryBiometric(r, 1)).toBe(false);
    }
  });

  it('상한을 넘으면 멈춘다 — 무한 프롬프트 방지', () => {
    expect(shouldRetryBiometric('interrupted', BIOMETRIC_MAX_ATTEMPTS)).toBe(
      false,
    );
    expect(
      shouldRetryBiometric('interrupted', BIOMETRIC_MAX_ATTEMPTS - 1),
    ).toBe(true);
  });

  it('상한은 1 이상이다', () => {
    // 0이면 재시도가 아예 없어 수정 전 동작으로 돌아간다.
    expect(BIOMETRIC_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });
});
