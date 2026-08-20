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

describe('0050 — P0-9 멱등 키 출처 + 중복 원문 보관', () => {
  const sqlText = readFileSync(
    resolve(drizzleDir, '0050_card_sms_idempotency_provenance.sql'),
    'utf8',
  );
  const statements = sqlText
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('추가형이다 — 기존 이벤트를 바꾸거나 지우지 않는다', () => {
    // 되돌리기 절차(DROP ...)는 주석이므로 실행문만 본다.
    assert.ok(!/\bDROP\b/i.test(statements), 'DROP 구문이 있다');
    assert.ok(!/\bDELETE\s+FROM\b/i.test(statements), 'DELETE 구문이 있다');
    assert.ok(!/\bTRUNCATE\b/i.test(statements), 'TRUNCATE 구문이 있다');
    assert.ok(
      !/\bUPDATE\s+"?card_sms_events/i.test(statements),
      '기존 카드 문자 이벤트를 갱신한다 — 0050은 보이는 값을 바꾸면 안 된다',
    );
  });

  it('key_source는 기본값 없이 붙는다 (적용 이전 행은 NULL로 남아야 한다)', () => {
    assert.match(statements, /ADD COLUMN "key_source" text;/);
    assert.ok(
      !/ADD COLUMN "key_source" text DEFAULT/i.test(statements),
      '기본값이 있다 — 없는 정보를 있는 것처럼 세게 되고 필수화 판단이 틀린다',
    );
  });

  it('key_source 값 집합을 DB가 강제한다 (NULL 허용)', () => {
    assert.match(
      statements,
      /"card_sms_events_key_source_check" CHECK[\s\S]*?"key_source" is null or "card_sms_events"\."key_source" in \('client', 'derived_received_at', 'derived_window'\)/,
    );
  });

  it('창 기반 중복 조회 인덱스는 (장치, 지문, 수신시각) 순서다', () => {
    // 마지막만 범위 조건이다. 순서가 바뀌면 등치 조건이 인덱스를 못 탄다.
    assert.match(
      statements,
      /CREATE INDEX "card_sms_events_device_id_content_hash_received_at_idx" ON "card_sms_events" USING btree \("device_id","content_hash","received_at"\)/,
    );
  });

  it('보관 테이블은 원문과 판정 근거를 함께 남긴다', () => {
    assert.match(statements, /CREATE TABLE "card_sms_ingest_suppressions"/);
    for (const column of [
      '"raw_content" text NOT NULL',
      '"content_hash" text NOT NULL',
      '"key_source" text NOT NULL',
      '"reason" text NOT NULL',
      '"attempts" integer DEFAULT 1 NOT NULL',
      '"restored_event_id" uuid',
    ]) {
      assert.ok(statements.includes(column), `${column} 컬럼이 없다`);
    }
  });

  it('같은 시도의 반복은 행이 아니라 attempts로 접힌다', () => {
    assert.match(
      statements,
      /"card_sms_ingest_suppressions_device_event_content_unique" UNIQUE\("device_id","event_id","content_hash"\)/,
    );
  });

  it('보관 행은 이벤트에 FK를 걸지 않는다 (감사 기록이 더 오래 살아야 한다)', () => {
    // FK가 있으면 이벤트 삭제가 막히거나(NO ACTION) 보관이 함께 지워진다(CASCADE).
    assert.ok(
      !/FOREIGN KEY \("(matched|restored)_event_id"\)/.test(statements),
      '이벤트 id에 FK가 있다 — 버려진 원문이 이벤트와 함께 사라진다',
    );
    // 스코프 컬럼은 반대로 FK를 둔다.
    assert.match(statements, /FOREIGN KEY \("household_id"\)/);
    assert.match(statements, /FOREIGN KEY \("device_id"\)/);
  });

  it('제약 이름이 PostgreSQL 식별자 한계(63바이트)를 넘지 않는다', () => {
    // 넘으면 PG가 조용히 잘라 저장해 이후 generate가 같은 제약을 또 만들려 든다.
    for (const [, name] of statements.matchAll(/CONSTRAINT "([^"]+)"/g)) {
      assert.ok(
        Buffer.byteLength(name, 'utf8') <= 63,
        `${name} (${Buffer.byteLength(name, 'utf8')}바이트)`,
      );
    }
    for (const [, name] of statements.matchAll(/CREATE INDEX "([^"]+)"/g)) {
      assert.ok(
        Buffer.byteLength(name, 'utf8') <= 63,
        `${name} (${Buffer.byteLength(name, 'utf8')}바이트)`,
      );
    }
  });
});

