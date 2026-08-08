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

describe('0049 — ADR-0027 금액 계약 스키마', () => {
  const sqlText = readFileSync(
    resolve(drizzleDir, '0049_transaction_money_contract.sql'),
    'utf8',
  );

  it('추가형이다 — DROP/DELETE/TRUNCATE로 기존 것을 없애지 않는다', () => {
    // 주석에 적어 둔 되돌리기 절차(DROP ...)는 실행문이 아니므로 주석 줄을 걷어내고 본다.
    const statements = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    assert.ok(!/\bDROP\b/i.test(statements), 'DROP 구문이 있다');
    assert.ok(!/\bDELETE\s+FROM\b/i.test(statements), 'DELETE 구문이 있다');
    assert.ok(!/\bTRUNCATE\b/i.test(statements), 'TRUNCATE 구문이 있다');
    assert.ok(
      !/\bUPDATE\s+"?card_transactions/i.test(statements),
      '기존 거래 행을 갱신한다 — 0049는 사용자에게 보이는 값을 바꾸면 안 된다',
    );
  });

  it('환율 스냅샷은 (통화, 기준일, 계약 버전)으로 하나만 고정된다', () => {
    assert.match(sqlText, /CREATE TABLE "fx_rate_snapshots"/);
    assert.match(
      sqlText,
      /"fx_rate_snapshots_natural_key_unique" UNIQUE\("base_currency","quote_currency","as_of_date","money_contract_version"\)/,
    );
    // 부동소수 환율은 같은 입력이 환경에 따라 1원 차이를 낸다.
    assert.match(sqlText, /"rate" numeric\(24, 12\) NOT NULL/);
    // 기준일은 "서울의 그 날"이지 순간이 아니다.
    assert.match(sqlText, /"as_of_date" date NOT NULL/);
  });

  it('환율 스냅샷은 UPDATE/DELETE를 DB가 거부한다', () => {
    assert.match(
      sqlText,
      /CREATE TRIGGER "fx_rate_snapshots_immutable"[\s\S]*BEFORE UPDATE OR DELETE ON "fx_rate_snapshots"/,
    );
  });

  it('마이그레이션 안에서 외부 환율을 가져오지 않는다', () => {
    // ADR-0027이 명시적으로 금지한다 — 네트워크에 의존하면 재현도 롤백도 불가능해진다.
    assert.ok(!/\bhttps?:\/\//i.test(sqlText.replace(/^--.*$/gm, '')));
    assert.ok(!/\bCOPY\b|\bdblink\b|\bhttp_get\b/i.test(sqlText));
  });

  it('card_transactions에 새 컬럼 3개를 붙이고 계약 버전 기본값은 v1이다', () => {
    assert.match(
      sqlText,
      /ADD COLUMN "original_cancelled_amount" integer;/,
    );
    assert.match(sqlText, /ADD COLUMN "fx_rate_snapshot_id" uuid;/);
    // 기본값이 v1이라야 기존 행과 롤백 창의 이전 바이너리가 만든 행이 그대로 남는다.
    assert.match(
      sqlText,
      /ADD COLUMN "money_contract_version" integer DEFAULT 1 NOT NULL;/,
    );
  });

  it('v2 불변식 6종은 전부 NOT VALID다', () => {
    const v2Checks = [
      'card_transactions_v2_currency_krw_check',
      'card_transactions_v2_original_pair_check',
      'card_transactions_v2_fx_snapshot_check',
      'card_transactions_v2_original_cancelled_check',
      'card_transactions_v2_approval_sum_check',
      'card_transactions_v2_cancellation_net_zero_check',
    ];
    for (const name of v2Checks) {
      // 헤더 주석의 되돌리기 절차에도 같은 이름이 나오므로 ADD CONSTRAINT 구문만 고른다.
      const statement = sqlText
        .split(/-->\s*statement-breakpoint/)
        .find((chunk) => chunk.includes(`ADD CONSTRAINT "${name}"`));
      assert.ok(statement, `${name} 정의가 없다`);
      // 지금 검증하면 이미 계약을 어기고 있는 v1 행 때문에 배포가 그 자리에서 멈춘다.
      assert.match(
        statement,
        /\)\s*NOT VALID;\s*$/,
        `${name} 이 NOT VALID가 아니다 — 배포가 막힌다`,
      );
      // v1 행은 v2 계약의 적용 대상이 아니다. 가드가 없으면 롤백 창에서 v1 쓰기가 막힌다.
      assert.match(
        statement,
        /"money_contract_version" < 2 or/,
        `${name} 에 v1 가드가 없다`,
      );
    }
  });

  it('수리 로그는 대상 거래에 FK를 걸지 않는다 (감사 로그가 더 오래 살아야 한다)', () => {
    assert.match(sqlText, /CREATE TABLE "transaction_money_repair_log"/);
    assert.ok(
      !/transaction_money_repair_log"? ADD CONSTRAINT [^;]*FOREIGN KEY \("transaction_id"\)/.test(
        sqlText,
      ),
      'transaction_id에 FK가 있다 — D-4 행 제거가 막히거나 로그가 함께 지워진다',
    );
    // 되돌림 판정에 필요한 두 시점의 체크섬과 제거 복원 이미지.
    for (const column of [
      '"checksum_before"',
      '"checksum_after"',
      '"restore_image"',
      '"net_amount_delta"',
    ]) {
      assert.ok(sqlText.includes(column), `${column} 컬럼이 없다`);
    }
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

describe('0049 — 스키마 선언과 마이그레이션의 일치', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');
  const sqlText = readFileSync(
    resolve(drizzleDir, '0049_transaction_money_contract.sql'),
    'utf8',
  );

  it('새 테이블·컬럼이 schema.ts에도 선언돼 있다', () => {
    for (const declaration of [
      'export const fxRateSnapshots = pgTable(',
      "'fx_rate_snapshots',",
      'export const transactionMoneyRepairLog = pgTable(',
      "'transaction_money_repair_log',",
      "integer('original_cancelled_amount')",
      "uuid('fx_rate_snapshot_id')",
      "integer('money_contract_version')",
    ]) {
      assert.ok(
        schemaText.includes(declaration),
        `schema.ts에 ${declaration} 선언이 없다 — Drizzle 조회가 새 컬럼을 못 본다`,
      );
    }
  });

  it('즉시 검증되는 CHECK는 양쪽에 같은 이름으로 있다', () => {
    for (const name of [
      'fx_rate_snapshots_natural_key_unique',
      'fx_rate_snapshots_quote_krw_check',
      'card_transactions_original_cancelled_amount_check',
      'card_transactions_money_contract_version_check',
      'transaction_money_repair_log_lifecycle_check',
    ]) {
      assert.ok(schemaText.includes(`'${name}'`), `schema.ts에 ${name}이 없다`);
      assert.ok(sqlText.includes(`"${name}"`), `0049에 ${name}이 없다`);
    }
  });

  it('v2 NOT VALID 제약은 schema.ts에 선언되지 않는다', () => {
    // Drizzle은 NOT VALID를 표현하지 못한다. 여기 선언하면 `drizzle-kit generate`가
    // 즉시 검증되는 형태로 다시 만들어 내고, 그 마이그레이션은 이미 계약을 어기고 있는
    // v1 행 때문에 배포 중에 실패한다. 정의는 0049에만, VALIDATE는 0050에서.
    assert.ok(
      !/check\(\s*'card_transactions_v2_/.test(schemaText),
      'schema.ts에 v2 제약이 선언돼 있다 — generate가 NOT VALID를 잃어버린다',
    );
    // 반대로 0049에는 6개가 전부 있어야 한다.
    const declared = sqlText.match(/"card_transactions_v2_[a-z_]+"/g) ?? [];
    assert.equal(new Set(declared).size, 6, 'v2 제약이 6개가 아니다');
  });
});
