/**
 * 아키텍처 규약 리포트 — ADR-0027 §1 "`card_transactions` 생성과 보호 컬럼 갱신이 이
 * 패키지 밖에 남으면 실패해야 한다."
 *
 * ⚠️ **이번 라운드는 실패시키지 않는다.** 롤아웃 3단계라 기존 경로가 여전히 직접
 * 쓰기 때문이다. 지금 실패시키면 워크스페이스 테스트가 상시 빨간불이 되어 진짜 회귀를
 * 그 속에서 찾게 된다. 필수화는 전환 8단계다.
 *
 * 대신 **위반 수를 출력**한다. 이 숫자가 enforce 준비도의 유일한 객관 지표다:
 * 줄지 않으면 전환할 수 없고, 늘었으면 새 진입점이 또 규약을 복사한 것이다.
 *
 * 상한(`MAX_KNOWN_VIOLATIONS`)만 걸어 둔다 — 리포트가 조용히 늘어나는 것은 막아야
 * 하지만, 줄어드는 것은 언제든 환영이므로 하한은 두지 않는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanMoneyWriteViolations, type ScanTarget } from './architecture.js';

/**
 * 저장소 루트. vitest는 패키지 디렉터리를 cwd로 돌린다.
 * `__dirname`/`import.meta`를 쓰지 않는 이유: 이 파일은 CJS로 타입체크되고 ESM으로
 * 실행돼서 둘 중 어느 쪽도 양쪽에서 성립하지 않는다.
 */
const REPO_ROOT = resolve(process.cwd(), '..', '..');

const SCAN_ROOTS = ['apps/api/src', 'apps/worker/src', 'packages'] as const;

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.turbo',
  '.next',
  'drizzle',
  // 금액 계약의 본거지. 여기 쓰기가 남는 것이 정상이다.
  'transaction-domain',
]);

/**
 * 2026-08-08 기준 위반 수(12건: 승격 4 · 거래 수정/연결 6 · 수동 입력 1 · 사람 검토 1).
 * 롤아웃 5단계에서 각 경로를 새 서비스로 옮길 때마다 줄어든다. 늘어나면 새 진입점이
 * 계약을 우회한 것이므로 여기서 걸린다 — 하한은 두지 않는다.
 */
const MAX_KNOWN_VIOLATIONS = 12;

function collect(dir: string, out: ScanTarget[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      collect(full, out);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
    out.push({ file: relative(REPO_ROOT, full), content: readFileSync(full, 'utf8') });
  }
}

describe('금액 쓰기 초크포인트 (report-only)', () => {
  it('패키지 밖 card_transactions 금액 쓰기 지점을 보고한다', () => {
    const targets: ScanTarget[] = [];
    for (const root of SCAN_ROOTS) {
      collect(join(REPO_ROOT, root), targets);
    }
    expect(targets.length).toBeGreaterThan(0);

    const violations = scanMoneyWriteViolations(targets);
    const byFile = new Map<string, number>();
    for (const violation of violations) {
      byFile.set(violation.file, (byFile.get(violation.file) ?? 0) + 1);
    }

    const lines = [
      '',
      `[ADR-0027 §1] 금액 도메인 패키지 밖 card_transactions 쓰기: ${violations.length}건`,
      ...[...byFile.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([file, count]) => `  ${count.toString().padStart(3)}  ${file}`),
      '',
      ...violations.map(
        (violation) =>
          `  ${violation.file}:${violation.line} [${violation.kind}] ${violation.columns.join(',')}`,
      ),
      '',
    ];
    // 리포트는 콘솔로만 낸다 — 이 테스트의 산출물은 단언이 아니라 이 숫자다.
    console.log(lines.join('\n'));

    expect(violations.length).toBeLessThanOrEqual(MAX_KNOWN_VIOLATIONS);
  });
});