describe('0050 — 스키마 선언과 마이그레이션의 일치', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');
  const sqlText = readFileSync(
    resolve(drizzleDir, '0050_card_sms_idempotency_provenance.sql'),
    'utf8',
  );

  it('새 테이블·컬럼이 schema.ts에도 선언돼 있다', () => {
    for (const declaration of [
      'export const cardSmsIngestSuppressions = pgTable(',
      "'card_sms_ingest_suppressions',",
      "text('key_source')",
      "uuid('matched_event_id')",
      "uuid('restored_event_id')",
    ]) {
      assert.ok(
        schemaText.includes(declaration),
        `schema.ts에 ${declaration} 선언이 없다 — Drizzle 조회가 새 컬럼을 못 본다`,
      );
    }
  });

  it('제약·인덱스 이름이 양쪽에 같다', () => {
    for (const name of [
      'card_sms_events_key_source_check',
      'card_sms_events_device_id_content_hash_received_at_idx',
      'card_sms_ingest_suppressions_device_event_content_unique',
      'card_sms_ingest_suppressions_reason_check',
      'card_sms_ingest_suppressions_key_source_check',
      'card_sms_ingest_suppressions_attempts_check',
      'card_sms_ingest_suppressions_household_id_last_seen_at_idx',
      'card_sms_ingest_suppressions_device_id_content_hash_idx',
    ]) {
      assert.ok(schemaText.includes(`'${name}'`), `schema.ts에 ${name}이 없다`);
      assert.ok(sqlText.includes(`"${name}"`), `0050에 ${name}이 없다`);
    }
  });

  it('키 출처 값 집합이 코드·스키마·마이그레이션 셋 다 같다', () => {
    // 세 곳 중 하나만 늘면 정상 값이 DB에서 거부되거나 오타가 통과한다.
    const idempotencyText = readFileSync(
      resolve(here, '../src/card-sms-idempotency.ts'),
      'utf8',
    );
    for (const value of ['client', 'derived_received_at', 'derived_window']) {
      assert.ok(idempotencyText.includes(`'${value}'`), `코드에 ${value}가 없다`);
      assert.ok(schemaText.includes(`'${value}'`), `schema.ts에 ${value}가 없다`);
      assert.ok(sqlText.includes(`'${value}'`), `0050에 ${value}가 없다`);
    }
  });
});

