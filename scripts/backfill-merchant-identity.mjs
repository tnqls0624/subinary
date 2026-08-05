/**
 * 가맹점 아이덴티티 백필 — `normalizeMerchant` 확장(괄호·법인격 제거)을 기존 데이터에
 * 반영한다. 기본은 **dry-run**이고 `--apply`를 줄 때만 쓴다.
 *
 * 왜 필요한가: 정규화 규칙이 바뀌면 새 거래는 새 키로 저장되는데 과거 거래와
 * `merchant_category_rules`는 옛 키에 남아, 같은 브랜드가 계속 쪼개져 보이고 옛 규칙은
 * 매칭되지 않는 죽은 행이 된다.
 *
 * 재실행 안전성:
 * - 원본 `merchant_raw`는 건드리지 않으므로 언제든 다시 계산할 수 있다.
 * - `merchant_aliases`(사용자가 확정한 병합)를 **존중**한다. 재계산 값이 별칭이면
 *   대표 이름으로 매핑하므로, 백필이 사용자의 병합 결정을 되돌리지 않는다.
 *
 * 규칙 병합 정책(우선순위): ① `human_confirmed`(사용자가 직접 확정) → ② 이미 목표
 * 패턴인 행 → ③ 가장 최근 `updated_at`. 같은 등급 안에서는 최근 것을 남기고 나머지를
 * 삭제한다.
 *
 * `human_confirmed`를 최우선에 두는 이유: 자동 학습(`model_prediction`)이 나중에
 * 생겼다는 이유로 사람의 확정을 덮으면 안 된다. 실제로 이 백필 직전 승격 복구가
 * `팀오투 -> 기타`(자동)를 만들었는데, 사용자는 7/30에 `주식회사팀오투 -> 여행`으로
 * 확정해 둔 상태였다 — 시각만 보면 자동 분류가 이긴다.
 *
 * 카테고리가 서로 다른 그룹은 경고로 출력한다 — 조용히 하나를 고르면 사용자가 확정한
 * 분류가 설명 없이 뒤집힌다.
 */
import { createRequire } from 'node:module';

import {
  createDbClient,
  schema,
} from '../packages/database/dist/index.mjs';
import { normalizeMerchant } from '../packages/shared/dist/index.mjs';

const require = createRequire(import.meta.url);
const { eq, inArray, isNotNull } = require('../packages/database/node_modules/drizzle-orm');

const APPLY = process.argv.includes('--apply');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, client } = createDbClient(databaseUrl, { max: 1 });
const tag = APPLY ? '[APPLY]' : '[DRY-RUN]';

