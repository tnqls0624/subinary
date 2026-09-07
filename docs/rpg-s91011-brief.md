# 구현 지시서 — 슬라이스 9·10·11: 도감과 출하 검증 (2026-09-07)

> **이번 작업은 구현이다.** 마지막 화면을 만들고 실제 저장·산출물을 검증한다.

## 먼저 읽을 것

1. `docs/redesign-backyard-rpg.md` — **재설계 설계서. 계약이다.**
   특히 **§6의 「재방문 이유와 완료」** · §7의 「두 사람이 동시에 열 때의 한계」 ·
   §9(엔진 크기) · §11의 9·10·11일 행.
2. `docs/rpg-s678-report.md` — 직전 슬라이스. 주민·채집·낚시의 실제 API.
3. `docs/impl-backyard-verify-env.md` — **격리 DB 관례. 슬라이스 10에서 이것을 쓴다.**
   운영 스택에 쓰지 않는 이유와 참고 스크립트가 여기 있다.

**근거가 필요하면 문서를 열어라.** "무엇을 하라"만 보고 "왜"를 모른 채 결정하지 마라.

## 지금까지의 상태

| 커밋 | 내용 |
|---|---|
| `05fb5e4` | 걷기·카메라·충돌 |
| `21a6899` | 반응형 높이·지형·근접 판정·꾸미기 |
| `541052b` | 5키 저장 계약 |
| `91184a9` | 주민 3명·대사 56개·채집 8종·낚시 8종 |

테스트 203개, 최대 raw는 meta 76 / world 662 / collection 2005 / residents 101 / player 84 B.

**직전 커밋에서 코디네이터가 고친 것 하나를 알아두라** — 재생성 간격이 종류별로 다르다.
열매(나무·화분)는 10800초, 버섯·솔방울·벌레는 60초다. `life.regrowSeconds(node)`가 권위다.
설계서 §12의 "익으면 멈춤 — 나무·화분에 유지"를 지키기 위한 것이니 다시 통일하지 마라.

## 이번에 만드는 것 — 슬라이스 9·10·11

### 슬라이스 9 — 도감 화면·오늘 변주·완료

설계서 §6의 「재방문 이유와 완료」대로.

- 도감은 **4종 바닥/열매 · 4종 벌레 · 8종 물고기 세 탭.**
- **미발견 칸에도 이름 대신 실루엣과 장소 힌트**를 준다. 빈 칸으로 두지 마라.
- 발견 항목: 이름 · 큰 그림 · 처음 기록한 날짜 · 획득 장소 · 짧은 관찰문.
- 2열 카드, 세로 스크롤, 닫기 고정. **배경은 inert, 초점은 닫기/항목 사이 유지,
  닫을 때 원래 버튼으로 복귀.**
- 오늘 변주: 자주 보이는 벌레 위치 · 주민 waypoint 선택 · 추천 낚시점.
  **희귀도·수량 보상이 아니고 만료 카운트다운도 없다.**
- 16종 발견 시 "우리 마당의 작은 생명을 모두 만났어요"를 **한 번** 보여준다.
  이후에도 낚시·대화·꾸미기가 남는다. 친밀도 만점이나 칸 점유를 완료 조건으로 강요하지 않는다.

### 슬라이스 10 — 실제 API·DB·이전·두 기기 충돌

**⛔ 운영 스택(`docker-compose.prod.yml`)에 쓰지 마라.** 12개 컨테이너가 운영이고
실사용자 2명의 데이터가 있다.

`scripts/verify-play-state-isolated.mjs`를 RPG fixture로 확장한다. 기존 관례를 따른다 —
`scripts/lib/verification-database-guard.mjs`가 `family_memory_verify_<timestamp>_<hex>`
형식의 DB만 생성·폐기하도록 강제한다. **우회하지 마라.**