describe('스키마 선언과 마이그레이션의 인덱스 이름이 같다', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');

  for (const name of [
    'device_credentials_device_active_unique',
    'budgets_household_month_scope_unique',
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

describe('0051 — 동의 철회(버전된 동의 + 상태 전이)', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');
  const sqlText = readFileSync(
    resolve(drizzleDir, '0051_household_consent_revocation.sql'),
    'utf8',
  );

  it('철회를 표현할 컬럼을 추가한다', () => {
    for (const fragment of [
      'ADD COLUMN "status" text DEFAULT \'granted\' NOT NULL',
      'ADD COLUMN "revoked_at" timestamp with time zone',
      'ADD COLUMN "revoked_reason" text',
    ]) {
      assert.ok(sqlText.includes(fragment), `0051에 ${fragment}이 없다`);
    }
  });

  it('기존 행을 지우지 않는다 (가산적 마이그레이션)', () => {
    // 동의 이력은 증빙이다. DELETE가 한 줄이라도 들어가면 "언제 동의했는가"를 잃는다.
    assert.ok(!/\bDELETE\s+FROM\b/i.test(sqlText));
    assert.ok(!/\bDROP\s+(TABLE|COLUMN)\b/i.test(sqlText));
  });

  it('CHECK 제약이 schema.ts와 마이그레이션 양쪽에 같은 이름으로 있다', () => {
    for (const name of [
      'household_consents_status_check',
      'household_consents_revoked_at_check',
      'household_consents_scope_idx',
    ]) {
      assert.ok(schemaText.includes(`'${name}'`), `schema.ts에 ${name}이 없다`);
      assert.ok(sqlText.includes(`"${name}"`), `0051에 ${name}이 없다`);
    }
  });

  it('status와 revoked_at의 정합을 DB가 강제한다', () => {
    // "철회했다는데 언제인지 모르는 행"은 개인정보 동의에서 증빙이 되지 못한다.
    assert.match(
      sqlText,
      /CHECK \(\("status" = 'revoked'\) = \("revoked_at" is not null\)\)/,
    );
  });

  it('원문을 추적할 수 없는 동의 버전이 있으면 추측하지 않고 멈춘다', () => {
    // 0048과 같은 태도. 코드에 문구가 없는 버전은 "무엇에 동의했는가"를 답할 수 없다.
    assert.match(sqlText, /RAISE EXCEPTION/);
    assert.match(sqlText, /consent_version NOT IN \('v1', 'v2'\)/);
  });

  it('적용 전 재고 조사 쿼리를 주석에 남긴다 (0047·0048 관습)', () => {
    assert.match(sqlText, /SELECT consent_type, consent_version, count\(\*\)/);
  });
});

describe('0052 — 예산 월 원장', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');
  const sqlText = readFileSync(
    resolve(drizzleDir, '0052_budget_month_ledger.sql'),
    'utf8',
  );
  const apiText = readFileSync(
    resolve(here, '../../../apps/api/src/budgets/budget.service.ts'),
    'utf8',
  );
  const controllerText = readFileSync(
    resolve(here, '../../../apps/api/src/budgets/budget.controller.ts'),
    'utf8',
  );
  const contractText = readFileSync(
    resolve(here, '../../contracts/src/budget.ts'),
    'utf8',
  );
  const workerText = readFileSync(
    resolve(
      here,
      '../../../apps/worker/src/promotion/transaction-promotion.service.ts',
    ),
    'utf8',
  );

  it('기존 행은 배포 순간의 서울 월초에만 귀속하고 과거월을 복제하지 않는다', () => {
    assert.match(sqlText, /ADD COLUMN "effective_month" date/);
    assert.match(
      sqlText,
      /date_trunc\('month', current_timestamp AT TIME ZONE 'Asia\/Seoul'\)::date/,
    );
    assert.match(sqlText, /ALTER COLUMN "effective_month" SET NOT NULL/);
    assert.equal(
      (sqlText.match(/UPDATE "budgets"/g) ?? []).length,
      1,
      '월초 귀속 외에 기존 계획을 복제·수정하는 UPDATE가 있다',
    );
    assert.ok(!/INSERT INTO "budgets"/i.test(sqlText));
  });

  it('예상 밖 scope 정합 오류는 조용히 보정하지 않고 멈춘다', () => {
    assert.match(sqlText, /RAISE EXCEPTION/);
    assert.match(
      sqlText,
      /\(scope_type = 'household'\) <> \(scope_ref_id IS NULL\)/,
    );
    assert.ok(!/\bDELETE\s+FROM\b/i.test(sqlText));
  });

  it('기존 단일 예산 유니크를 월별 유니크 두 종류로 교체한다', () => {
    assert.match(
      sqlText,
      /DROP CONSTRAINT "budgets_household_scope_type_scope_ref_id_unique"/,
    );
    assert.match(sqlText, /DROP INDEX "budgets_household_scope_unique"/);
    assert.match(
      sqlText,
      /UNIQUE\("household_id", "effective_month", "scope_type", "scope_ref_id"\)/,
    );
    assert.match(
      sqlText,
      /CREATE UNIQUE INDEX "budgets_household_month_scope_unique"[\s\S]*\("household_id", "effective_month"\)[\s\S]*WHERE "scope_type" = 'household'/,
    );
  });

  it('복사 멱등 원장은 가구·키당 하나이고 결과 budget ID를 보존한다', () => {
    assert.match(sqlText, /CREATE TABLE "budget_copy_operations"/);
    assert.match(sqlText, /"copied_budget_ids" jsonb NOT NULL/);
    assert.match(
      sqlText,
      /"budget_copy_ops_household_idempotency_unique"[\s\S]*UNIQUE\("household_id", "idempotency_key"\)/,
    );
  });

  it('복사 멱등 키는 본문이 아닌 HTTP Idempotency-Key 헤더 계약이다', () => {
    assert.match(controllerText, /@Headers\('idempotency-key'\)/);
    assert.match(controllerText, /Idempotency-Key header must be a valid UUID/);
    assert.ok(
      !/budgetCopyRequestSchema[\s\S]*?idempotencyKey[\s\S]*?\}\);/.test(
        contractText,
      ),
      '복사 본문에 멱등 키가 중복 정의됐다',
    );
  });

  it('Drizzle 선언과 마이그레이션의 월 컬럼·인덱스 이름이 같다', () => {
    for (const fragment of [
      "date('effective_month', { mode: 'string' })",
      "'budgets_household_month_scope_ref_unique'",
      "'budgets_household_month_scope_unique'",
      "'budgets_household_effective_month_idx'",
      'export const budgetCopyOperations = pgTable(',
    ]) {
      assert.ok(
        schemaText.includes(fragment),
        `schema.ts에 ${fragment}가 없다`,
      );
    }
    for (const name of [
      'budgets_household_month_scope_ref_unique',
      'budgets_household_month_scope_unique',
      'budgets_household_effective_month_idx',
      'budget_copy_ops_household_idempotency_unique',
    ]) {
      assert.ok(sqlText.includes(`"${name}"`), `0052에 ${name}이 없다`);
    }
  });

  it('API 목록·중복 검사가 effective_month를 조건에 넣고 과거월 mutation을 막는다', () => {
    assert.match(
      apiText,
      /eq\(schema\.budgets\.effectiveMonth, period\.effectiveMonth\)/,
    );
    assert.match(
      apiText,
      /eq\(schema\.budgets\.effectiveMonth, effectiveMonth\)/,
    );
    assert.match(apiText, /past month budgets are read-only/);
  });

  it('예산 알림은 현재 서울월 계획만 조회하고 그 월을 alert_state에 기록한다', () => {
    assert.match(
      workerText,
      /eq\(schema\.budgets\.effectiveMonth, effectiveMonth\)/,
    );
    assert.match(workerText, /periodMonth: budgetPeriodMonth/);
  });
});

