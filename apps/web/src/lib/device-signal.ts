/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 수집 신호 진단 (Signal Doctor · 로드맵 C-2)
 *
 * "문자가 안 들어와요"의 원인을 **추측 목록이 아니라 신호로** 갈라낸다. 장치가
 * 내보내는 세 시각이 서로 다른 실패를 가리키기 때문에, 셋을 조합하면 사용자가
 * 다음에 무엇을 고쳐야 하는지가 하나로 좁혀진다.
 *
 *   lastSeenAt   — 마지막으로 **인증에 성공**한 시각(수집 POST·연결 테스트 포함)
 *   firstEventAt — 카드 문자가 **처음** 도착한 시각(= 설정 완주)
 *   lastEventAt  — 카드 문자가 **마지막으로** 도착한 시각(= 수집 생존)
 *
 * 순수 함수로 두는 이유: 이 판정이 틀리면 사용자를 엉뚱한 곳으로 보낸다(예:
 * 인증이 깨졌는데 "카드를 써 보세요"라고 안내). 컴포넌트 없이 테스트한다.
 * ------------------------------------------------------------------------- */
import type { DeviceSummary } from "@family/contracts";

/**
 * 마지막 수신이 이 시간을 넘기면 "끊김"으로 본다. 워커의 수집 공백 경보
 * (`apps/worker/src/notifications/notification-scheduler.service.ts`의
 * `COLLECTION_GAP_HOURS`)와 같은 값을 쓴다 — 서버가 경보를 올렸는데 화면은
 * 정상이라고 말하면(혹은 그 반대) 둘 중 하나는 반드시 거짓말이 된다.
 */
export const COLLECTION_GAP_HOURS = 36;

/**
 * 첫 문자를 이만큼 기다렸는데도 안 오면 진단을 띄운다. 결제 문자는 사용자가
 * 카드를 긁어야 오므로 이보다 짧게 잡으면 "아직 안 긁었을 뿐"을 고장으로 부른다.
 */
export const FIRST_EVENT_WAIT_MS = 60_000;

export type DeviceSignalState =
  /** 인증 자체가 한 번도 성공하지 않았다. */
  | "never_authenticated"
  /** 인증은 되는데 문자 트리거가 안 걸린다. */
  | "authenticated_no_sms"
  /** 받다가 끊겼다. */
  | "stalled"
  /** 최근까지 잘 받고 있다. */
  | "healthy";

export interface DeviceSignalDiagnosis {
  state: DeviceSignalState;
  /** 관측을 사용자 말로 옮긴 한 줄. */
  title: string;
  /** 그 관측이 무엇을 뜻하는지. */
  detail: string;
  /** 사용자가 지금 확인할 것(위에서부터 확률이 높다). */
  hints: string[];
}

/** 문자를 한 번이라도 받았는지 = 설정 완주 여부. */
export function isSetupComplete(device: DeviceSummary): boolean {
  return device.firstEventAt != null;
}

function elapsedMs(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? null : now - at;
}

/**
 * 장치의 세 시각으로 상태를 판정한다. `now`는 테스트가 고정할 수 있게 인자로 받는다.
 *
 * 순서가 중요하다 — 인증 실패는 다른 모든 증상의 상위 원인이라 먼저 걸러야 한다.
 * 인증도 못 하는 장치에 "문자 권한을 확인하세요"라고 하면 사용자는 엉뚱한 곳을
 * 30분 뒤진다.
 */
export function diagnoseDeviceSignal(
  device: DeviceSummary,
  now: number = Date.now(),
): DeviceSignalDiagnosis {
  if (!device.lastSeenAt) {
    return {
      state: "never_authenticated",
      title: "아직 이 휴대폰에서 아무 연락도 오지 않았어요",
      detail:
        "자동화 앱이 요청을 보내지 못했거나, 보낸 요청이 우리 서버에 닿지 못했어요.",
      hints: [
        "주소와 토큰을 다시 붙여넣어 주세요. 한 글자만 달라도 연결되지 않아요.",
        "자동화 앱에 인터넷 사용 권한이 켜져 있는지 확인해 주세요.",
        "'연결 테스트'를 눌러 인증만 먼저 확인해 볼 수 있어요.",
      ],
    };
  }

  if (!device.firstEventAt) {
    return {
      state: "authenticated_no_sms",
      title: "연결은 됐는데, 문자가 아직 한 통도 오지 않았어요",
      detail:
        "인증은 성공했어요. 자동화의 '문자 수신' 트리거가 걸리지 않고 있다는 뜻이에요.",
      hints: [
        "자동화 앱에 문자(SMS) 읽기 권한이 켜져 있는지 확인해 주세요.",
        "트리거의 발신자 조건이 카드사 번호와 맞는지 확인해 주세요. 조건을 비워두면 모든 문자가 걸려요.",
        "카드로 한 번 결제해 보거나, 카드사 문자를 다시 받아 보세요.",
      ],
    };
  }

  const sinceLastEvent = elapsedMs(device.lastEventAt, now);
  if (sinceLastEvent != null && sinceLastEvent > COLLECTION_GAP_HOURS * 3600_000) {
    return {
      state: "stalled",
      title: "잘 받다가 최근에 끊겼어요",
      detail: `마지막 문자가 온 지 ${COLLECTION_GAP_HOURS}시간이 넘었어요. 자동화가 멈춰 있을 수 있어요.`,
      hints: [
        "배터리 최적화(절전)에서 자동화 앱을 제외해 주세요. 절전이 걸리면 앱이 조용히 종료돼요.",
        "자동화 앱이 켜져 있고 매크로가 사용 중인지 확인해 주세요.",
        "그동안 카드를 쓰지 않았다면 정상이에요.",
      ],
    };
  }

  return {
    state: "healthy",
    title: "문자를 잘 받고 있어요",
    detail: "이 휴대폰에서 카드 문자가 정상적으로 들어오고 있어요.",
    hints: [],
  };
}
