# 구현 지시서 — 슬라이스 4·5: 저장 계약과 실제 연결 (2026-09-07)

> **이번 작업은 구현이다.** 5개 키 저장 계약을 만들고 실제 브릿지에 연결한다.

## 먼저 읽을 것

1. `docs/redesign-backyard-rpg.md` — **재설계 설계서. 계약이다.**
   특히 **§7 전체**(저장 모델 · 원자성의 경계 · 부팅·저장·복귀 · 동시 편집 한계) · §11의 4·5일 행.
2. `docs/impl-backyard-v0.md` **§6**(저장 계약과 실패를 구분하는 구조) — v0가 이미 푼 문제다.
   특히 §6.2의 판별 유니온과 "로드 실패가 신규 저장으로 갈 수 없는 분기".
3. 기존 `apps/web/public/miniapps/backyard/codec.js`·`session.js` — **재사용 판단의 대상.**
   설계서 §7이 "현재 codec 함수 자체는 Garden·balance에 결합되어 있으므로 그대로 호출하지
   않는다. 원칙만 옮긴다"고 했다. 그 판단이 맞는지 코드를 보고 확인하라.

**근거가 필요하면 문서를 열어라.** "무엇을 하라"만 보고 "왜"를 모른 채 결정하지 마라.

## 지금까지의 상태

| 커밋 | 내용 |
|---|---|
| `05fb5e4` | 슬라이스 1 — Phaser·지도·캐릭터·패드·카메라 |
| `21a6899` | 슬라이스 2·3 — 반응형 높이·지형·근접 판정·꾸미기 |

**저장은 아직 fixture다.** `rpg-rules.js`의 `fixture()`·`decorationFixture()`가 고정값을 주고,
새로 열면 항상 집 앞에서 시작한다. 이번 슬라이스가 그것을 실제 저장으로 바꾼다.

슬라이스 2·3은 codex가 사용량 한도로 중간에 멈춰 **코디네이터가 이어받아 마무리**했다.
그때 고친 것 하나를 알아두라 — 등록부(`miniapp-registry.ts`)의 `height`가 이제
**고정 높이가 아니라 상한**이고 `BackyardViewport`가 `Math.min`의 한쪽으로 쓴다.

## 이번에 만드는 것 — 슬라이스 4와 5

### 슬라이스 4 — v2 codec 5키 + session 상태 기계 + v1 이전

설계서 §7의 5개 키를 만든다: `rpg_meta` · `rpg_world` · `rpg_collection` · `rpg_residents` · `rpg_player`

**주민·채집·낚시 자체는 6·7·8일차다.** 이번에는 그 키의 **형식과 경계**만 만든다.
빈 상태로 왕복하고 검증이 도는 데까지다.

v1 이전도 이번이다 — 기존 `garden` 키를 v1 decoder로 읽고 4×4 배치를 집 앞
열 3~6, 행 15~18에 매핑한다. **기존 `garden`은 삭제·수정하지 않는다.**

### 슬라이스 5 — 실제 bridge 저장·복귀·이동 checkpoint

키별 writer, 부모 PUT 큐, 백오프, 미저장 HUD.

## 반드시 지킬 것

### 로드 실패가 신규 저장으로 가면 안 된다
**이것이 이 프로젝트에서 가장 비싼 버그다.** v0가 §6.2에서 두 겹으로 막았다 —
session 상태가 판별 유니온이고 **`Garden`과 writer가 `playable`에만 존재**한다.
같은 구조를 5키로 확장하라.

설계서 §7이 추가 규칙을 준다: **meta가 존재하는데 필수 키가 null이면 초기화하지 않고
복원 오류로 멈춘다.** 알 수 없는 버전도 자동 덮어쓰지 않는다.

### 초기화 순서 — meta를 마지막에 쓴다
데이터 4개 키의 ACK 후 meta를 쓴다. 부분 초기화가 남아 있으면 기존 키를 검증·보존하고
없는 키만 채운다. **초기화가 끝나기 전에는 플레이를 열지 않는다.**
동시 최초 진입이 다른 시드를 쓰지 않도록 초기 seed는 고정값 **4821**을 쓴다.