describe('0054 — Slack import 상태', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');
  const sqlText = readFileSync(
    resolve(drizzleDir, '0054_slack_import_status.sql'),
    'utf8',
  );
  const apiText = readFileSync(
    resolve(here, '../../../apps/api/src/slack/slack.service.ts'),
    'utf8',
  );
  const workerText = readFileSync(
    resolve(
      here,
      '../../../apps/worker/src/processors/slack-import.processor.ts',
    ),
    'utf8',
  );

  it('가산적이다 — 기존 테이블을 바꾸거나 지우지 않는다', () => {
    // 이 마이그레이션이 기존 데이터를 만지면 롤백이 "테이블 드롭"으로 끝나지 않는다.
    assert.ok(
      !/ALTER TABLE "(?!slack_imports")/.test(sqlText),
      'slack_imports 이외의 테이블을 ALTER 한다',
    );
    // 문장 **시작** 위치만 본다 — FK 절의 `ON UPDATE no action`은 파괴적 구문이 아니다.
    for (const forbidden of ['DROP TABLE', 'DROP COLUMN', 'DELETE FROM', 'UPDATE']) {
      assert.ok(
        !new RegExp(`^\\s*${forbidden}\\b`, 'im').test(sqlText),
        `0054에 파괴적 구문이 있다: ${forbidden}`,
      );
    }
  });

  it('상태 어휘 4개와 형식 어휘 2개를 만든다', () => {
    assert.match(
      sqlText,
      /CREATE TYPE "public"\."slack_import_status"[\s\S]*?'queued',[\s\S]*?'processing',[\s\S]*?'completed',[\s\S]*?'failed'/,
    );
    // 기존 단일 JSON 업로드 경로를 깨뜨리지 않는다는 계약이 어휘에 남아 있어야 한다.
    assert.match(
      sqlText,
      /CREATE TYPE "public"\."slack_import_format" AS ENUM \('json', 'zip'\)/,
    );
  });

  it('importId(source_item_id)가 신원이고 유일하다 — 재시도가 행을 늘리지 않는다', () => {
    assert.match(
      sqlText,
      /"slack_imports_source_item_id_unique" UNIQUE\("source_item_id"\)/,
    );
    assert.ok(
      schemaText.includes("unique('slack_imports_source_item_id_unique')"),
      'schema.ts에 유니크 선언이 없다',
    );
  });

  it('자유 텍스트 오류 컬럼을 만들지 않는다 (원문·PII 유출 경로 차단)', () => {
    // error_code만 있고 error_message/detail 류가 없어야 한다. 이 값은 그대로
    // 사용자 화면까지 가므로 자유 텍스트 자리를 애초에 두지 않는다.
    assert.ok(sqlText.includes('"error_code" text'), 'error_code가 없다');
    for (const forbidden of ['error_message', 'error_detail', 'raw_error']) {
      assert.ok(!sqlText.includes(forbidden), `${forbidden} 컬럼이 있다`);
    }
  });

  it('건수 컬럼은 nullable이다 — "모른다"와 "0건"은 다른 사실이다', () => {
    for (const column of [
      'channel_count',
      'user_count',
      'message_count',
      'warning_count',
    ]) {
      assert.match(
        sqlText,
        new RegExp(`"${column}" integer,`),
        `${column}이 NOT NULL이거나 기본값을 갖는다`,
      );
    }
  });

  it('Drizzle 선언과 마이그레이션의 인덱스 이름이 같다', () => {
    for (const name of [
      'slack_imports_workspace_queued_at_idx',
      'slack_imports_status_queued_at_idx',
    ]) {
      assert.ok(sqlText.includes(`"${name}"`), `0054에 ${name}이 없다`);
      assert.ok(schemaText.includes(`'${name}'`), `schema.ts에 ${name}이 없다`);
    }
    assert.ok(
      schemaText.includes('export const slackImports = pgTable('),
      'schema.ts에 slackImports 선언이 없다',
    );
  });

  it('API가 수락 시 queued 행을 만들고 owner 경계로 조회한다', () => {
    assert.match(apiText, /schema\.slackImports/);
    assert.match(apiText, /requireOwnedSlackWorkspace/);
  });

  it('워커가 processing/completed/failed를 모두 기록한다', () => {
    for (const status of ["'processing'", "'completed'", "'failed'"]) {
      assert.ok(
        workerText.includes(status),
        `워커가 ${status} 상태를 기록하지 않는다`,
      );
    }
    // 잡이 사라져도 상태가 남아야 하므로 DB에 쓴다.
    assert.match(workerText, /schema\.slackImports/);
  });
});

