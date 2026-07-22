// 자동 조사 poller 안전 불변식 verify (node --test). `pnpm ops:auto-investigate:test`.
//
// poller는 무인 실행 + prod DB 접근 + LLM 비용이 걸린 안전 민감 스크립트다. 아래 불변식이
// 향후 편집으로 조용히 깨지면(예: SELECT에 summary 추가 = 프롬프트 인젝션 재개통) 이 테스트가 실패한다.
// docker/psql/holmes 없이 검증 가능한 정적 소스 불변식 + kill-switch 동작만 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pollerPath = join(here, 'auto-investigate.sh');
const automatedConfigPath = join(here, '..', '..', 'infrastructure', 'holmesgpt', 'config-automated.yaml');
const poller = readFileSync(pollerPath, 'utf8');
const automatedConfig = readFileSync(automatedConfigPath, 'utf8');

// SQL SELECT 절만 추출(operational_alerts 조회). 인젝션 방어의 핵심 검사 대상.
const selectClause = (() => {
  const m = poller.match(/select\s+(.+?)\s+from\s+operational_alerts/is);
  assert.ok(m, 'operational_alerts 조회 SELECT를 찾지 못함 — poller 구조 변경?');
  return m[1];
})();

test('인젝션 방어: SELECT가 자유텍스트(summary/details)를 조회하지 않는다', () => {
  assert.doesNotMatch(selectClause, /\bsummary\b/i, 'summary가 SELECT에 포함되면 프롬프트 인젝션 재개통');
  assert.doesNotMatch(selectClause, /\bdetails\b/i, 'details가 SELECT에 포함되면 프롬프트 인젝션 재개통');
});

test('인젝션 방어: SELECT는 allowlist scalar만 조회한다', () => {
  for (const col of ['id', 'kind', 'source_type', 'source_id', 'occurred_at']) {
    assert.match(selectClause, new RegExp(`\\b${col}\\b`), `allowlist 컬럼 ${col} 누락`);
  }
});

test('인젝션 방어: 질문 템플릿이 summary/details 변수를 삽입하지 않는다', () => {
  const q = poller.match(/question="([^"]*)"/s);
  assert.ok(q, 'question 템플릿을 찾지 못함');
  assert.doesNotMatch(q[1], /\$\{?summary/i, 'question에 summary 삽입 금지');
  assert.doesNotMatch(q[1], /\$\{?details/i, 'question에 details 삽입 금지');
  // 이 변수들은 애초에 할당조차 되지 않아야 한다.
  assert.doesNotMatch(poller, /^\s*summary=/m, 'summary 변수 할당 금지');
  assert.doesNotMatch(poller, /^\s*details=/m, 'details 변수 할당 금지');
});

test('SELECT는 critical severity로 제한된다', () => {
  assert.match(poller, /severity\s*=\s*'critical'/i, 'critical 이외 경보까지 조사하면 비용·노이즈 폭증');
});

test('config-automated.yaml: bash·internet·kubectl-run 비활성, docker/core만 활성', () => {
  const disabledBlock = (name) =>
    new RegExp(`${name.replace('/', '\\/')}:\\s*\\n\\s*enabled:\\s*false`, 'i');
  for (const t of ['bash', 'internet', 'kubectl-run']) {
    assert.match(automatedConfig, disabledBlock(t), `자동 경로에서 ${t}는 비활성이어야 함(인젝션→호스트 명령 차단)`);
  }
  assert.match(automatedConfig, /docker\/core:\s*\n\s*enabled:\s*true/i, 'docker/core는 활성(유일 허용 툴셋)');
});

test('kill switch: AUTO_INVESTIGATE_ENABLED 미설정이면 조사 없이 즉시 exit 0', () => {
  const env = { ...process.env };
  delete env.AUTO_INVESTIGATE_ENABLED;
  const out = execFileSync('sh', [pollerPath], { env, encoding: 'utf8' });
  assert.match(out, /disabled/i, 'kill switch off 시 disabled 메시지');
  // 예외 없이 반환 = exit 0. (docker/psql 접근 전에 종료하므로 스택 없이도 안전)
});

test('kill switch 기본값이 false다(명시적으로 켜야만 동작)', () => {
  assert.match(poller, /AUTO_INVESTIGATE_ENABLED:-false/, 'kill switch 기본 off 보장');
});
