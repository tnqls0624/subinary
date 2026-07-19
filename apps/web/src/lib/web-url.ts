/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 공개 웹 URL
 *
 * 밖으로 공유되는 절대 URL(초대 링크 등)은 현재 origin이 아니라 공개 웹
 * 도메인으로 만들어야 한다. Capacitor 앱의 origin은 capacitor://localhost(iOS) /
 * https://localhost(Android)라서 window.location.origin을 쓰면 받는 사람이
 * 열 수 없는 링크가 된다.
 *
 * NEXT_PUBLIC_WEB_URL(빌드 시 번들에 인라인) 우선, 미설정 시
 * window.location.origin fallback — 브라우저로 접속한 웹 배포에서는 접속
 * 도메인이 곧 공개 도메인이므로 유효하다.
 * ------------------------------------------------------------------------- */

// NEXT_PUBLIC_*는 정적 참조여야 빌드 타임 치환된다(구조분해/동적 접근 불가).
const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL;

/** 공유용 절대 URL을 만든다. `path`는 `/`로 시작하는 경로여야 한다. */
export function publicWebUrl(path: string): string {
  const base =
    WEB_URL?.replace(/\/+$/, "") ??
    (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}${path}`;
}