describe('0055 — 카테고리 소급 재분류 되돌리기 원장', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');
  const sqlText = readFileSync(
    resolve(drizzleDir, '0055_category_recategorize.sql'),
    'utf8',
  );
  /**
   * 주석을 걷어낸 본문.
   *
   * 이 마이그레이션은 "왜 그렇게 하지 않았는가"를 주석에 길게 적는다 — 배치에
   * `from_category_id`를 두지 않는 이유가 그 예다. 주석까지 함께 검사하면 **설명 문구가
   * 위반으로 잡힌다**(실제로 그렇게 오탐했다).
   */
  const sqlBody = sqlText.replace(/^[ \t]*--.*$/gm, '');
  /**
   * 컬럼 정의만 담은 DDL 블록. nullable 여부는 여기서만 판정한다 — CHECK 제약 본문에
   * 나오는 `"reverted_at" IS NOT NULL`은 컬럼 제약이 아니라 **완전성 검사식**이므로,
   * 파일 전체를 훑으면 그것을 NOT NULL 선언으로 오독한다.
   */
  const ddlOf = (table) => {
    const match = sqlBody.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"\\s*\\(([\\s\\S]*?)\\n\\);`),
    );
    assert.ok(match, `${table} DDL을 찾지 못했다`);
    return match[1];
  };

  it('가산적이다 — 기존 테이블을 바꾸거나 지우지 않는다', () => {
    // 이 마이그레이션이 기존 데이터를 만지면 롤백이 "테이블 드롭"으로 끝나지 않는다.
    assert.ok(
      !/ALTER TABLE "(?!category_recategorize_(batches|items)")/.test(sqlText),
      '새 테이블 이외의 테이블을 ALTER 한다',
    );
    // 문장 **시작** 위치만 본다 — FK 절의 `ON UPDATE no action`은 파괴적 구문이 아니다.
    for (const forbidden of [
      'DROP TABLE',
      'DROP COLUMN',
      'DROP CONSTRAINT',
      'DELETE FROM',
      'TRUNCATE',
      'UPDATE',
    ]) {
      assert.ok(
        !new RegExp(`^\\s*${forbidden}\\b`, 'im').test(sqlText),
        `0055에 파괴적 구문이 있다: ${forbidden}`,
      );
    }
  });

  it('journal에 0055가 파일명과 같은 tag로 등록돼 있다', () => {
    // 손으로 쓴 마이그레이션은 drizzle-kit가 journal을 대신 만들어 주지 않는다.
    // 여기서 놓치면 배포에서 **조용히 적용되지 않는다.**
    const entry = journal.entries.find(
      (e) => e.tag === '0055_category_recategorize',
    );
    assert.ok(entry, 'journal에 0055 항목이 없다');
    assert.equal(entry.idx, 55);
    assert.equal(entry.breakpoints, true, 'breakpoints가 false면 문장이 뭉친다');
  });

  it('문장 사이에 statement-breakpoint가 있다', () => {
    // breakpoint가 없으면 마이그레이터가 여러 DDL을 한 문장으로 보내 실패한다.
    const breakpoints = sqlText.match(/^--> statement-breakpoint$/gm) ?? [];
    assert.ok(
      breakpoints.length >= 10,
      `statement-breakpoint가 ${breakpoints.length}개뿐이다`,
    );
  });

  it('배치에 단일 from 카테고리 컬럼을 두지 않는다 (거래마다 이전 값이 다르다)', () => {
    // 대상 거래들의 현재 카테고리가 제각각(일부 NULL)이라 단일 from은 거짓 가정이고,
    // 그 값으로 되돌리면 원래 없던 분류를 만들어 낸다. 이전 값은 items에 행별로 남는다.
    for (const forbidden of ['from_category_id', 'fromCategoryId']) {
      assert.ok(
        !sqlBody.includes(forbidden),
        `0055에 단일 from 컬럼이 있다: ${forbidden}`,
      );
    }
    assert.match(
      sqlText,
      /CREATE TABLE IF NOT EXISTS "category_recategorize_items"[\s\S]*?"previous_category_id" uuid,/,
      'items의 previous_category_id가 없거나 NOT NULL이다',
    );
  });

  it('previous_category_id는 nullable이다 — 미분류였던 거래로 되돌려야 한다', () => {
    // "미분류였다"는 정상값이다. NOT NULL이면 되돌리기가 없던 카테고리를 만들어 낸다.
    assert.ok(
      !/"previous_category_id" uuid NOT NULL/i.test(sqlText),
      'previous_category_id가 NOT NULL이다',
    );
    assert.ok(
      schemaText.includes("previousCategoryId: uuid('previous_category_id')"),
      'schema.ts에 previousCategoryId 선언이 없다',
    );
    assert.ok(
      !/previousCategoryId: uuid\('previous_category_id'\)[\s\S]{0,120}?\.notNull\(\)/.test(
        schemaText,
      ),
      'schema.ts의 previousCategoryId가 notNull이다',
    );
  });

  it('되돌리기 3종은 nullable이고 셋이 함께 채워진다 (아직 안 됨 ≠ 0건)', () => {
    const batchesDdl = ddlOf('category_recategorize_batches');
    for (const column of ['reverted_at', 'reverted_by', 'reverted_count']) {
      assert.ok(
        !new RegExp(`"${column}"[^,\\n]*NOT NULL`, 'i').test(batchesDdl),
        `${column}이 NOT NULL이다 — "아직 되돌리지 않음"을 표현할 수 없다`,
      );
    }
    // NULL 함정: `>= 0`만 쓰면 건수가 NULL일 때 CHECK가 통과해 반쪽 행이 들어온다.
    assert.match(
      sqlText,
      /"category_recategorize_batches_revert_completeness_check"[\s\S]*?"reverted_count" IS NOT NULL/,
    );
    assert.ok(
      schemaText.includes(
        "'category_recategorize_batches_revert_completeness_check'",
      ),
      'schema.ts에 되돌리기 정합 CHECK가 없다',
    );
  });

  it('자유 텍스트 PII 컬럼을 만들지 않는다', () => {
    // 감사 원장은 사용자 화면까지 간다. 원문·메모 자리를 애초에 두지 않는다.
    for (const forbidden of ['memo', 'note', 'raw_text', 'reason', 'comment']) {
      assert.ok(!sqlText.includes(`"${forbidden}"`), `${forbidden} 컬럼이 있다`);
    }
  });

  it('한 배치에서 한 거래는 한 번만 기록된다 (복합 PK)', () => {
    // 중복 행이 생기면 되돌릴 값이 둘이 되어 어느 쪽으로 되돌리는지가 비결정적이 된다.
    assert.match(
      sqlText,
      /"category_recategorize_items_batch_id_transaction_id_pk"[\s\S]*?PRIMARY KEY\("batch_id","transaction_id"\)/,
    );
    assert.ok(
      schemaText.includes(
        "name: 'category_recategorize_items_batch_id_transaction_id_pk'",
      ),
      'schema.ts의 복합 PK 이름이 SQL과 다르다',
    );
  });

  it('식별자 이름이 Postgres 한도(63바이트) 안이다', () => {
    // 넘으면 PG가 **조용히 잘라** 문서상의 이름과 실제 이름이 어긋난다.
    const names = sqlText.match(/"category_recategorize_[a-z0-9_]+"/g) ?? [];
    assert.ok(names.length > 0, '이름을 하나도 찾지 못했다');
    for (const quoted of new Set(names)) {
      const name = quoted.slice(1, -1);
      assert.ok(
        Buffer.byteLength(name, 'utf8') <= 63,
        `${name}이 63바이트를 넘는다 (${name.length})`,
      );
    }
  });

  it('Drizzle 선언과 마이그레이션의 테이블·인덱스·제약 이름이 같다', () => {
    for (const name of [
      'category_recategorize_batches_household_applied_at_idx',
      'category_recategorize_items_transaction_id_idx',
      'category_recategorize_batches_applied_count_check',
      'category_recategorize_batches_revert_completeness_check',
      'category_recategorize_items_batch_id_transaction_id_pk',
    ]) {
      assert.ok(sqlText.includes(`"${name}"`), `0055에 ${name}이 없다`);
      assert.ok(schemaText.includes(`'${name}'`), `schema.ts에 ${name}이 없다`);
    }
    for (const fragment of [
      "export const categoryRecategorizeBatches = pgTable(\n  'category_recategorize_batches',",
      "export const categoryRecategorizeItems = pgTable(\n  'category_recategorize_items',",
    ]) {
      assert.ok(schemaText.includes(fragment), `schema.ts에 ${fragment}가 없다`);
    }
  });
});

