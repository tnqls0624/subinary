/* ---------------------------------------------------------------------------
 * 딥링크로 연 거래를 열 수 없을 때 무엇을 말할 것인가 (P2)
 *
 * 알림·`/todo`에서 거래를 탭하면 `/transactions?txn=<id>`로 오고, 목록에 없으면
 * 단건 조회로 폴백한다(`lib/deep-link.ts`). 그 조회가 실패하면 예전에는 **아무 일도
 * 일어나지 않았다** — 상세가 안 열리고 오류도 없어서 사용자는 앱이 멈춘 줄 안다.
 * 없는 것 · 막힌 것 · 오류를 구분해서 말하는 것이 이 모듈의 전부다.
 *
 * ⚠️ 서버는 **다른 구성원의 `private` 거래를 404로 감춘다**
 * (`apps/api/src/transactions/transaction.service.ts:305`). 존재 자체를 숨기는
 * 의도된 설계라, 웹이 404를 "삭제된 거래예요"로 단정하면 거짓말이 된다. 그래서 404
 * 문구는 "삭제됐거나 볼 수 없는"까지만 말한다. 403은 **그 가족의 구성원이 아닐 때만**
 * 오므로(가족에서 빠진 뒤 남아 있던 알림을 탭한 경우) 그때만 "볼 수 없다"고 단정한다.
 *
 * 401은 여기까지 오지 않는다 — `authedFetch`가 refresh를 시도하고, 실패하면 세션을
 * 닫아 `/login`으로 보낸다.
 * ------------------------------------------------------------------------- */

/** 거래를 열지 못한 이유. */
export type DetailFallbackReason = "forbidden" | "missing" | "error";

/** 화면에 그대로 띄우는 문구(한국어). */
export interface DetailFallbackCopy {
  title: string;
  description: string;
  /** 다시 시도할 가치가 있는 실패인가(일시적 오류만 true). */
  retryable: boolean;
}

/**
 * HTTP status → 이유. `ApiError`를 직접 import하지 않고 `status` 필드만 본다 —
 * 이 모듈을 순수하게 유지해 API 클라이언트(네이티브 플러그인까지 끌고 온다) 없이
 * 테스트하기 위해서다.
 */
export function detailFallbackReason(error: unknown): DetailFallbackReason {
  const status = httpStatusOf(error);
  if (status === 403) return "forbidden";
  // 400: 링크에 실린 id가 uuid 형태가 아니다 — 사용자에게는 "그런 거래가 없다"와 같다.
  if (status === 404 || status === 400) return "missing";
  return "error";
}

/** 이유 → 문구. */
export function detailFallbackCopy(
  reason: DetailFallbackReason,
): DetailFallbackCopy {
  switch (reason) {
    case "forbidden":
      return {
        title: "볼 수 없는 거래예요",
        description:
          "이 거래가 있는 가족의 구성원이 아니에요. 가족에서 나온 뒤에 온 알림일 수 있어요.",
        retryable: false,
      };
    case "missing":
      // 서버가 '삭제됨'과 '남의 비공개'를 일부러 같은 404로 준다 — 둘 중 하나라고
      // 단정하지 않는 것이 사실에 맞다.
      return {
        title: "찾을 수 없는 거래예요",
        description: "삭제됐거나, 다른 구성원이 비공개로 둔 거래예요.",
        retryable: false,
      };
    case "error":
      return {
        title: "거래를 불러오지 못했어요",
        description: "연결이 불안정할 수 있어요. 잠시 후 다시 시도해 주세요.",
        retryable: true,
      };
  }
}

/** 에러 객체에서 HTTP status를 꺼낸다(없으면 null). */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}
