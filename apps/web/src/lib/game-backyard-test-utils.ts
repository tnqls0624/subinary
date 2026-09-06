/// <reference path="../../public/miniapps/backyard/balance.js" />
/// <reference path="../../public/miniapps/backyard/rules.js" />
/// <reference path="../../public/miniapps/backyard/codec.js" />
/// <reference path="../../public/miniapps/backyard/session.js" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/** 실제 배포 파일을 DOM·스토리지·시계 없이 독립 VM에서 실행한다. */
export function loadBackyard() {
  const context = createContext({});
  runInContext('Date = undefined; Math.random = () => { throw new Error("난수는 주입해야 합니다"); };', context);
  for (const file of ['balance', 'rules', 'codec', 'session']) {
    const filename = resolve(import.meta.dirname, `../../public/miniapps/backyard/${file}.js`);
    runInContext(readFileSync(filename, 'utf8'), context, { filename });
  }
  const balance = runInContext('BackyardBalance', context) as typeof BackyardBalance;
  const rules = runInContext('BackyardRules', context) as typeof BackyardRules;
  const codec = runInContext('BackyardCodec', context) as typeof BackyardCodec;
  const session = runInContext('BackyardSession', context) as typeof BackyardSession;
  return { balance: balance.createBalance(), rules: rules.createRules(), codec: codec.createCodec(), session };
}

/** 비동기 응답 순서를 테스트에서 직접 제어한다. */
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 저장 응답 체인만 비우며 실제 시간을 기다리지 않는다. */
export async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

/** 저장 인덱스를 테스트 입력의 논리 칸으로 바꾼다. */
export const cell = (index: number): Cell => ({ row: Math.floor(index / 4), col: index % 4 });

/** 성공한 규칙 결과를 단언하여 후속 행동에 사용한다. */
export function nextGarden(result: ActionResult): Garden {
  if (result.status !== 'ok') throw new Error(`행동 실패: ${JSON.stringify(result)}`);
  return result.garden;
}
