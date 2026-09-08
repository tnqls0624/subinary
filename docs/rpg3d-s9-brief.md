# 구현 지시서 — 3D 슬라이스 9: 배포 후보와 롤백 검증 (2026-09-08)

> **이번 작업은 검증과 정리다.** 2D 표현을 걷어내고 OTA 절감을 실측한다.

## 먼저 읽을 것

1. `docs/redesign-backyard-3d.md` — **설계서. 계약이다.**
   특히 **§9의 9일 행** · **§10(실패 조건과 롤백)** · §1의 크기 실측 표.
2. `docs/rpg3d-s567-report.md` — 직전 슬라이스. 무엇이 3D로 옮겨졌는지.
3. `docs/rpg-s91011-report.md` — 2D 시절의 OTA 실측 기준선과 Phaser 리스너 결함 기록.

**근거가 필요하면 문서를 열어라.** "무엇을 하라"만 보고 "왜"를 모른 채 결정하지 마라.

## 지금까지의 상태

| 커밋 | 내용 |
|---|---|
| `cee9bfa` | 슬라이스 1 — fixture 장면. **사용자 시각 승인** |
| `bbb41e6` | 2·3 — `(game)` 전체 화면 라우트 + 걷기 |
| `0e43bb1` | 4 — 직접 저장 어댑터, 5키 계약 보존 |
| `b5040f6` | 5·6·7 — 주민·채집·낚시·도감·꾸미기 3D 이식 |

테스트 259 통과 + 1 스킵(18 files). **Phaser와 Three가 아직 둘 다 실려 있다.**

## 이번에 할 것

### 1. Phaser와 2D 표현을 걷어낸다 — 판정하며 지운다

**한 번에 다 지우지 마라. 파일별로 판정하고 근거를 적어라.**

- `public/miniapps/vendor/phaser.min.js`(1,375,976B) + 라이선스
- `public/miniapps/backyard/` 의 2D 표현: `rpg-engine.js`(42KB) · `renderer.js` ·
  `input.js` · `app.js` · `rpg-input.js`(3D가 쓰는지 확인하라) · `style.css` ·
  `rpg-style.css` · `index.html`(호환 페이지는 남길지 판단)
- v0 잔존: `balance.js` · `rules.js` · `codec.js` · `session.js` —
  **`rpg-codec.js`가 garden 이주에 `BackyardCodec`을 쓴다.** 지우면 이주가 깨진다.
  실제 참조를 확인하고 필요한 것만 남겨라.
- 테스트: 2D 표현을 검증하던 것들. **규칙·codec·session 테스트는 3D도 쓰므로 남는다.**
- `scripts/verify-backyard/rpg2d-legacy.html` + 2D 수명 하네스

**설계서 §10이 롤백을 두 경로로 갈랐다** — 개발 중 실패는 "전체 화면 셸을 살리고 2D
표현을 붙이는 복귀 후보", 출시 후 장애는 "이전 OTA/웹 배포물로 되돌리기"다.
사용자 시각 승인이 났으므로 첫 경로는 닫혔다. **두 번째 경로는 배포물이 담당하므로
소스에 2D를 남길 이유가 없다.** 다만 그 판단 근거를 보고서에 적어라.

`it.skip`으로 슬라이스 8에 이관된 2D 호스트 수명 시험은 **대상이 사라지므로 지운다.**
지우는 이유를 커밋과 보고서에 남겨라 — Phaser 리스너 +40 발견은 `rpg-s91011-report.md`에
기록으로 남아 있다는 사실을 함께 적어라.

### 2. OTA 실측 — 이 슬라이스의 본체

기준선(`docs/rpg-s91011-report.md`, 2D 시절):
```
raw 4,030,572B   ZIP 1,179,233B     ← v0
raw 5,511,282B   ZIP 1,570,734B     ← 3D 이전 마지막 배포(Phaser만)
```

설계서 §1이 예상한 것: **ZIP 엔진 압축분 차이 205,394B 감소.**
설계서가 "원본 파일 감소를 OTA 감소로 대체하지 않는다"고 명시했으니
**같은 배포 스크립트로 만든 ZIP끼리 비교하라.**

- Phaser 제거 전/후 ZIP을 각각 재고 실제 차이를 기록한다
- 예상(205KB 감소)과 실제의 차이를 설명한다. 게임 코드가 늘었으니 상쇄가 있다
- **기능을 빼거나 CDN으로 옮겨 수치를 낮추지 마라**

### 3. 전체 회귀

```
pnpm --filter @family/shared test
pnpm --filter @family/web exec vitest run src/lib/game-backyard src/lib/backyard-storage src/lib/miniapp
pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2
pnpm --filter @family/web typecheck
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
pnpm --filter @family/web build:mobile
node scripts/verify-backyard/rpg3d-s567.mjs
```

- `out`에 entry와 모든 script/CSS가 있고 **public 원본과 바이트 일치**
- **CDN 요청 0 · 이미지 에셋 0 · Phaser 동봉 0**
- 기존 전체 웹 테스트 실패가 있으면 **원인·기존 여부를 분리**해 적는다

### 4. 저장 호환 확인 — 롤백의 근거

설계서 §10: "v2/mapVersion 1을 그대로 쓰므로 2D가 같은 저장을 읽을 수 있다는 것이
복귀 설계의 근거이고, **실제 왕복 fixture로 확인해야 한다.**"

- 3D가 쓴 5키를 codec이 그대로 읽는지 왕복 확인
- 저장 좌표 범위(`x 0~511, y 0~383`)와 `mapVersion=1`이 유지되는지
- **garden·rpg 5키를 지우거나 역마이그레이션하지 않는다**

## 반드시 지킬 것

- **실기기는 이번이 아니다.** 슬라이스 8이고 사람이 기기를 들고 한다.
  에뮬레이터·데스크톱 결과를 실기기 통과로 쓰지 마라.
- **배포하지 마라.** 배포 후보를 만들고 검증만 한다. 커밋도 하지 마라 —
  코디네이터가 게이트를 재실행하고 커밋한다.
- 확인 못 한 것은 **"확인 못 함"**이라고 쓴다.
- `build:packages`가 `FULL TURBO`면 검증이 아니다. `--force`로 확인한다.
- 출력은 파일로 받는다 — `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
- **운영 스택(`docker-compose.prod.yml`)에 쓰지 마라.**

## 보고

`worker_done` 본문에 **지운 파일 수 · ZIP 실측(전/후/차이) · 예상과의 차이 설명**을 담는다.
보고서는 `docs/rpg3d-s9-report.md`에, 증거는 `docs/evidence/rpg3d-s9/`에.
