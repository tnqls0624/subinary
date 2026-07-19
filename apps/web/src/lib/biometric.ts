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

/** 생체인식 인증 시도의 결과 분류. */
export type BiometricResult = "ok" | "cancelled" | "failed" | "unsupported";

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
 * - "cancelled"   : 사용자/시스템 취소 → 일반 로그인 화면으로
 * - "failed"      : 인증 실패·잠금(lockout) → 일반 로그인 화면으로
 * - "unsupported" : 미지원/미등록 기기 → 게이트를 건너뛴다(데드락 방지)
 */
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
          case BiometryErrorType.systemCancel:
          case BiometryErrorType.appCancel:
            return "cancelled";
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
