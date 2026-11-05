/**
 * 0074 알림 종류별 끄기 — 기존 행을 바꾸지 않는 추가 마이그레이션인지 고정한다.
 *
 * 지켜야 하는 것은 셋이다.
 *  1. 기존 행은 지금처럼 **모든 종류를 받는다**(빈 배열 기본값, UPDATE 없음).
 *  2. NULL 원소가 들어가지 못한다 — 발송 쪽 `includes(kind)`는 NULL을 끈 종류로 읽지 못한다.
 *  3. journal·Drizzle 선언이 SQL과 같은 이름을 쓴다(한쪽만 바꾸면 다음 generate가 또 만든다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const sql = readFileSync(
  new URL("../drizzle/0074_notification_disabled_kinds.sql", import.meta.url),
  "utf8"
);
const schema = readFileSync(
  new URL("../src/schema.ts", import.meta.url),
  "utf8"
);
const journal = JSON.parse(
  readFileSync(
    new URL("../drizzle/meta/_journal.json", import.meta.url),
    "utf8"
  )
);
const body = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("0074 알림 종류별 끄기", () => {
  it("journal에 파일명과 같은 tag로 idx 74에 등록돼 있다", () => {
    const entry = journal.entries.find((e) => e.idx === 74);
    assert.equal(entry?.tag, "0074_notification_disabled_kinds");
  });

  it("빈 배열 기본값의 NOT NULL 컬럼 하나만 더하고 기존 행을 건드리지 않는다", () => {
    assert.match(
      body,
      /ALTER TABLE notification_preferences ADD COLUMN disabled_kinds text\[\] NOT NULL DEFAULT '\{\}';/
    );
    for (const pattern of [
      /^\s*UPDATE\b/im,
      /^\s*DELETE\s+FROM\b/im,
      /\bDROP\b/i,
      /^\s*TRUNCATE\b/im,
      /^\s*INSERT\b/im,
    ]) {
      assert.doesNotMatch(body, pattern);
    }
  });

  it("CHECK는 NULL 원소를 막고 IS NOT NULL을 명시한다(NULL은 CHECK를 통과한다)", () => {
    assert.match(
      body,
      /CONSTRAINT notification_preferences_disabled_kinds_check CHECK \(/
    );
    assert.match(body, /disabled_kinds IS NOT NULL/);
    assert.match(body, /array_position\(disabled_kinds, NULL\) IS NULL/);
    assert.match(body, /cardinality\(disabled_kinds\) <= 32/);
  });

  it("Drizzle 스키마가 같은 컬럼·제약 이름을 선언한다", () => {
    assert.match(
      schema,
      /disabledKinds: text\('disabled_kinds'\)\s*\.array\(\)\s*\.notNull\(\)\s*\.default\(sql`'\{\}'::text\[\]`\)/
    );
    assert.ok(
      schema.includes("'notification_preferences_disabled_kinds_check'")
    );
  });
});