describe('0056 — 공용(공동사용) 카드 표시', () => {
  const schemaText = readFileSync(resolve(here, '../src/schema.ts'), 'utf8');
  const sqlText = readFileSync(resolve(drizzleDir, '0056_shared_card.sql'), 'utf8');
  const sqlBody = sqlText.replace(/^[ \t]*--.*$/gm, '');

  it('가산적이다 — 기존 컬럼을 지우거나 데이터를 고치지 않는다', () => {
    for (const forbidden of ['DROP TABLE', 'DROP COLUMN', 'DELETE FROM', 'TRUNCATE', 'UPDATE']) {
      assert.ok(
        !new RegExp(`^\\s*${forbidden}\\b`, 'im').test(sqlBody),
        `파괴적 구문이 있다: ${forbidden}`,
      );
    }
  });

  it('is_shared는 NOT NULL DEFAULT false다', () => {
    // 기존 카드는 전부 공용이 아니다 — 사용자가 켜기 전까지 동작이 바뀌면 안 된다.
    assert.match(
      sqlBody,
      /ADD COLUMN IF NOT EXISTS "is_shared" boolean DEFAULT false NOT NULL/i,
      'is_shared 컬럼 정의가 기대와 다르다',
    );
    assert.ok(
      schemaText.includes("isShared: boolean('is_shared').notNull().default(false)"),
      'schema.ts의 isShared 선언이 없거나 다르다',
    );
  });

  it('거래 테이블을 건드리지 않는다', () => {
    // 이 기능의 소급은 집계가 조인 시점에 플래그를 읽어서 성립한다. 거래를 UPDATE하면
    // 되돌리기가 플래그를 끄는 것으로 끝나지 않게 된다.
    assert.ok(
      !/card_transactions/i.test(sqlBody),
      '0056이 card_transactions를 참조한다',
    );
  });

  it('집계가 쓰는 인덱스를 만든다', () => {
    assert.match(sqlBody, /CREATE INDEX IF NOT EXISTS "payment_cards_household_shared_idx"/);
  });

  it('집계 서비스가 이 컬럼을 읽는다', () => {
    // 컬럼만 만들고 아무도 읽지 않으면 사용자가 토글을 켜도 숫자가 그대로다.
    const analytics = readFileSync(
      resolve(here, '../../../apps/api/src/analytics/analytics.service.ts'),
      'utf8',
    );
    assert.ok(analytics.includes('paymentCards.isShared'), '집계가 isShared를 읽지 않는다');
  });
});
