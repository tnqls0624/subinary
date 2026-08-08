/* ---------------------------------------------------------------------------
 * 로그인 후 복귀 경로(`?returnTo=`) 검증 (C-1)
 *
 * 초대 링크가 로그인에서 끊기지 않게 하려면 로그인 화면이 "어디로 돌아갈지"를
 * 쿼리로 받아야 한다. 그 값은 **공격자가 URL에 심을 수 있는 입력**이므로 그대로
 * 리다이렉트하면 오픈 리다이렉트가 된다 — 우리 도메인 로그인 화면을 거쳐 피싱
 * 사이트로 보내는, 자격증명 탈취에 가장 잘 쓰이는 형태다.
 *
 * 그래서 **앱 내부 경로만** 허용한다. 화이트리스트 방식이라 새 우회 기법이 나와도
 * 기본값이 '거부'다: `/`로 시작하고 `//`가 아니며 제어문자·공백·백슬래시가 없고,
 * 같은 오리진으로 해석되는 값만 통과한다.
 * ------------------------------------------------------------------------- */

/** 오리진 판정에만 쓰는 표식(실제 요청에는 쓰이지 않는다). */
const SENTINEL_ORIGIN = "https://return-to.invalid";

/** 제어문자(0x00~0x1F, 0x7F)와 공백 — 브라우저가 지우거나 바꿔 검증을 우회시킨다. */
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

/**
 * `returnTo` 값을 안전한 앱 내부 경로로 정규화한다. 안전하지 않으면 `null`.
 *
 * 거부 예: `https://evil.com`, `//evil.com`, `/\evil.com`, `javascript:alert(1)`,
 * `http:/evil.com`, 제어문자가 섞인 값, 상대경로 `dashboard`.
 */
export function safeInternalPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;

  // 검증을 통과한 문자열과 실제로 이동하는 URL이 달라지면 안 된다.
  if (CONTROL_OR_SPACE.test(raw)) return null;

  // 백슬래시는 브라우저가 `/`로 바꾼다 → `/\evil.com`이 `//evil.com`이 된다.
  if (raw.includes("\\")) return null;

  // 절대 URL·스킴(`javascript:`, `data:`)은 여기서 전부 걸린다.
  if (!raw.startsWith("/")) return null;

  // 프로토콜 상대 URL(`//evil.com`)은 `/`로 시작하지만 외부로 나간다.
  if (raw.startsWith("//")) return null;

  // 위 규칙을 통과해도 최종 판단은 파서에 맡긴다 — 우리가 놓친 형태가 있어도
  // 오리진이 달라지면 거부된다.
  let url: URL;
  try {
    url = new URL(raw, SENTINEL_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== SENTINEL_ORIGIN) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}
