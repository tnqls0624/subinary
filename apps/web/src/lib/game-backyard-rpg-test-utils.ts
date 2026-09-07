/// <reference path="../../public/miniapps/backyard/rpg-rules.js" />
/// <reference path="../../public/miniapps/backyard/rpg-codec.js" />
/// <reference path="../../public/miniapps/backyard/rpg-session.js" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/** 실제 배포 JS를 읽으며 테스트 안에 규칙을 복제하지 않는다. */
export function loadRpg() {
  const context = createContext({});
  for (const name of ['balance', 'rules', 'codec', 'rpg-rules', 'rpg-codec', 'rpg-session']) {
    const filename = resolve(import.meta.dirname, '../../public/miniapps/backyard', name + '.js');
    runInContext(readFileSync(filename, 'utf8'), context, { filename });
  }
  return {
    life: runInContext('BackyardRpgLife', context) as typeof BackyardRpgLife,
    rules: runInContext('BackyardRpgRules', context) as typeof BackyardRpgRules,
    codec: runInContext('BackyardRpgCodec', context) as typeof BackyardRpgCodec,
    session: runInContext('BackyardRpgSession', context) as typeof BackyardRpgSession,
  };
}

/** 테스트에서 플레이 가능한 유니온만 반환한다. */
export function playable(session: ReturnType<typeof BackyardRpgSession.createSession>) {
  const state = session.getState();
  if (state.status !== 'playable') throw Error('플레이 불가: ' + JSON.stringify(state));
  return state;
}
