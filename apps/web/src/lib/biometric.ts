/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 생체인식(Face ID/Touch ID/지문) 잠금
 *
 * 네이티브(Capacitor) 전용 — 저장된 refresh 토큰으로 자동 로그인하기 전에
 * 기기 소유자 확인 게이트를 세운다. 웹에서는 모든 함수가 no-op/비활성이다.
 *
 * 보안 노트: 이 게이트는 UX 수준의 본인 확인이다. refresh 토큰 자체는
 * @capacitor/preferences에 있으므로 암호학적 바인딩(biometry-bound
 * Keychain/Keystore)이 필요해지면 secure-storage 계열 플러그인으로 저장소를
 * 옮겨야 한다.
 *
 * 설정 상태는 3값이다(family.biometricLogin):
 *  - null  : 아직 묻지 않음 → 로그인 직후 옵트인 제안 대상
 *  - "on"  : 활성 — 부트스트랩 자동 로그인 전 생체인식 게이트
 *  - "off" : 비활성(사용자가 거절/해제) — 다시 묻지 않음
 *
 * 플러그인은 native.ts 관례대로 동적 import로만 로드한다(웹 번들/프리렌더 보호).
 * ------------------------------------------------------------------------- */
import { Preferences } from "@capacitor/preferences";

import { isNative } from "./native";

/** Preferences 키 — 생체인식 잠금 설정(3값: null/"on"/"off"). */
const BIOMETRIC_KEY = "family.biometricLogin";

/**
 * 생체인식 인증 시도의 결과 분류.
 *
 * `cancelled`(사용자가 취소)와 `interrupted`(OS가 프롬프트를 거둠)를 반드시
 * 구분한다. 둘을 합쳐 두는 동안, 콜드 스타트에서 앱이 다 뜨기 전에 프롬프트를
 * 띄워 시스템이 취소해 버리면 **사용자가 아무것도 하지 않았는데 로그아웃**됐다.
 * 서버 세션은 멀쩡히 살아 있었다 — 앱이 스스로 세션을 닫은 것이다.
 */
export type BiometricResult =
  | "ok"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "unsupported";

/** 시스템 취소로 중단됐을 때 다시 시도할 최대 횟수. */
export const BIOMETRIC_MAX_ATTEMPTS = 3;

/**
 * 한 번 더 시도할 것인가.
 *
 * `interrupted`만 재시도한다. 사용자가 취소한 것(`cancelled`)을 재시도하면
 * 프롬프트가 계속 다시 뜨는 셈이라 "취소"가 불가능해진다.
 */
export function shouldRetryBiometric(
  result: BiometricResult,
  attempt: number,
  maxAttempts: number = BIOMETRIC_MAX_ATTEMPTS,
): boolean {
  return result === "interrupted" && attempt < maxAttempts;
}

export type BiometricPref = "on" | "off" | null;

/** 저장된 생체인식 설정. 웹: 항상 null. */
export async function getBiometricPref(): Promise<BiometricPref> {
  if (!isNative()) return null;
  const { value } = await Preferences.get({ key: BIOMETRIC_KEY });
  return value === "on" || value === "off" ? value : null;
}

/** 생체인식 설정 저장. 웹: no-op. */
export async function setBiometricPref(pref: "on" | "off"): Promise<void> {
  if (!isNative()) return;
  await Preferences.set({ key: BIOMETRIC_KEY, value: pref });
}

/**
 * 이 기기에서 생체인식(또는 기기 잠금 자격)이 사용 가능한지.
 * 웹/플러그인 미탑재 셸(구버전 바이너리): false.
 */
export async function isBiometryAvailable(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const { BiometricAuth } = await import(
      "@aparajita/capacitor-biometric-auth"
    );
    const check = await BiometricAuth.checkBiometry();
    return check.isAvailable;
  } catch {
    return false;
  }
}

/**
 * 생체인식 프롬프트를 띄워 본인 확인을 수행한다.
 *
 * - "ok"          : 인증 성공 → 저장된 세션 사용 진행
 * - "cancelled"   : **사용자가** 취소 → 일반 로그인 화면으로
 * - "interrupted" : OS가 프롬프트를 거둠 → 호출부가 재시도해야 한다
 * - "failed"      : 인증 실패·잠금(lockout) → 일반 로그인 화면으로
 * - "unsupported" : 미지원/미등록 기기 → 게이트를 건너뛴다(데드락 방지)
 */
