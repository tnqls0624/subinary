/**
 * CORS `allowedHeaders`와 컨트롤러가 요구하는 헤더를 대조한다.
 *
 * 이 둘이 어긋나면 **same-origin에서는 멀쩡하고 cross-origin에서만** 기능이 죽는다.
 * Capacitor 앱은 `capacitor://localhost` origin이라 preflight를 타고, allowlist에 없는
 * 헤더를 붙인 요청은 WebView가 본 요청을 보내지도 않고 취소한다 — **서버 로그에
 * 아무것도 남지 않는다.** 그래서 운영 웹으로 테스트하면 통과하고 폰에서만 실패한다.
 *
 * 2026-08-20: `Idempotency-Key`가 빠져 예산 "다음 달 계획 복사"가 폰에서만 실패했다.
 * 타입체크·단위테스트·빌드가 전부 통과했다 — 헤더 이름은 문자열이라 아무도 대조하지
 * 않았다. `money-fence-scope.test.ts`가 가드 위치를 소스에서 읽어 고정하는 것과 같은
 * 방식으로 여기서 고정한다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');

/**
 * 브라우저가 부르지 않는 컨트롤러 — CORS 대조에서 제외한다.
 *
 * `card-sms.controller.ts`의 텍스트·토큰 수집은 `@Public() + DeviceTokenGuard`로,
 * 외부 자동화(MacroDroid·iOS 단축어)가 Bearer 토큰으로 부른다. CORS는 브라우저 정책이라
 * 그 호출자에게는 적용되지 않는다. 웹 소스에서 `x-event-id` 같은 이름이 보이는 곳은
 * 수집 설정 마법사가 사용자에게 **복사용으로 안내하는 문구**뿐이고, 앱이 그 요청을
 * 보내지는 않는다.
 *
 * ⚠️ 여기에 파일을 추가하기 전에 반드시 확인할 것: **정말 브라우저가 안 부르는가?**
 * 웹·모바일이 부르는 경로를 넣으면 이 테스트가 지키려는 것이 그대로 사라진다.
 */
const NON_BROWSER_CONTROLLERS = ['card-sms/card-sms.controller.ts'];

/** CORS safelist — 브라우저가 preflight 없이 보내는 헤더는 allowlist가 필요 없다. */
const CORS_SAFELISTED = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('CORS allowedHeaders', () => {
  const main = readFileSync(resolve(SRC, 'main.ts'), 'utf8');

  /** `allowedHeaders: [...]` 블록에서 문자열만 뽑아 소문자로. */
  const allowed = (() => {
    const block = main.match(/allowedHeaders:\s*\[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    return new Set(
      [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1].toLowerCase()),
    );
  })();

  it('allowlist를 읽는다', () => {
    expect(allowed.size).toBeGreaterThan(3);
  });

  it('컨트롤러가 @Headers()로 요구하는 헤더가 전부 allowlist에 있다', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const relative = file.replace(`${SRC}/`, '');
      if (NON_BROWSER_CONTROLLERS.includes(relative)) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/@Headers\(\s*'([^']+)'\s*\)/g)) {
        const header = match[1].toLowerCase();
        if (CORS_SAFELISTED.has(header)) continue;
        if (!allowed.has(header)) {
          missing.push(`${file.replace(SRC, 'src')}: '${header}'`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('Idempotency-Key가 allowlist에 있다 (2026-08-20 회귀)', () => {
    // 이 헤더를 요구하는 호출부가 하나뿐이라, 빠져도 다른 기능은 전부 정상이었다.
    expect(allowed.has('idempotency-key')).toBe(true);
  });

  it('네이티브 origin이 허용 목록에 있다 — preflight가 성립하는 전제', () => {
    expect(main).toContain('NATIVE_CLIENT_ORIGINS');
  });

  it('제외 목록의 컨트롤러가 실제로 존재한다', () => {
    // 파일이 이름을 바꾸거나 사라지면 제외가 조용히 무효가 되고, 그때부터 이 테스트는
    // 검사하지 않는 것을 검사한다고 착각하게 된다.
    for (const relative of NON_BROWSER_CONTROLLERS) {
      expect(() => readFileSync(resolve(SRC, relative), 'utf8')).not.toThrow();
    }
  });

  it('제외된 컨트롤러가 브라우저용 가드를 쓰지 않는다', () => {
    // 제외의 근거는 "외부 자동화 전용"이다. 그 컨트롤러가 사용자 토큰 경로를 갖게 되면
    // 근거가 사라지므로, DeviceTokenGuard/DeviceHmacGuard가 붙어 있는지 확인한다.
    for (const relative of NON_BROWSER_CONTROLLERS) {
      const source = readFileSync(resolve(SRC, relative), 'utf8');
      expect(source).toMatch(/Device(Token|Hmac)Guard/);
    }
  });
});