try {
  // ── 0. 사용자가 확정한 별칭 로드 — 백필이 이 결정을 덮지 않게 한다. ──────────
  const aliases = await db
    .select({
      householdId: schema.merchantAliases.householdId,
      alias: schema.merchantAliases.alias,
      canonical: schema.merchantAliases.canonical,
    })
    .from(schema.merchantAliases);
  const aliasMap = new Map(
    aliases.map((a) => [`${a.householdId}:${a.alias}`, a.canonical]),
  );
  const resolve = (householdId, normalized) =>
    aliasMap.get(`${householdId}:${normalized}`) ?? normalized;
  console.log(`${tag} 별칭 ${aliases.length}개 로드`);

  // ── 1. 거래 merchant_normalized 재계산 ────────────────────────────────────
  const txns = await db
    .select({
      id: schema.cardTransactions.id,
      householdId: schema.cardTransactions.householdId,
      merchantRaw: schema.cardTransactions.merchantRaw,
      merchantNormalized: schema.cardTransactions.merchantNormalized,
    })
    .from(schema.cardTransactions)
    .where(isNotNull(schema.cardTransactions.merchantRaw));

  const txnUpdates = [];
  for (const t of txns) {
    const next = resolve(t.householdId, normalizeMerchant(t.merchantRaw));
    if (next && next !== t.merchantNormalized) {
      txnUpdates.push({ id: t.id, from: t.merchantNormalized, to: next });
    }
  }
  console.log(`\n${tag} 거래 ${txns.length}건 중 ${txnUpdates.length}건 변경 예정`);
  const byPair = new Map();
  for (const u of txnUpdates) {
    const key = `${u.from} -> ${u.to}`;
    byPair.set(key, (byPair.get(key) ?? 0) + 1);
  }
  for (const [pair, n] of [...byPair].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${pair}  (${n}건)`);
  }

  if (APPLY && txnUpdates.length > 0) {
    // to 값별로 묶어 UPDATE 횟수를 줄인다(건수가 적어 단순 루프로 충분).
    const byTarget = new Map();
    for (const u of txnUpdates) {
      const list = byTarget.get(u.to) ?? [];
      list.push(u.id);
      byTarget.set(u.to, list);
    }
    for (const [target, ids] of byTarget) {
      await db
        .update(schema.cardTransactions)
        .set({ merchantNormalized: target, updatedAt: new Date() })
        .where(inArray(schema.cardTransactions.id, ids));
    }
    console.log(`   ✅ 거래 ${txnUpdates.length}건 갱신`);
  }

  // ── 2. merchant_category_rules 패턴 재계산 + 중복 병합 ────────────────────
  const rules = await db
    .select({
      id: schema.merchantCategoryRules.id,
      householdId: schema.merchantCategoryRules.householdId,
      pattern: schema.merchantCategoryRules.merchantPattern,
      categoryId: schema.merchantCategoryRules.categoryId,
      source: schema.merchantCategoryRules.source,
      updatedAt: schema.merchantCategoryRules.updatedAt,
    })
    .from(schema.merchantCategoryRules);

  const groups = new Map();
  for (const r of rules) {
    const next = resolve(r.householdId, normalizeMerchant(r.pattern));
    const key = `${r.householdId}:${next}`;
    const g = groups.get(key) ?? { householdId: r.householdId, next, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }

  const ruleRenames = [];
  const ruleDeletes = [];
  const conflicts = [];
  for (const g of groups.values()) {
    if (g.rows.length === 1) {
      const only = g.rows[0];
      if (only.pattern !== g.next) ruleRenames.push({ id: only.id, from: only.pattern, to: g.next });
      continue;
    }
    const distinctCategories = new Set(g.rows.map((r) => r.categoryId));
    if (distinctCategories.size > 1) {
      conflicts.push(g);
    }
    // keeper: human_confirmed → 목표 패턴 일치 → 최근 갱신. (각 등급 내 최근 우선)
    const sorted = [...g.rows].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const keeper =
      sorted.find((r) => r.source === 'human_confirmed' && r.pattern === g.next) ??
      sorted.find((r) => r.source === 'human_confirmed') ??
      sorted.find((r) => r.pattern === g.next) ??
      sorted[0];
    for (const r of g.rows) {
      if (r.id === keeper.id) continue;
      ruleDeletes.push({ id: r.id, pattern: r.pattern, to: g.next });
    }
    if (keeper.pattern !== g.next) {
      ruleRenames.push({ id: keeper.id, from: keeper.pattern, to: g.next });
    }
  }

  console.log(
    `\n${tag} 규칙 ${rules.length}개 → 이름변경 ${ruleRenames.length} / 중복삭제 ${ruleDeletes.length} / 카테고리충돌 ${conflicts.length}`,
  );
  for (const r of ruleRenames) console.log(`   rename: ${r.from} -> ${r.to}`);
  for (const d of ruleDeletes) console.log(`   delete: ${d.pattern} (병합 대상 ${d.to})`);
  for (const c of conflicts) {
    console.log(`   ⚠️  충돌: ${c.next}`);
    for (const r of c.rows) {
      console.log(`        ${r.pattern} -> category ${r.categoryId} (${r.updatedAt})`);
    }
  }

  if (APPLY) {
    // 삭제를 먼저 — UNIQUE(householdId, merchantPattern) 충돌을 피한다.
    if (ruleDeletes.length > 0) {
      await db.delete(schema.merchantCategoryRules).where(
        inArray(
          schema.merchantCategoryRules.id,
          ruleDeletes.map((d) => d.id),
        ),
      );
      console.log(`   ✅ 규칙 ${ruleDeletes.length}개 삭제`);
    }
    for (const r of ruleRenames) {
      await db
        .update(schema.merchantCategoryRules)
        .set({ merchantPattern: r.to, updatedAt: new Date() })
        .where(eq(schema.merchantCategoryRules.id, r.id));
    }
    if (ruleRenames.length > 0) {
      console.log(`   ✅ 규칙 ${ruleRenames.length}개 패턴 갱신`);
    }
  }

  if (!APPLY) {
    console.log('\n실제로 적용하려면 --apply 를 붙여 다시 실행하세요.');
  }
} finally {
  await client.end({ timeout: 5 });
}
