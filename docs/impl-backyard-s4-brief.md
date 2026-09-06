# 구현 지시서 — 슬라이스 4·5: 화면과 실제 연결 (2026-09-06)

> **이번 작업은 구현이다.** 게임 화면을 만들고 실제 브릿지에 연결해 저장이 왕복하게 한다.

## 먼저 읽을 것

1. `docs/impl-backyard-v0.md` — **구현 설계서. 이것이 계약이다.**
   특히 §5(파일 구성·인터페이스) · §6.4(즉시 저장과 재시도) · §8(위험) · §7의 4·5행.
2. `docs/impl-backyard-s1-report.md` · `docs/impl-backyard-s3-report.md` — 앞 슬라이스 결과.
   `rules.js`·`codec.js`·`session.js`의 실제 API와 `bridge.js` 계약.
3. `docs/design-tycoon-game-2026-09.md` §8 — 아트 범위. 도형 7종·상태 11개, 싼 네 가지.

## 이번에 만드는 것 — 슬라이스 4와 5

| 슬라이스 | 만드는 것 |
|---|---|
| 4 | `index.html` · `style.css` · `renderer.js` · `input.js` · `app.js` (가짜 저장 의존성으로 로컬 플레이) |
| 5 | 실제 `bridge.js` 연결, 부모 PUT 직렬 큐 · 백오프 · 미저장 HUD |

**슬라이스 6 이후(bob·완료 화면·정리 마무리, export 회귀, 실기기)는 손대지 않는다.**

## 반드시 지킬 것

### 규칙을 다시 쓰지 않는다
`rules.js`·`codec.js`는 89개 테스트로 고정돼 있다. **고치지 않는다.**
renderer·input·app은 `Action`을 만들어 `rules`에 넘기고 결과를 그릴 뿐이다.
화면 코드가 경제·시각·인접을 직접 계산하면 안 된다.

### 저장은 `playable` session을 통해서만
`app.js`는 `bridge.set`을 직접 부르지 않는다. playable session의 dispatch에만 접근한다.
설계서 §6.2의 두 겹 방어를 화면 코드가 우회하면 안 된다.

### 자산은 코드로 그린다
이미지 파일 0개다. sandbox의 불투명 origin에서 상대경로 PNG·JSON 로딩은 **CORS로 막힌다**
(`docs/verify-sandbox-engine-2026-09.md`에 실측). `<script src>`는 되지만 XHR/fetch는 안 된다.
웹폰트도 쓰지 않는다 — 시스템 한글 폰트를 쓴다.

### 470px 안에서 끝나야 한다
iframe 높이가 470px 고정이다. 가로는 320·360·430px에서 전부 확인한다.
HUD·상점은 canvas가 아니라 **HTML**로 만든다(설계서 §8: 한글 폰트·터치 타겟·접근성이 공짜).
canvas는 마당만 그린다.

### 드래그를 만들지 않는다
탭 배치만이다. iframe 안 드래그는 호스트 페이지 스크롤과 싸운다.
`pointercancel`·스크롤·좌표 경계는 Action을 발생시키지 않는다.

## 완료 게이트 — 설계서 §7의 4·5행

슬라이스 4:
- sandbox에서 **320 · 360 · 430px 폭 × 470px 높이** 확인
- 화분 수확 → 구매·배치 → 이동/swap이 **rules Action만으로** 수행됨
- 모서리·DPR/리사이즈 hit-test, 스크롤 취소, 실패 행동 무차감
- `node --check` 각 새 JS + DOM JS 타입 검사(`tsconfig.miniapps-dom.json`) 통과

슬라이스 5:
- session/client/host 테스트 통과
- 실제 앱에서 수확·구매·이동 후 **닫고 다시 열어 DTO 일치**
- 테스트 가구 API/DB로 최대 상태 저장 성공 (raw + `pg_column_size` 둘 다)
- API 실패와 8초 timeout 주입 때 **미저장 표시 + 최신 재전송**
- **초기 GET 실패 시 PUT 횟수 0**을 네트워크 로그로 확인 — 이것이 최비용 게이트다
- 이전 요청 ACK가 최신 dirty를 지우지 않음

기존 게이트도 계속 통과해야 한다:
```
pnpm --filter @family/web exec vitest run src/lib/game-backyard.test.ts src/lib/game-backyard-codec.test.ts src/lib/game-backyard-session.test.ts src/lib/miniapp-client.test.ts src/lib/miniapp-host.test.ts
pnpm build:packages
pnpm --filter @family/web typecheck
pnpm --filter @family/web build:mobile
```

## 보고

`worker_done` 본문에 **통과한 게이트와 "초기 GET 실패 시 PUT=0" 확인 방법**을 담는다.

## 지켜야 할 것

- 슬라이스 6 이후를 미리 만들지 않는다.
- 확정 밸런스(가격 배열 · 시작 3개 · 10800/8100초)를 임의로 조정하지 않는다.
- 게이트를 통과하지 못했으면 `--outcome failed`로 보고한다. **통과했다고 쓰지 않는다.**
- `build:packages`가 `FULL TURBO`로 통과하면 검증이 아니다. 변경이 있었으면
  `pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2`로 확인한다.
- 출력은 파일로 받는다 — `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
