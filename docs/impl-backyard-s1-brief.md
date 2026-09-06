# 구현 지시서 — 슬라이스 1·2 (2026-09-06)

> **이번 작업은 구현이다.** 엔진 없이 순수 규칙과 저장 계약을 만들고 테스트로 고정한다.

## 먼저 읽을 것

1. `docs/impl-backyard-v0.md` — **구현 설계서. 이것이 계약이다.**
   특히 §2(확정값) · §5(파일 구성·인터페이스) · §6(저장 계약) · §7 슬라이스 1·2 행.
2. `docs/design-tycoon-game-2026-09.md` — 게임 설계. 왜 그런 규칙인지의 근거.
3. `docs/impl-backyard-brief.md` 부록 — 코디네이터 확정 4건.

## 이번에 만드는 것 — 슬라이스 1과 2만

설계서 §7의 1행과 2행이다. **3행 이후는 손대지 않는다.**

| 슬라이스 | 만드는 것 |
|---|---|
| 1 | `balance.js` · `rules.js` + `game-backyard.test.ts` |
| 2 | `codec.js` · `session.js` + `game-backyard-codec.test.ts` · `game-backyard-session.test.ts` + public JS 타입 검사 구성 |

경로·책임·시그니처는 설계서 §5 표와 「규칙 및 표현 인터페이스」 절에 있다. **그대로 따른다.**

## 반드시 지킬 것

### 규칙 파일은 순수해야 한다
`rules.js`·`codec.js`·`balance.js`는 DOM · `Date.now` · `Math.random` · 엔진 · 스토리지에
접근하지 않는다. 시각과 시드는 호출자가 주입한다. 부팅 부작용 없는 팩토리로 만든다.

### 테스트는 배포되는 파일 자체를 검증한다
설계서 §2가 확인했듯, 예전 `game-snake.test.ts`는 **판정 함수를 테스트 안에 복제**해 두고
그 복제본을 검증했다. 같은 실수를 반복하지 않는다.
→ `node:fs`로 실제 `public/miniapps/backyard/*.js`를 읽고 `node:vm` 격리 context에서
평가해 팩토리 결과를 검사한다. **규칙을 테스트 안에 다시 쓰지 않는다.**

### 로드 실패가 저장으로 이어질 수 없어야 한다
설계서 §6.2가 이 구현의 핵심이다. `session` 상태는 판별 유니온이고
**`Garden`과 writer는 `playable`에만 존재한다.** 다른 상태에서는 저장 호출이
타입·구조적으로 불가능해야 한다. `deserializeGarden`은 null을 신규로 처리하지 않는다.

### `packages/shared`에 DOM 타입을 쓰지 않는다
이 저장소가 실제로 당한 함정이다 — `typecheck`는 통과하고 `build:packages`가 터진다.
이번 슬라이스는 shared를 건드리지 않지만, 파일 위치를 옮기고 싶어지면 이 제약을 먼저 본다.

## 완료 게이트 — 설계서 §7의 명령을 그대로 쓴다

```
pnpm --filter @family/web exec vitest run src/lib/game-backyard.test.ts
pnpm --filter @family/web exec vitest run src/lib/game-backyard-codec.test.ts src/lib/game-backyard-session.test.ts
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
```

설계서 §7이 지정한 테스트 항목을 빠짐없이 넣는다. 특히:

- 시작 3수확 → 첫 가격 3 → 열매 0 (한 바퀴가 도는지)
- 3번 칸과 4번 칸을 인접으로 계산하지 않음 (행 경계)
- 우물 중첩 미가속 · 10800초 / 8100초
- 장기 방치해도 1개 · 시계 역행
- 꽉 찬 마당 swap
- 가격 배열 정상 경로 도달 불가 (시작 3칸 + 무삭제 불변식 → 최대 13개)
- 가짜 get 실패 때 **초기화 호출 0회 · set 호출 0회**
- null일 때만 초기화 · unknown v 무저장 · 혼합 손상 보존
- 실제 최대 DTO 바이트를 테스트 출력에 남길 것 (§6.5)

## 보고

`worker_done` 본문에 **통과한 게이트 명령과 실제 측정된 최대 DTO 바이트**를 담는다.

## 지켜야 할 것

- **슬라이스 3 이후를 미리 만들지 않는다.** 호스트 복원 · renderer · input · HTML은 이번이 아니다.
- 설계서의 확정값(가격 배열 · 시작 3개 · 시간 상수)을 임의로 조정하지 않는다.
- 게이트를 통과하지 못했으면 `--outcome failed`로 보고한다. **통과했다고 쓰지 않는다.**
- 기존 앱 코드를 고치지 않는다. 이번에 만드는 것은 새 파일뿐이다.
