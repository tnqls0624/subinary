/**
 * 러너 키트: Chromium 기동·context·닫기·신호. 브랜드 무관.
 * playwright-core 는 import 하지 않고 chromium 을 인자로 받는다 — 모듈 해석이 호출 파일 위치 기준이라
 * import('playwright-core') 는 러너 진입 파일(run.mjs)에서만 한다.
 */

/**
 * Chromium 은 root 에서 샌드박스를 켠 채 뜨지 못한다. 운영 API 컨테이너는 USER 없이 uid 0 으로 돌므로
 * root 일 때만 끄고 그 밖에서는 켠다.
 */
export function chromiumSandboxEnabled(getuid = process.getuid) {
  return typeof getuid !== 'function' || getuid() !== 0;
}

export function isAbsoluteExecutable(value) {
  return typeof value === 'string' && value.startsWith('/');
}

/**
 * chromiumSandbox 에는 기본값을 두지 않는다. 빠뜨리면 Playwright 기본값(꺼짐)으로 조용히 떨어지므로
 * 진입 파일이 chromiumSandboxEnabled() 로 정해 넘긴다. Chromium 에 넘기는 env 는 PATH·TZ 뿐이다.
 */
export async function launchHeadless({
  chromium,
  executablePath,
  chromiumSandbox,
  timeoutMs = 20_000,
  timezone = 'Asia/Seoul',
  sourceEnv = process.env,
}) {
  if (!chromium || typeof chromium.launch !== 'function') throw new TypeError('chromium.launch is required');
  if (!isAbsoluteExecutable(executablePath)) throw new TypeError('executablePath must be absolute');
  if (typeof chromiumSandbox !== 'boolean') throw new TypeError('chromiumSandbox must be boolean');
  return chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox,
    timeout: timeoutMs,
    env: { PATH: sourceEnv.PATH ?? '/usr/bin:/bin', TZ: timezone },
  });
}

export async function openIsolatedContext(browser) {
  return browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
}

/**
 * getters 순서대로(context → browser) 한 번만 닫는다. 대상은 닫는 그때 읽는다 — 기동 도중 신호가 와도
 * 그때까지 생긴 것만 닫는다. 닫기 오류는 본문 없이 삼킨다.
 */
export function createCloser(getters) {
  let closing = false;
  return async function close() {
    if (closing) return;
    closing = true;
    for (const get of getters) {
      try { await get()?.close(); } catch { /* No diagnostic body. */ }
    }
  };
}

/** SIGTERM·SIGINT 를 받으면 닫고 0 으로 끝낸다. 걸어 둔 처리기를 떼는 함수를 돌려준다. */
export function installSignalCleanup(close, proc = process) {
  const onSignal = () => {
    void (async () => {
      try { await close(); } catch { /* 닫기에 실패해도 끝낸다. */ }
      proc.exit(0);
    })();
  };
  proc.on('SIGTERM', onSignal);
  proc.on('SIGINT', onSignal);
  return () => {
    proc.off('SIGTERM', onSignal);
    proc.off('SIGINT', onSignal);
  };
}
