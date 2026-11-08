/**
 * 러너 키트: origin 허용 목록과 context 요청 판정. 브랜드 무관 — 허용 origin 은 인자로 받는다.
 */

function isBareOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * 정확히 같은 origin 만 통과시키는 판정 함수를 돌려준다. username·password 가 붙은 URL 과 해석되지 않는
 * 값은 거절한다. 목록 항목은 `new URL(x).origin` 꼴만 받는다 — 끝 슬래시·경로가 붙은 설정 실수는
 * 아무 요청도 통과하지 못하는 조용한 고장이 되므로 만들 때 던진다. 목록은 복사해 둔다.
 */
export function makeOriginAllowlist(origins) {
  const allowed = new Set();
  for (const origin of origins) {
    if (!isBareOrigin(origin)) throw new TypeError('Origin allowlist entries must be bare origins');
    allowed.add(origin);
  }
  return function allowedRequest(value) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return false;
      return allowed.has(url.origin);
    } catch {
      return false;
    }
  };
}

/** context 의 모든 요청을 allowed 로 판정해 허용 밖은 abort 한다. */
export async function routeAllowlist(context, allowed) {
  if (typeof allowed !== 'function') throw new TypeError('allowed must be a function');
  await context.route('**/*', (route) => (allowed(route.request().url()) ? route.continue() : route.abort()));
}
