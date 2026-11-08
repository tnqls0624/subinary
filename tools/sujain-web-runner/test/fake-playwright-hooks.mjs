/**
 * output-shape.test.mjs 전용 모듈 해석 훅. run.mjs 의 `import('playwright-core')` 만 가짜로 돌린다.
 * FAKE_PLAYWRIGHT_SCENARIO=import_missing 이면 없는 파일로 돌려 import 실패를 만든다.
 * 운영 이미지·CI 의 다른 테스트는 이 훅을 등록하지 않는다(테스트가 자식 프로세스에만 --import 로 건다).
 */
const FAKE = new URL('./fake-playwright-core.mjs', import.meta.url).href;
const MISSING = new URL('./fake-playwright-core.missing.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier !== 'playwright-core') return nextResolve(specifier, context);
  return {
    url: process.env.FAKE_PLAYWRIGHT_SCENARIO === 'import_missing' ? MISSING : FAKE,
    shortCircuit: true,
  };
}
