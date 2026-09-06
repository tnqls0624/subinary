# 구현 지시서 — 슬라이스 6·7: 마감과 산출물 회귀 (2026-09-06)

> **이번 작업은 구현이다.** 게임의 마감(느낌)과 export/OTA 산출물 회귀를 끝낸다.

## 먼저 읽을 것

1. `docs/impl-backyard-v0.md` — **구현 설계서. 계약이다.** 특히 §7의 6·7행 · §8(위험).
2. `docs/impl-backyard-s4-report.md` — 직전 슬라이스 결과. **여기서 이어간다.**
3. `docs/design-tycoon-game-2026-09.md` §8 — 「도형을 캐릭터처럼 보이게 하는 가장 싼 네 가지」.

## 앞 슬라이스 상태 (코디네이터가 직접 확인함)

슬라이스 1~5는 끝났다. 워커가 사용량 한도로 `worker_done`을 못 보냈을 뿐이며,
코디네이터가 게이트를 재실행해 확인했다.

- `vitest` **138개 통과** (7 files)
- 격리 DB `family_memory_verify_...` 로 실제 PlayController PUT→GET 통과, DB 폐기 완료
- 최대 DTO raw **469B** / `pg_column_size` **548B**
- 브라우저 증거 10장 (320·360·430px, 수확·구매·이동·swap·재개 DTO 일치)
- 직전 워커가 실제 브라우저에서 **초기 handshake 세대 경쟁 버그**를 찾아 `bridge.js`를 고쳤다

**앞 슬라이스가 만든 것을 재작업하지 않는다.** 특히 `rules.js`·`codec.js`·`balance.js`·
`session.js`는 테스트로 고정돼 있으니 건드리지 않는다.

## 이번에 만드는 것 — 슬라이스 6과 7

| 슬라이스 | 만드는 것 |
|---|---|
| 6 | 성장 표시 · idle bob · 수확 피드백 · 완료 화면 · 숨김/복귀 · 정리(destroy) |
| 7 | 브라우저 통합 회귀 + 실제 export/OTA 산출물 검사 |

**슬라이스 8(iOS·Android 실기기)은 손대지 않는다.** 그건 사람이 기기를 들고 해야 한다.

## 슬라이스 6에서 지킬 것

설계서 §8의 네 가지를 그대로 적용한다 — 팔레트 6~8색 고정, 모서리 3~5px 둥글게,
그림자 한 겹, **익은 물건만** 2px·1.4초 bob.

bob이 "거둘 것이 여기 있다"는 안내를 겸하므로 **별도 아이콘을 만들지 않는다**(설계서 §8).

완료 화면은 16칸 점유 + 3종 해금으로 **계산**한다. 저장에 완료 플래그를 추가하지 않는다
(설계서 §5). 완료 후에도 닫고 재배치할 수 있어야 한다.

정리(destroy)는 RAF · 리스너 · 재시도 timer를 모두 해제한다. **20회 진입/이탈 뒤
누적이 없어야 한다** — 이게 게이트다.

## 완료 게이트 — 설계서 §7의 6·7행

슬라이스 6:
- 2px / 1.4초 bob, 도형·그림자·팔레트 확인
- **가짜 시각**으로 3시간(10800초) / 2시간 15분(8100초) 성장, 익은 채 유지,
  우물 이동 후 기존 `readyAt` 불변 확인
- 16칸 완료 후에도 swap 가능
- **20회 진입/이탈 뒤 리스너·RAF·timer 누적 없음**
- CSS와 HTML 버튼이 470px 안에서 사용 가능

슬라이스 7:
```
pnpm --filter @family/web exec vitest run src/lib/game-backyard.test.ts src/lib/game-backyard-codec.test.ts src/lib/game-backyard-session.test.ts src/lib/game-backyard-input.test.ts src/lib/game-backyard-integration.test.ts src/lib/miniapp-client.test.ts src/lib/miniapp-host.test.ts
pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2
pnpm --filter @family/web typecheck
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
pnpm --filter @family/web build:mobile
```
- `out`에 entry와 **모든 script/CSS**가 있고 public 원본과 **바이트 일치**
- export 정적 서버에서 쿼리 직진입(`/play/app/?key=backyard`) · 브릿지 복원 · **CORS 오류 없음**
- **새 out raw / ZIP 크기와 기준 대비 증가량 기록.**
  기준은 설계서 §3.1의 raw 3,864,248B · ZIP 1,123,874B다.
  canvas를 택한 결정이 실제로 얼마를 아꼈는지 이 숫자로 확인된다.
- 기존 전체 웹 테스트 실패가 있으면 **원인·기존 여부를 분리**해 적는다

## 보고

`worker_done` 본문에 **통과한 게이트와 새 OTA ZIP 크기 · 기준 대비 증가량**을 담는다.

## 지켜야 할 것

- 슬라이스 8(실기기)을 흉내내지 않는다. 에뮬레이터 결과를 실기기 통과로 쓰지 않는다.
- 확정 밸런스(가격 배열 · 시작 3개 · 10800/8100초)를 임의로 조정하지 않는다.
- 게이트를 통과하지 못했으면 `--outcome failed`로 보고한다. **통과했다고 쓰지 않는다.**
- `build:packages`가 `FULL TURBO`(캐시)로 통과하면 검증이 아니다. `--force`로 확인한다.
- 출력은 파일로 받는다 — `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
- **운영 스택(`docker-compose.prod.yml`)에 쓰지 않는다.** 필요하면
  `docs/impl-backyard-verify-env.md`의 격리 DB 관례를 쓴다.
