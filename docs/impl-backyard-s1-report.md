# 뒷마당 슬라이스 1·2 구현 보고

2026-09-06. 기준 계약: `docs/impl-backyard-v0.md` 및 `docs/impl-backyard-s1-brief.md`.

엔진 없는 규칙·저장 계약·세션과 실제 배포 파일을 실행하는 테스트를 구현했다. 기존 앱 파일은 수정하지 않았다. 호스트·브릿지 복원, HTML, renderer, input, DOM 연결은 만들지 않았다.

## 검증 결과

아래 필수 게이트를 모두 통과했다.

```sh
pnpm --filter @family/web exec vitest run src/lib/game-backyard.test.ts
# 15개 통과
pnpm --filter @family/web exec vitest run src/lib/game-backyard-codec.test.ts src/lib/game-backyard-session.test.ts
# codec 45개 + session 29개 = 74개 통과
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
# 통과: ES2022 라이브러리만 사용하며 DOM·Node 전역 타입 없음
```

테스트 TypeScript 파일 자체도 `tsc --noEmit --allowJs --strict --skipLibCheck --target ES2022 --module esnext --moduleResolution bundler --types node`로 검사했다. 검사 대상은 새 테스트 3개와 VM 로더 `game-backyard-test-utils.ts`다.

실제 codec 출력의 `Buffer.byteLength(JSON.stringify(dto), 'utf8')` 결과다. 성공한 필수 테스트 명령의 stdout에 같은 수치를 출력한다.

| fixture | 실제 바이트 |
|---|---:|
| 초기 마당 | 114 |
| 9생산 + 7비생산 | 270 |
| 16생산 | 342 |
| 안전 정수 경계 + 최대 시드 + 16생산 + 3종 해금 | **469** |

최대 fixture는 모든 숫자의 최대 자릿수, 모든 칸의 가장 긴 화분 튜플, 전체 해금을 사용한다. 8192바이트 이하 및 실제 측정값 469바이트를 테스트로 고정했다. API·DB 왕복과 `pg_column_size`는 슬라이스 5에 남아 있다.

## 후속 연결용 API

일반 script 순서는 `balance.js` → `rules.js` → `codec.js` → `session.js`다. 전역은 API 등록만 하며 생성 시 통신·시각 조회·타이머 작업을 하지 않는다.

- `BackyardBalance.createBalance()` — 동결된 확정 상수.
- `BackyardRules.createRules()` — 계약의 `createInitialGarden(nowSec, seed)`, `potPrice(purchasedCount)`, `applyAction(garden, action, nowSec)` 및 격자·해금·완료 보조 함수.
- `BackyardCodec.createCodec()` — `serializeGarden(garden, savedAtSec)`, `deserializeGarden(raw)`.
- `BackyardSession.createSession(deps)` — `getState()`, `load()`, `destroy()`.

`Action`은 `{type:'harvest',cell}`, `{type:'buyAndPlace',kind,cell}`, `{type:'move',from,to}`다. 결과는 `ok`/`noop`/`error`이며 오류에는 `code`와 한국어 `message`가 있다. 규칙의 성공 상태는 중첩 좌표까지 복사·동결한다.

세션 의존성은 `bridge.ready(): Promise<void>`, `bridge.state.get/set`, `nowSec()`, `seed()`, `setTimer(callback, delayMs): number`, `clearTimer(id)`, 선택적 `onChange(state)`다. 테스트용으로 rules/codec 팩토리 결과도 주입할 수 있다. 타이머 지연은 밀리초, 게임 시각은 epoch seconds다. ready와 get은 각각 8초 무응답 제한을 가진다. set의 timeout은 주입된 브릿지가 reject해야 한다.

`getState().status === 'playable'` 분기에서만 `garden`, `warnings`, `writer`를 제공한다. writer에는 `dispatch(action)`, `flush()`, `getSaveState()`가 있고 다른 상태와 세션 컨트롤러 자체에는 writer가 없다. 저장 상태는 `dirty`, `inFlight`, `retryScheduled`, `error`, `permanentFailure`, `message`와 로컬/ACK 순번을 제공한다. 오류 문구는 `저장 안 됨`이다.

정상 객체·부분 손상 객체를 로드할 때는 자동 저장하지 않는다. 정확한 null 성공 응답만 증정 초기화 후 즉시 저장한다. 손상 튜플은 개별 경고로 버리고 자원·구매·해금 이력을 보존한다. 버전·상위 손상·읽기 실패에서는 초기화와 저장 호출이 없다.

저장 중 행동은 최신 전체 스냅샷 하나로 합친다. 실패 재시도는 1·2·4·8·16·30초, 이후 30초이며 다음 행동은 백오프를 취소한다. 영구 오류는 자동 저장을 멈추되 메모리 행동을 허용한다. reload/destroy는 이전 writer, 타이머, 늦은 응답을 무효화한다. 숨김 시 보조 flush를 호출할 수 있다.

## 확인 한계와 반복 방지

실제 브릿지·호스트·모바일 export·기기·API·DB는 이번 범위가 아니며 확인하지 않았다. 브릿지가 구체적인 영구 오류를 host_error로 숨기면 30초 재시도가 계속될 수 있다. 영속 outbox와 서버 revision이 없으므로 ACK 전 종료 손실과 다른 기기의 마지막 쓰기 우선 한계는 유지한다.

Memory·context7·sequential-thinking MCP는 현재 제공 도구에 없으므로 Memory 로드·ADR 저장·학습 기록 및 해당 MCP 검증은 수행하지 못했다. 새 외부 의존성은 추가하지 않았다. 후속 작업에서 반복할 검증 패턴은 다음과 같다: 배포 JS 자체를 VM에서 검사하기, 읽기 실패와 null을 분리하기, 오래된 비동기 응답을 세대로 차단하기, public JS를 DOM 없는 별도 타입 검사에 포함하기, 저장 크기는 실제 성공 출력으로 남기기.
