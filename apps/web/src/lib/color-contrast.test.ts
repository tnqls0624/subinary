/**
 * 상태색 토큰의 대비를 `globals.css`에서 직접 읽어 고정한다.
 *
 * 왜 CSS를 파싱하나: 값을 테스트에 복사해 두면 CSS만 바뀌었을 때 테스트가 통과하며
 * 거짓 안전을 준다. 대비 결함은 눈에 잘 띄지 않아 그렇게 조용히 되돌아온다 —
 * 실제로 `--warning`은 라이트에서 2.20:1(AA 미달)로 오래 있었고, 아무도 못 봤다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(process.cwd(), 'src/app/globals.css'),
  'utf8',
);

/**
 * `:root { … }`(라이트)와 `.dark { … }`(다크) 블록을 각각 떼어낸다.
 *
 * 셀렉터를 **줄 시작에 고정**해야 한다. 단순 문자열 검색을 쓰면 13행의
 * `@custom-variant dark (&:is(.dark *));`가 먼저 잡히고, 그 뒤의 첫 `{`가
 * `:root`의 것이라 **다크 테스트가 라이트 값을 검사한다** — 통과하는데 아무것도
 * 검증하지 않는 상태가 된다(실제로 그렇게 만들었다가 회귀 주입 실험에서 드러났다).
 */
function block(selector: string): string {
  const escaped = selector.replace(/[.:]/g, '\\$&');
  const open = new RegExp(`^${escaped}\\s*\\{`, 'm').exec(css);
  if (!open) throw new Error(`globals.css에 ${selector} 블록이 없다`);
  const from = open.index + open[0].length;
  const end = css.indexOf('\n}', from);
  if (end < 0) throw new Error(`${selector} 블록이 닫히지 않았다`);
  return css.slice(from, end);
}

function token(scope: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block(scope));
  if (!m) throw new Error(`${scope}에서 --${name}(6자리 hex)을 찾지 못했다`);
  return m[1]!.toLowerCase();
}

/** WCAG 2.x 상대 휘도. sRGB 감마를 역보정한 뒤 가중합한다. */
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_TEXT = 4.5;

describe('상태색 대비 (globals.css에서 직접 읽음)', () => {
  const modes = [
    { scope: ':root', bg: 'background', label: '라이트' },
    { scope: '.dark', bg: 'background', label: '다크' },
  ] as const;

  for (const { scope, bg, label } of modes) {
    for (const name of ['warning-strong', 'success-strong'] as const) {
      it(`${label}: --${name}는 배경 위에서 AA(${AA_TEXT}:1) 이상`, () => {
        const ratio = contrast(token(scope, name), token(scope, bg));
        // 실패 시 실제 비율이 메시지에 남아야 얼마나 모자란지 바로 안다.
        expect(
          ratio,
          `--${name} 대비 ${ratio.toFixed(2)}:1 (필요 ${AA_TEXT}:1)`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }

  it('표면색과 텍스트색은 별개 토큰이다', () => {
    // 라이트에서 둘이 같아지면 누군가 -strong을 표면색으로 되돌린 것이다.
    // 그 순간 본문 대비가 조용히 AA 아래로 내려간다.
    expect(token(':root', 'warning-strong')).not.toBe(token(':root', 'warning'));
    expect(token(':root', 'success-strong')).not.toBe(token(':root', 'success'));
  });
});
