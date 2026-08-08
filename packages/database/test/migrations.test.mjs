/**
 * 마이그레이션 journal ↔ SQL 파일 ↔ 스키마 선언의 일치 검사.
 *
 * 왜 필요한가: 손으로 쓴 마이그레이션(0027·0028·0046·0047·0048)은 drizzle-kit가
 * journal 항목을 대신 만들어 주지 않는다. journal에 tag를 빠뜨리면 그 마이그레이션은
 * **조용히 적용되지 않고**, 오타가 나면 마이그레이터가 배포 중에 죽는다. 둘 다 배포
 * 시점에야 드러나므로 여기서 미리 막는다.
 *
 * 부분 유니크 인덱스는 이름이 스키마 선언과 SQL 양쪽에 각각 적혀 있어 한쪽만 바꾸면
 * 이후 `drizzle-kit generate`가 같은 인덱스를 또 만들려 든다. 이름 일치도 함께 본다.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(here, '../drizzle');
const journal = JSON.parse(
  readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8'),
);
const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql'));

describe('마이그레이션 journal', () => {
  it('journal의 모든 tag에 대응하는 .sql 파일이 있다', () => {
    for (const entry of journal.entries) {
      assert.ok(
        sqlFiles.includes(`${entry.tag}.sql`),
        `journal idx=${entry.idx} tag=${entry.tag} 에 해당하는 SQL 파일이 없다`,
      );
    }
  });

  it('모든 .sql 파일이 journal에 등록돼 있다 (등록 누락 = 조용한 미적용)', () => {
    const tags = new Set(journal.entries.map((e) => e.tag));
    for (const file of sqlFiles) {
      assert.ok(
        tags.has(file.replace(/\.sql$/, '')),
        `${file} 이 journal에 없다 — 적용되지 않는다`,
      );
    }
  });

  it('idx는 0부터 빈틈없이 증가하고 when도 단조 증가한다', () => {
    journal.entries.forEach((entry, i) => {
      assert.equal(entry.idx, i, `idx가 어긋난다: ${entry.tag}`);
      if (i > 0) {
        assert.ok(
          entry.when > journal.entries[i - 1].when,
          `when이 역행한다: ${entry.tag}`,
        );
      }
    });
  });
});

describe('0047 — 장치 자격 정리 + credential 부분 유니크', () => {
  const sqlText = readFileSync(
    resolve(drizzleDir, '0047_device_eligibility_and_credential_unique.sql'),
    'utf8',
  );

  it('제거된 구성원의 활성 장치를 폐기하고 collect token 해시를 지운다', () => {
    assert.match(sqlText, /UPDATE "registered_devices"/);
    assert.match(sqlText, /"collect_token_hash" = NULL/);
    assert.match(sqlText, /m\."status" <> 'active'/);
  });

  it('장치당 active credential 부분 유니크를 만든다', () => {
    assert.match(
      sqlText,
      /CREATE UNIQUE INDEX "device_credentials_device_active_unique"[\s\S]*WHERE "status" = 'active'/,
    );
  });

  it('되돌릴 수 없는 DELETE를 쓰지 않는다 (상태 전이만)', () => {
    assert.ok(!/\bDELETE\s+FROM\b/i.test(sqlText));
  });
});

describe('0048 — 가구 전체 예산 부분 유니크', () => {
  const sqlText = readFileSync(
    resolve(drizzleDir, '0048_budget_household_scope_unique.sql'),
    'utf8',
  );

  it('기존 중복은 조용히 지우지 않고 예외로 멈춘다', () => {
    assert.match(sqlText, /RAISE EXCEPTION/);
    assert.ok(!/\bDELETE\s+FROM\b/i.test(sqlText));
  });

  it('scope_type=household 에만 걸리는 부분 유니크를 만든다', () => {
    assert.match(
      sqlText,
      /CREATE UNIQUE INDEX "budgets_household_scope_unique"[\s\S]*WHERE "scope_type" = 'household'/,
    );
  });
});

describe('스키마 선언과 마이그레이션의 인덱스 이름이 같다', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');

  for (const name of [
    'device_credentials_device_active_unique',
    'budgets_household_scope_unique',
  ]) {
    it(name, () => {
      assert.ok(
        schemaText.includes(`uniqueIndex('${name}')`),
        `schema.ts에 ${name} 선언이 없다 — drizzle-kit generate가 인덱스를 다시 만들려 한다`,
      );
      assert.ok(
        sqlFiles.some((file) =>
          readFileSync(resolve(drizzleDir, file), 'utf8').includes(name),
        ),
        `마이그레이션에 ${name} 생성 구문이 없다`,
      );
    });
  }
});
