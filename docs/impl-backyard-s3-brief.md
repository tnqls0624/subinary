# 구현 지시서 — 슬라이스 3: 호스트 런타임 복원 (2026-09-06)

> **이번 작업은 구현이다.** b88588a가 지운 미니앱 호스트 런타임을 되살리고 `backyard`를 등록한다.

## 먼저 읽을 것

1. `docs/impl-backyard-v0.md` — **구현 설계서. 이것이 계약이다.**
   특히 **§4(호스트 런타임 복원 계획)** 전체 — 파일별 복원/고쳐서 복원/폐기 판정과
   「브릿지와 저장 핸들러의 수정 계약」 절.
2. `docs/impl-backyard-s1-report.md` — 슬라이스 1·2 결과. `session.js`가 요구하는 브릿지 계약.
3. `docs/design-tycoon-game-2026-09.md` §0-1 · §7 — 왜 복원이고 무엇을 고쳐야 하는지.

## 이번에 만드는 것 — 슬라이스 3만

설계서 §7의 3행이다. **4행 이후(renderer · input · HTML · 실제 연결)는 손대지 않는다.**

§4 표의 12개 파일을 판정대로 처리한다. 원본은 `git show b88588a^:<path>`로 볼 수 있다.
복원하지 않을 파일 목록도 §4에 있다 — **그 목록은 되살리지 않는다.**

## 반드시 지킬 것

### 저장 실패를 삼키지 않는다
원본 `bridge.js`는 `get`의 `catch→null`과 `set`의 `catch→무시`를 둘 다 갖고 있었다.
**둘 다 제거한다.** 특히 `res?.state ?? null`로 필드 누락을 신규로 간주하면 안 된다 —
이것이 "로드 실패를 신규 사용자로 착각해 빈 마당을 저장하는" 최비용 버그의 입구다.
정상 응답의 `{state: null}`만 null이고, 나머지는 전부 reject다.

### `output: export`에서 동적 라우트는 막힌다
`055bc45`가 이미 고친 함정이다. `[key]` 동적 폴더를 만들지 말고 쿼리 파라미터
(`/play/app?key=backyard`)와 `useSearchParams`의 Suspense 경계를 유지한다.
성공 기준은 웹 dev 접속이 아니라 **`build:mobile` 후 `out/play/app/index.html` 존재**다.

### `packages/shared`에 DOM 타입을 두지 않는다
이 저장소가 실제로 당한 함정이다 — `typecheck`는 통과하고 `build:packages`가 터진다.
shared에는 **브릿지 순수 계약만** 둔다. Window·EventListener·Canvas·TextEncoder에
의존하는 코드는 전부 web에 남긴다. `pnpm build:packages`를 필수 게이트로 삼는다.

### 기존 테스트 32건을 보존한다
bridge 24건 + SDK 8건이다. §4의 판정대로 `miniapp-sdk.test.ts`는
`miniapp-client.test.ts`로 이전하고 **실제 배포되는 `bridge.js`에 대해 실행**한다.
테스트 안에 클라이언트를 복제하지 않는다.

## 완료 게이트 — 설계서 §7의 명령을 그대로 쓴다

```
pnpm --filter @family/shared test
pnpm --filter @family/web exec vitest run src/lib/miniapp-client.test.ts src/lib/miniapp-host.test.ts
pnpm build:packages
pnpm --filter @family/web typecheck
pnpm --filter @family/web build:mobile
```

빌드 후 확인할 것:
- `apps/web/out/play/app/index.html` 존재
- `apps/web/out/miniapps/backyard/` 안에 슬라이스 1·2의 4개 JS가 바이트 일치로 존재

동작 검증:
- `state.get` reject 전파 · `state.set` 실패 전파
- 잘못된 `event.source` 거부 · iframe 세대 검사
- `permissions: []` 확인 (권한 0개)
- 게임 entry(`index.html`)가 아직 없으므로 **호스트 단독 harness로 통신만 확인**하고
  제품 화면 완료로 세지 않는다

## 보고

`worker_done` 본문에 **통과한 게이트 명령과 out 산출물 확인 결과**를 담는다.

## 지켜야 할 것

- **슬라이스 4 이후를 미리 만들지 않는다.** renderer · input · index.html · style.css는 이번이 아니다.
- 슬라이스 1·2가 만든 4개 JS와 테스트를 고치지 않는다. 이미 89개 테스트로 고정돼 있다.
- 게이트를 통과하지 못했으면 `--outcome failed`로 보고한다. **통과했다고 쓰지 않는다.**
- `pnpm test`를 병렬로 돌리면 무작위 패키지가 실패한다(turbo 경합). 회귀 판정은
  `pnpm exec turbo run test --concurrency=1 --force`로 한다. 출력은 파일로 받는다 —
  `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
