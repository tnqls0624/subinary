import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { countUnitOptions } from '../collect.mjs';
import { captureSujainTables } from '../table-capture.mjs';

/**
 * 키트 규칙(docs/architecture/housing-brand-adapters.md 4장)을 소스로 고정한다.
 * 1. import('playwright-core') 는 진입 파일(run.mjs)만 한다 — 모듈 해석이 호출 파일 위치 기준이다.
 * 2. page.evaluate 로 직렬화되는 함수는 키트를 부르지 않는다.
 * 그리고 키트는 브랜드를 모른다(브랜드 값은 인자로 받는다).
 */
const RUNNER = new URL('../', import.meta.url);
const KIT = new URL('../kit/', import.meta.url);
const KIT_FILES = (await readdir(KIT)).filter((name) => name.endsWith('.mjs')).sort();
const RUNNER_FILES = (await readdir(RUNNER)).filter((name) => name.endsWith('.mjs')).sort();
const read = (url) => readFile(url, 'utf8');

/** 블록 주석과 줄 전체 주석을 지운다(주석 속 설명 글자를 import 로 오인하지 않게). */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

/** 정적 import/export-from 과 동적 import() 의 모듈 지정자. */
function moduleSpecifiers(source) {
  const code = stripComments(source);
  const out = [];
  for (const match of code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*'([^']+)'/gmu)) out.push(match[1]);
  for (const match of code.matchAll(/^\s*import\s*'([^']+)'/gmu)) out.push(match[1]);
  for (const match of code.matchAll(/\bimport\(\s*'([^']+)'\s*\)/gu)) out.push(match[1]);
  return out;
}

test('kit has the four documented modules', () => {
  assert.deepEqual(KIT_FILES, ['allowlist.mjs', 'launch.mjs', 'result.mjs', 'stdin.mjs']);
});

test('kit modules import only node: builtins or sibling kit modules (never playwright-core, never brand files)', async () => {
  for (const name of KIT_FILES) {
    const specifiers = moduleSpecifiers(await read(new URL(name, KIT)));
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || /^\.\/[a-z-]+\.mjs$/u.test(specifier),
        `kit/${name} imports ${specifier}`,
      );
    }
  }
});

test('only run.mjs imports playwright-core', async () => {
  const importers = [];
  for (const name of RUNNER_FILES) {
    if (moduleSpecifiers(await read(new URL(name, RUNNER))).includes('playwright-core')) importers.push(name);
  }
  for (const name of KIT_FILES) {
    if (moduleSpecifiers(await read(new URL(name, KIT))).includes('playwright-core')) importers.push(`kit/${name}`);
  }
  assert.deepEqual(importers, ['run.mjs']);
});

test('kit knows no brand name, host, or constant', async () => {
  for (const name of KIT_FILES) {
    const source = await read(new URL(name, KIT));
    assert.doesNotMatch(source, /sujain|수자인|\.co\.kr/iu, `kit/${name}`);
  }
});

test('functions serialized into page.evaluate stay self-contained (no kit calls, no imports)', async () => {
  const kitExports = [];
  for (const name of KIT_FILES) kitExports.push(...Object.keys(await import(new URL(name, KIT).href)));
  assert.ok(kitExports.length > 0);
  for (const fn of [captureSujainTables, countUnitOptions]) {
    const source = fn.toString();
    for (const exported of kitExports) {
      assert.doesNotMatch(source, new RegExp(`\\b${exported}\\b`, 'u'), `${fn.name} references ${exported}`);
    }
  }
  assert.deepEqual(moduleSpecifiers(await read(new URL('table-capture.mjs', RUNNER))), []);
});