- 일회용 DB에서 **5키 PUT→GET 일치**, 각 키의 **raw와 `pg_column_size` 둘 다 ≤8192B**
- **한 키 실패 시 다른 키 복원 유지**
- v1 `garden` 이전 fixture
- **두 클라이언트 같은 키 저장 역전의 손실을 재현·보고**하고 마지막 쓰기 정책 수용 여부를 적는다.
  설계서 §7이 "키 분리는 같은 키 동시 편집을 해결하지 않는다"고 명시했다.
  **해결했다고 쓰지 마라.** 손실 범위를 실측해 남기는 것이 이번 작업이다.

### 슬라이스 11 — 전체 회귀·export·OTA·수명

- 관련 모든 Vitest · `pnpm --filter @family/shared test` · 강제 패키지 빌드 ·
  웹 typecheck · public 두 tsc · `build:mobile`
- `node scripts/verify-backyard/export.mjs` 계열 재현
- **20회 진입/이탈 뒤 Game/Scene·timer/listener 증가 0**
- 정상 경로에서 **CORS·JS 오류 0**
- **public/out 해시 일치**
- **최종 OTA ZIP 크기와 기준 대비 증가량 기록.**
  기준은 v0의 raw 4,030,572B / ZIP 1,179,233B다(`docs/evidence/backyard-s6/artifact-results.json`).
  설계서 §9의 목표는 **v0 대비 +450KiB 이내**이고 초과하면 파일별 원인을 검토한다.
  **기능을 삭제하거나 CDN으로 빼서 수치를 숨기지 마라.**
- 기존 전체 웹 테스트 실패가 있으면 **원인·기존 여부를 분리**해 적는다

## 반드시 지킬 것

### 잃는 것을 만들지 마라
30일 경과 후 발견·수량·관계 감소 **0**이 게이트다. 오늘 변주에 만료를 붙이지 마라.

### 도감이 판 탭 화면이 되지 않게
도감은 **기록을 보는 곳**이고 획득은 세계에서 다가가서 한다. 도감에서 바로 얻는 버튼을 만들지 마라.

### 동시 편집을 해결했다고 쓰지 마라
실측해서 손실 범위를 남기는 것이 목적이다. 서버 CAS 없이 무손실을 약속하지 마라.

### 규칙과 표현을 가른다
`rpg-rules.js`에 Phaser·DOM을 넣지 마라. 엔진 접촉은 `rpg-engine.js`에만.

## 완료 게이트

위 각 슬라이스 항목이 그대로 게이트다. 추가로:
```
pnpm --filter @family/shared test
pnpm --filter @family/web exec vitest run src/lib/game-backyard.test.ts src/lib/game-backyard-codec.test.ts src/lib/game-backyard-session.test.ts src/lib/game-backyard-input.test.ts src/lib/game-backyard-integration.test.ts src/lib/game-backyard-rpg-codec.test.ts src/lib/game-backyard-rpg-session.test.ts src/lib/game-backyard-rpg-integration.test.ts src/lib/game-backyard-rpg-life.test.ts src/lib/miniapp-client.test.ts src/lib/miniapp-host.test.ts
pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2
pnpm --filter @family/web typecheck
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
pnpm --filter @family/web build:mobile
```

## 보고

`worker_done` 본문에 **통과한 게이트 · 최종 OTA ZIP 크기와 기준 대비 증가량 ·
두 기기 충돌 손실 범위**를 담는다.
보고서는 `docs/rpg-s91011-report.md`에, 증거는 `docs/evidence/rpg-s91011/`에.

## 지켜야 할 것

- **슬라이스 12(iOS·Android 실기기)는 손대지 않는다.** 사람이 기기를 들고 해야 한다.
  에뮬레이터 결과를 실기기 통과로 쓰지 마라.
- v0 파일(`rules.js`·`codec.js`·`session.js`·`app.js` 등)을 **지우지 마라.**
- 확인 못 한 것은 **"확인 못 함"**이라고 쓴다. 사람이 해야 하는 관찰을 자동 결과로 대신하지 마라.
- `build:packages`가 `FULL TURBO`면 검증이 아니다. `--force`로 확인한다.
- 출력은 파일로 받는다 — `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