/**
 * 앱이 실제로 전면에 올라올 때까지 기다린다(최대 `timeoutMs`).
 *
 * 콜드 스타트에서 프롬프트가 시스템 취소되는 근본 이유가 "아직 준비가 안 된 채로
 * 띄웠다"이므로, 재시도 전에 이 조건을 맞춰야 같은 실패를 반복하지 않는다.
 */
async function waitUntilForeground(timeoutMs: number): Promise<void> {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") {
    // 이미 보이더라도 한 프레임 양보한다 — visible 직후에는 액티비티 전환이
    // 아직 끝나지 않아 프롬프트가 다시 거둬지는 경우가 있다.
    await new Promise((r) => setTimeout(r, 250));
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      document.removeEventListener("visibilitychange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (document.visibilityState === "visible") done();
    };
    const timer = setTimeout(done, timeoutMs);
    document.addEventListener("visibilitychange", onChange);
  });
}

/**
 * 시스템 취소(`interrupted`)에 한해 앱이 전면에 오길 기다렸다가 다시 시도한다.
 *
 * 부트스트랩 게이트는 이것을 쓴다. 사용자 취소·실패는 그대로 돌려주므로
 * "취소했는데 계속 뜬다"가 되지 않는다.
 */
export async function authenticateBiometricResilient(
  reason: string,
  maxAttempts: number = BIOMETRIC_MAX_ATTEMPTS,
): Promise<BiometricResult> {
  let result = await authenticateBiometric(reason);
  for (let attempt = 1; shouldRetryBiometric(result, attempt, maxAttempts); attempt++) {
    await waitUntilForeground(3_000);
    result = await authenticateBiometric(reason);
  }
  return result;
}

export async function authenticateBiometric(
  reason: string,
): Promise<BiometricResult> {
  if (!isNative()) return "unsupported";
  try {
    const { BiometricAuth, BiometryError, BiometryErrorType } = await import(
      "@aparajita/capacitor-biometric-auth"
    );

    const check = await BiometricAuth.checkBiometry();
    // lockout(연속 실패 잠금)은 미지원이 아니다 — iOS checkBiometry는 lockout을
    // isAvailable=false로 보고하므로 여기서 걸러버리면 게이트가 통째로 우회된다.
    // allowDeviceCredential=true의 authenticate()는 lockout을 기기 패스코드
    // 폴백으로 안전하게 처리하므로 그대로 프롬프트를 진행한다.
    if (
      !check.isAvailable &&
      check.code !== BiometryErrorType.biometryLockout
    ) {
      return "unsupported";
    }

    try {
      await BiometricAuth.authenticate({
        reason,
        cancelTitle: "취소",
        // 생체인식 반복 실패 시 기기 PIN/패턴/패스코드 폴백 허용.
        allowDeviceCredential: true,
        iosFallbackTitle: "암호 사용",
        androidTitle: "본인 확인",
        androidSubtitle: reason,
      });
      return "ok";
    } catch (e) {
      if (e instanceof BiometryError) {
        switch (e.code) {
          case BiometryErrorType.userCancel:
            return "cancelled";
          // 시스템/앱이 프롬프트를 거둔 것 — 사용자의 의사 표시가 아니다.
          // 콜드 스타트에서 액티비티가 준비되기 전에 프롬프트를 띄우면 여기로
          // 떨어진다. 사용자 취소와 같이 다루면 아무 조작 없이 세션이 닫힌다.
          case BiometryErrorType.systemCancel:
          case BiometryErrorType.appCancel:
            return "interrupted";
          case BiometryErrorType.biometryNotEnrolled:
          case BiometryErrorType.biometryNotAvailable:
          case BiometryErrorType.passcodeNotSet:
            return "unsupported";
          default:
            return "failed";
        }
      }
      return "failed";
    }
  } catch {
    // 플러그인 미탑재 셸(구버전 앱 바이너리) — 게이트 없이 진행.
    return "unsupported";
  }
}
