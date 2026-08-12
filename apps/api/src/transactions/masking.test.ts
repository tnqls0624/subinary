/**
 * 응답 마스킹이 **모든 반환 경로에서** actor 기준으로 계산되는지 소스로 고정한다.
 *
 * 왜 소스를 읽나: 서비스 전체를 띄우지 않고도 "한 곳만 빠뜨렸다"를 잡을 수 있는
 * 유일한 방법이다. 실제로 변경 API 5곳(update·markDuplicate·markValid·exclude·
 * include)과 linkCancellation이 `masked`를 `false`로 고정하고 있었고, 그 때문에
 * owner가 타인의 `summary_only` 거래에 include/markValid를 호출하면 가려졌던
 * 가맹점명이 응답으로 드러났다. 읽기 경로(`get`)는 처음부터 맞았기 때문에
 * 화면만 봐서는 드러나지 않는 종류의 결함이다.
 *
 * `summary_only`는 가족 **다른 사람에게** 가맹점을 감추려고 있다. 한 경로라도
 * 새면 기능 자체가 의미를 잃는다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'src/transactions/transaction.service.ts'),
  'utf8',
);

describe('TransactionSummary 반환 마스킹', () => {
  it('masked 인자를 상수로 고정한 반환이 없다', () => {
    // `buildSummary(row, slug, false)` / `(…, true)` 형태를 전부 거부한다.
    // 마지막 인자 뒤 쉼표(prettier가 여러 줄 호출에 붙인다)를 허용해야 한다 —
    // 안 그러면 여러 줄로 쓴 상수 반환을 놓친다(실제로 처음에 놓쳤다).
    const hardcoded = source.match(
      /buildSummary\([^)]*?,\s*(?:true|false)\s*,?\s*\)/gs,
    );
    expect(
      hardcoded,
      `상수 masked로 반환하는 지점: ${JSON.stringify(hardcoded)}`,
    ).toBeNull();
  });

  it('모든 buildSummary 호출이 maskedFor로 masked를 계산한다', () => {
    const calls = source.match(/buildSummary\(/g) ?? [];
    const computed = source.match(/maskedFor\(/g) ?? [];
    // maskedFor는 buildSummary의 세 번째 인자로만 쓰인다(정의 1건 제외).
    // 호출 수가 어긋나면 어딘가 다른 방식으로 masked를 만들고 있다는 뜻이다.
    expect(computed.length).toBeGreaterThanOrEqual(calls.length);
  });

  it('maskedFor는 소유자 본인과 summary_only만 본다 (역할 예외 없음)', () => {
    // 역할을 보게 되는 순간 owner가 타인의 summary_only를 열 수 있게 되고,
    // 그건 이 기능이 막으려던 바로 그 상황이다.
    const def = /function maskedFor\([^)]*\)[^{]*\{([^}]*)\}/s.exec(source);
    expect(def, 'maskedFor 정의를 찾지 못했다').not.toBeNull();
    expect(def![1]).not.toMatch(/role|PRIVILEGED/i);
  });
});
