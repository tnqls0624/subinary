/* ---------------------------------------------------------------------------
 * 장치를 관리(재발급·폐기)할 수 있는가 (P2)
 *
 * 서버는 이미 막고 있어서 데이터 사고는 아니었다. 문제는 **항상 실패하는 버튼이
 * 보이는 것**이다 — 눌러 보고 빨간 오류를 받은 사용자는 자기가 뭘 잘못했는지
 * 알 수 없다. 그래서 권한이 없으면 감춘다(비활성화가 아니라 숨김: 비활성 버튼은
 * "언젠가 되는 것"으로 읽힌다).
 *
 * 판정은 서버의 `requireManageableDevice`를 그대로 옮긴 것이다
 * (`apps/api/src/devices/device.service.ts:128`):
 *   **가족 소유자(owner)이거나, 그 장치를 등록한 본인.**
 * 두 입력 모두 서버 응답에서 온다 — 역할은 `GET /v1/auth/me`의 멤버십,
 * 내 memberId는 `GET /v1/households/:id/members`에서 내 userId로 찾는다.
 * 클라이언트가 역할을 추측하지 않는다는 뜻이다.
 *
 * 모르면 감춘다: 구성원 목록을 아직 못 읽었거나(로딩·실패) 내 행이 없으면 false다.
 * 소유자는 목록 없이도 판정되므로, 이 보수적 기본값 때문에 소유자가 잠기지 않는다.
 * ------------------------------------------------------------------------- */
import type { HouseholdRole, MemberSummary } from "@family/contracts";

export interface DeviceManagePermission {
  /** 현재 가족에서 내 역할(모르면 null). */
  role: HouseholdRole | null | undefined;
  /** 현재 가족에서 내 memberId(모르면 null). */
  myMemberId: string | null;
}

/** 그 장치의 재발급·폐기 메뉴를 보여도 되는가. */
export function canManageDevice(
  { role, myMemberId }: DeviceManagePermission,
  deviceMemberId: string,
): boolean {
  if (role === "owner") return true;
  if (!myMemberId) return false;
  return myMemberId === deviceMemberId;
}

/**
 * 구성원 목록에서 내 memberId를 찾는다. `userId`는 계정, `memberId`는 그 계정의
 * **이 가족 안에서의 신원**이다 — 장치 소유는 후자로 기록된다.
 *
 * `status`가 `removed`인 행은 세지 않는다(가족에서 빠진 뒤 남은 기록).
 */
export function findMyMemberId(
  members: ReadonlyArray<MemberSummary> | undefined,
  userId: string | null | undefined,
): string | null {
  if (!members || !userId) return null;
  return (
    members.find((m) => m.userId === userId && m.status === "active")
      ?.memberId ?? null
  );
}
