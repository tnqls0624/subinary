/**
 * 아키텍처 규약 스캐너 — "`card_transactions` 생성과 보호 컬럼 갱신이 이 패키지 밖에
 * 남아 있는가" (ADR-0027 §1).
 *
 * ADR은 이것을 **실패하는 테스트**로 두라고 했지만, 지금은 롤아웃 3단계라 기존 경로가
 * 여전히 직접 쓴다. 여기서 실패시키면 그 순간부터 워크스페이스 전체 테스트가 빨간불이
 * 되고, 진짜 회귀를 그 빨간불 속에서 찾게 된다. 그래서 이번 라운드는 **위반 목록을
 * 출력하는 형태**로 두고, 필수화는 롤아웃 8단계에서 한다.
 *
 * 대신 숫자를 남긴다. 위반 지점 수가 전환 진척의 유일한 객관 지표다 — 줄어들지 않으면
 * enforce 준비가 안 된 것이고, 늘어났으면 새 진입점이 또 규약을 복사한 것이다(D-2·D-3이
 * 정확히 그렇게 생겼다).
 *
 * 파일 입출력은 여기 없다. 순수 함수여야 앱 번들이 `node:fs`를 끌고 가지 않고,
 * 테스트가 스캔 대상 목록을 직접 통제할 수 있다.
 */
import { MONEY_PROTECTED_COLUMNS, MONEY_PROTECTED_DB_COLUMNS } from '@family/database';

export interface MoneyWriteViolation {
  readonly file: string;
  /** 1-base 줄 번호. */
  readonly line: number;
  readonly kind: 'insert' | 'update' | 'raw_sql';
  /**
   * 갱신이 건드리는 보호 컬럼. 삽입은 12개 전부로 본다. `.set(변수)`처럼 정적으로
   * 알 수 없으면 `['<dynamic>']` — **모른다는 것은 안전하다는 뜻이 아니므로** 위반으로
   * 센다. 실제로 그 경로가 금액을 쓰고 있다(`transaction.service.update`).
   */
  readonly columns: readonly string[];
  /** 해당 줄의 원문(앞뒤 공백 제거). 소스 코드이므로 PII가 없다. */
  readonly snippet: string;
}

/** 탐지 패턴. Drizzle 표현식과 원시 SQL을 모두 본다. */
export const MONEY_WRITE_PATTERNS = {
  insert: /\.insert\(\s*(?:schema\.)?cardTransactions\s*\)/g,
  update: /\.update\(\s*(?:schema\.)?cardTransactions\s*\)/g,
  rawInsert: /insert\s+into\s+"?card_transactions"?/gi,
  rawUpdate: /update\s+"?card_transactions"?\s+set/gi,
} as const;

/** 정적으로 컬럼을 알 수 없는 갱신 표식. */
export const DYNAMIC_COLUMNS = '<dynamic>';

export interface ScanTarget {
  readonly file: string;
  readonly content: string;
}

/**
 * 금액 보호 컬럼을 이 패키지 밖에서 쓰는 지점을 찾는다.
 *
 * `update`는 보호 컬럼을 실제로 건드릴 때만 위반으로 센다. `categoryId`·`memo`·
 * `excludedAt`처럼 금액과 무관한 수정은 ADR §1이 명시적으로 기존 서비스에 남긴
 * 것이므로, 전부 세면 지표가 "줄어들 수 없는 수"가 되어 쓸모가 없어진다.
 *
 * 판정 범위를 `.set(...)` **인자 안**으로 제한한다. 줄 수로 훑으면 바로 아래
 * `.returning({ amount: ... })`까지 걸려 갱신하지도 않는 컬럼이 목록에 올라온다.
 */
export function scanMoneyWriteViolations(
  targets: readonly ScanTarget[],
): MoneyWriteViolation[] {
  const violations: MoneyWriteViolation[] = [];

  for (const target of targets) {
    const { content, file } = target;

    for (const match of matchAll(content, MONEY_WRITE_PATTERNS.insert)) {
      // 삽입은 12개 컬럼을 전부 확정하므로 컬럼별 판정을 하지 않는다.
      violations.push(at(file, content, match, 'insert', [...MONEY_PROTECTED_COLUMNS]));
    }

    for (const match of matchAll(content, MONEY_WRITE_PATTERNS.update)) {
      const columns = updatedColumns(content, match);
      if (columns.length > 0) {
        violations.push(at(file, content, match, 'update', columns));
      }
    }

    for (const pattern of [MONEY_WRITE_PATTERNS.rawInsert, MONEY_WRITE_PATTERNS.rawUpdate]) {
      for (const match of matchAll(content, pattern)) {
        const region = content.slice(match, match + 2_000);
        violations.push(
          at(
            file,
            content,
            match,
            'raw_sql',
            MONEY_PROTECTED_DB_COLUMNS.filter((column) => region.includes(column)),
          ),
        );
      }
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** `.update(cardTransactions)` 뒤의 `.set(...)`이 건드리는 보호 컬럼. */
function updatedColumns(content: string, updateOffset: number): string[] {
  const setIndex = content.indexOf('.set(', updateOffset);
  if (setIndex < 0) return [];
  // 다음 `.update(` 이전에 있어야 같은 체인의 `.set`이다.
  const nextUpdate = content.indexOf('.update(', updateOffset + 1);
  if (nextUpdate >= 0 && setIndex > nextUpdate) return [];

  const argument = balanced(content, setIndex + '.set('.length - 1);
  if (argument === null) return [DYNAMIC_COLUMNS];

  const inner = argument.trim();
  // `.set(updates)`처럼 변수를 넘기면 무엇을 쓰는지 여기서 알 수 없다.
  if (!inner.startsWith('{')) return [DYNAMIC_COLUMNS];

  const found = MONEY_PROTECTED_COLUMNS.filter((column) =>
    // `amount: x`(명시)와 `{ status, netAmount }`(축약) 둘 다 잡는다. 축약을 놓치면
    // `markValid`처럼 순액을 다시 쓰는 경로가 통째로 리포트에서 사라진다.
    new RegExp(`(^|[{,\\s])${column}\\s*(:|,|\\}|$)`).test(inner),
  );
  // 스프레드(`...updates`)는 정적으로 알 수 없다.
  if (/\.\.\.[A-Za-z_$]/.test(inner)) {
    return found.length > 0 ? [...found, DYNAMIC_COLUMNS] : [DYNAMIC_COLUMNS];
  }
  return found;
}

/** `open` 위치의 여는 괄호에 대응하는 닫는 괄호까지의 내부 문자열. */
function balanced(content: string, open: number): string | null {
  if (content[open] !== '(') return null;
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    const char = content[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return content.slice(open + 1, index);
    }
  }
  return null;
}

function matchAll(content: string, pattern: RegExp): number[] {
  const offsets: number[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(content)) !== null) {
    offsets.push(match.index);
    if (match.index === scanner.lastIndex) scanner.lastIndex += 1;
  }
  return offsets;
}

function at(
  file: string,
  content: string,
  offset: number,
  kind: MoneyWriteViolation['kind'],
  columns: readonly string[],
): MoneyWriteViolation {
  const before = content.slice(0, offset);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = content.indexOf('\n', offset);
  return {
    file,
    line,
    kind,
    columns,
    snippet: content.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim(),
  };
}
