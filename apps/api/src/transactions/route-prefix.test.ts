/**
 * 컨트롤러 경로에 `v1`을 손으로 붙이지 않는다 — 글로벌 prefix가 이미 붙인다.
 *
 * 2026-08-20에 `@Controller('v1/transactions/recategorize')`로 배포해 실제 경로가
 * `/v1/v1/transactions/recategorize`가 됐고, 새로 만든 화면이 통째로 404였다.
 * 타입체크·단위테스트·빌드가 전부 통과했다 — 경로는 문자열이라 아무도 검증하지 않는다.
 * 그래서 소스에서 직접 읽어 고정한다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// `import.meta.url` 금지(TS1470) — 이 패키지 tsconfig는 CJS로 타입체크한다.
const SRC = resolve(process.cwd(), 'src');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...controllerFiles(full));
    } else if (entry.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('라우트 prefix 규약', () => {
  const files = controllerFiles(SRC);

  it('컨트롤러 파일을 찾는다', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('@Controller 경로가 v1으로 시작하지 않는다', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/@Controller\(\s*'([^']*)'/g)) {
        const path = match[1];
        if (/^v\d+(\/|$)/.test(path)) {
          offenders.push(`${file.replace(SRC, 'src')}: '${path}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('main.ts가 글로벌 prefix를 v1으로 설정한다', () => {
    // 이 단언이 깨지면 위 규칙의 근거가 사라진다 — 함께 봐야 의미가 있다.
    const main = readFileSync(resolve(SRC, 'main.ts'), 'utf8');
    expect(main).toContain("setGlobalPrefix('v1')");
  });
});