### 화분 수확이 두 키를 걸친다
설계서 §7 「원자성의 경계」가 이 하나를 특별히 다룬다. 화분 `readyAt`을 collection의
채집점 데이터에 두고 `pot-{id}`를 권위로 삼는다. world 튜플의 `readyAt`은 v0 이전용이다.
**보관 후 다시 놓아 즉시 수확하는 우회가 없어야 한다.**

### 이동 저장 빈도
멈춘 지 1초 후 · 걷는 중 최대 10초마다 · 숨김 시 보조 flush.
**프레임마다 저장하지 않는다.** 게이트에 60초 걷기 동안 player PUT ≤7회가 있다.

### 동시 편집을 해결했다고 쓰지 마라
설계서 §7이 명시한다 — 키 분리는 덮이는 범위를 줄일 뿐 같은 키 동시 편집을 해결하지
않는다. **"완전한 멱등 저장"이라고 부르지 마라.** 마지막 쓰기 우선 한계를 유지한다.

## 완료 게이트 — 설계서 §11의 4·5일 행

슬라이스 4:
- codec/session 테스트 통과. **null / GET reject / unknown v / 손상**을 각각 별도 분기로
- **모든 실패 초기 읽기에서 PUT = 0**
- 데이터 4키 중 각 지점 실패 후 재진입 시 **기존 키 보존 · meta 마지막 ACK**
- **최대 키별 raw 바이트를 테스트 출력에 남길 것** (설계서 §7 예산: meta 256 / world 3072 /
  collection 4096 / residents 512 / player 256)

슬라이스 5:
- host/client/session/integration 테스트
- 물건 이동 → ACK → 재진입 일치
- GET 503 / PUT 503 / 8초 timeout / 늦은 ACK 후 최신 dirty 유지
- **걷기 60초 동안 player PUT ≤7회**(정지 저장 1회 포함), 프레임별 PUT **0**
- **초기 GET 실패 시 PUT = 0**을 네트워크 로그로 확인

기존 게이트도 깨지지 않아야 한다:
```
pnpm --filter @family/web exec vitest run src/lib/game-backyard.test.ts src/lib/game-backyard-codec.test.ts src/lib/game-backyard-session.test.ts src/lib/game-backyard-input.test.ts src/lib/game-backyard-integration.test.ts src/lib/miniapp-client.test.ts src/lib/miniapp-host.test.ts
pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2
pnpm --filter @family/web typecheck
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
pnpm --filter @family/web build:mobile
```

## 보고

`worker_done` 본문에 **통과한 게이트와 키별 최대 raw 바이트**를 담는다.
보고서는 `docs/rpg-s45-report.md`에, 증거는 `docs/evidence/rpg-s45/`에.

## 지켜야 할 것

- **슬라이스 6 이후를 미리 만들지 않는다.** 주민 대사·채집 8종·낚시 8종·도감 화면은 이번이 아니다.
- v0 파일(`rules.js`·`codec.js`·`session.js`·`app.js` 등)을 **지우지 마라.** 병행 보존 중이다.
- 확인 못 한 것은 **"확인 못 함"**이라고 쓴다. 사람이 해야 하는 관찰을 자동 결과로 대신하지 마라.
- `build:packages`가 `FULL TURBO`면 검증이 아니다. `--force`로 확인한다.
- 출력은 파일로 받는다 — `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
- **운영 스택(`docker-compose.prod.yml`)에 쓰지 마라.** 12개 컨테이너가 운영이고 실사용자
  데이터가 있다. 실제 API·DB 검증은 **슬라이스 10**이며 그때 `docs/impl-backyard-verify-env.md`의
  격리 DB 관례를 쓴다. 이번 슬라이스는 가짜 브릿지로 충분하다.
