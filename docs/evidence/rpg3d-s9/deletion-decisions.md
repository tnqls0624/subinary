# 파일별 삭제 판정 — 3D 슬라이스 9

판정 근거는 **실제 참조**다. 문서·과거 증거 JSON의 언급은 참조로 세지 않는다
(그것은 기록이며 코드가 부르는 것이 아니다).

참조 조사 방법: 저장소 전체에서 파일명 문자열을 찾고(`node_modules`·`.next`·`out`·
`apps/mobile/{android,ios}/…/public` 제외), 그중 **런타임 로드 목록**
(`backyard-game.tsx`의 `loadEngine`), **HTML `<script>`/`<link>`**, **Node VM 로드**
(`*-test-utils.ts`), **tsconfig `include`**, **검증 하네스**만 참조로 인정했다.

## 삭제 — 배포물에 실리던 것 (8개, raw 1,443,505B)

| 파일 | 크기 | 판정 근거 |
|---|---:|---|
| `public/miniapps/vendor/phaser.min.js` | 1,375,976B | 2D 엔진 벤더. 유일한 로더였던 `rpg2d-legacy.html`·`rpg-lifecycle.mjs`를 함께 지웠고, `rpg-engine.js`가 사라지면 `Phaser` 전역을 읽는 코드가 0이 된다 |
| `public/miniapps/vendor/PHASER-LICENSE.md` | 1,120B | 위 벤더의 라이선스. 벤더가 없으면 동봉 의무도 없다. `scripts/verify-sandbox-engine/vendor/`의 **별도 사본은 그대로 둔다**(그 조사 산출물의 라이선스) |
| `public/miniapps/backyard/rpg-engine.js` | 42,411B | Phaser 2D 어댑터. 실제 참조는 `rpg3d-world.js` 머리주석 1줄뿐이며 그 주석은 "삭제된"으로 고쳤다 |
| `public/miniapps/backyard/renderer.js` | 6,024B | v0 2D canvas 렌더러. 참조는 `game-backyard-input.test.ts`(함께 삭제) 하나 |
| `public/miniapps/backyard/input.js` | 2,285B | v0 2D 입력. **3D가 쓰는 것은 `rpg-input.js`이며 다른 파일이다**(아래 유지 표). 참조는 `game-backyard-input.test.ts` 하나 |
| `public/miniapps/backyard/app.js` | 9,720B | v0 2D iframe 호스트 부트. 참조는 `game-backyard-lifecycle.test.ts`(함께 삭제) 하나 |
| `public/miniapps/backyard/style.css` | 1,656B | v0 iframe 페이지 스타일시트. 라이브 참조 **0** — 슬라이스 2·3이 `index.html`을 리다이렉트 stub으로 바꾼 시점에 고아가 됐다 |
| `public/miniapps/backyard/rpg-style.css` | 4,313B | 2D RPG 페이지 스타일시트. 참조는 `rpg2d-legacy.html`·`rpg-lifecycle.mjs`(함께 삭제) |

## 삭제 — 배포물에 실리지 않던 것 (13개, raw 8,283,976B)

| 파일 | 크기 | 판정 근거 |
|---|---:|---|
| `apps/web/types/phaser/phaser.d.ts` | 8,027,788B | Phaser 타입 선언. `tsconfig.miniapps-dom.json`의 `include`에서 함께 뺐다. **Tailwind v4가 이 파일을 클래스 후보로 스캔해 죽은 CSS 1,387B를 방출하고 있었다** — [tailwind-dead-css.txt](tailwind-dead-css.txt) |
| `apps/web/types/phaser/matter.d.ts` | 198,419B | 위와 함께 딸려온 물리 엔진 타입 |
| `apps/web/types/phaser/README.md` | 586B | 위 두 파일의 취득 안내 |
| `src/components/miniapp/backyard-viewport.tsx` | 3,757B | 2D 카드 뷰포트(520px 상한). **참조 0** — 등록부가 `execution:"backyard"`로 바뀌어 전체 화면 `BackyardGame`이 직접 렌더된다. 설계서 §1이 "현재 화면 제한"의 근거로 인용했던 그 파일이다 |
| `src/lib/game-backyard-input.test.ts` | 4,365B (9 tests) | 검증 대상 `input.js`·`renderer.js`가 사라진다 |
| `src/lib/game-backyard-lifecycle.test.ts` | 9,917B (4 tests) | 검증 대상 `app.js`(v0 2D 호스트)가 사라진다 |
| `src/lib/game-backyard-rpg-lifecycle.test.ts` | 2,857B (1 pass + 1 skip) | 두 시험 모두 2D 수명이다. `it.skip` 쪽은 슬라이스 8로 이관됐던 2D iframe 호스트 시험이고 대상이 사라진다. 통과 쪽은 Phaser 리스너 +40 특성 기록이며 **그 발견은 [`rpg-s91011-report.md`](../../rpg-s91011-report.md)에 문서로 남아 있다** |
| `scripts/verify-backyard/rpg2d-legacy.html` | 3,735B | 2D 레거시 페이지. 지시서 명시 |
| `scripts/verify-backyard/rpg-lifecycle.mjs` | 5,145B | 2D 동일문서 Phaser 수명 하네스(`--characterize`로 +40을 재던 것) |
| `scripts/verify-backyard/rpg-lifecycle.js` | 5,032B | 위 하네스의 브라우저 계측기 |
| `scripts/verify-backyard/rpg-host-lifecycle.mjs` | 9,584B | 2D iframe 호스트 20회 수명 하네스. `rpg-engine.js`·`iframe #world`를 대상으로 한다 |
| `scripts/verify-backyard/lifecycle.js` | 3,687B | v0 2D 수명 계측기 |
| `scripts/verify-backyard/export.mjs` | 9,104B | 위 계측기를 로드하는 v0 2D export E2E. 계측기가 없으면 실행 자체가 불가 |

## 유지 — 지우면 깨지는 것

| 파일 | 유지 근거 |
|---|---|
| `public/miniapps/backyard/rpg-input.js` | **3D가 런타임에 로드한다.** `backyard-game.tsx` `loadEngine`의 마지막에서 두 번째 항목(`backyard/rpg-input.js`). 지시서가 "3D가 쓰는지 확인하라"고 지목한 파일이며 답은 쓴다 |
| `public/miniapps/backyard/index.html` | 기존 URL 호환 리다이렉트(334B, 스크립트·CSS 0). `rpg3d-s567.mjs`가 실루엣 판을 그릴 빈 호스트 페이지로 사용하고, `artifact.py`가 entry로 파싱한다. **남긴다** |
| `public/miniapps/backyard/balance.js`·`rules.js`·`codec.js` | garden 이주 사슬. `rpg-codec.js:76`의 `BackyardCodec.createCodec().deserializeGarden(raw)` → `codec.js:12-13`의 `BackyardRules`·`BackyardBalance`. 세 파일 모두 `loadEngine` 목록에 있다. 지우면 v0 마당을 가진 가구의 이주가 깨진다 |
| `public/miniapps/backyard/rpg-rules.js`·`rpg-codec.js`·`rpg-session.js` | 3D 런타임 본체이자 롤백 근거(§10). 건드리지 않았다 |
| `public/miniapps/bridge.js` | iframe 미니앱(`execution:"iframe"`)의 범용 브릿지. 등록부에 현재 iframe 미니앱이 없지만 호스트 경로(`miniapp-host.tsx`)와 테스트(`miniapp-host.test.ts`·`miniapp-client.test.ts` 38 tests)가 살아 있다. 뒷마당 2D 표현이 아니다 |
| `scripts/verify-sandbox-engine/**` | 엔진 선정 조사 산출물(`docs/verify-sandbox-engine-2026-09.md`). **자체 `vendor/phaser.min.js` 사본**을 갖고 있어 이번 삭제와 무관하다 |

## 유지 — 판정이 갈린 것 (코디네이터 확인 요청)

### `public/miniapps/backyard/session.js` (9,404B raw / 약 2.9KB zip)

**런타임에 로드되지 않는다.** `loadEngine` 목록에 없고, 유일한 런타임 소비자였던
`app.js`를 이번에 지웠다. 즉 배포물에 실리지만 실행되지 않는 파일이다.

그런데도 남긴 이유:

1. 지시서가 **"규칙·codec·session 테스트는 3D도 쓰므로 남는다"**고 명시했다.
   `game-backyard-session.test.ts`(29 tests)·`game-backyard-integration.test.ts`(2)·
   `game-backyard-codec.test.ts`(45)·`game-backyard.test.ts`(15)가 모두
   `game-backyard-test-utils.ts`의 `loadBackyard()`를 통해 **실제 배포 파일 4개
   (balance·rules·codec·session)를 VM에서 함께 실행**한다. `session.js`를 지우면
   그 91개 테스트가 전부 죽는다.
2. `session.js`는 DOM·Phaser 참조 0의 순수 로직이며 **"2D 표현"이 아니다**.
3. ZIP 기여가 약 2.9KB로 이번 측정의 목표(Phaser 354KB)와 무관하다.

**지시서의 두 문장이 충돌한다** — "v0 잔존 … session.js … 필요한 것만 남겨라"와
"session 테스트는 남는다". 두 문장을 동시에 만족시키는 유일한 읽기가 "파일을 남긴다"이므로
그렇게 했다. **런타임 dead code를 배포물에서 빼는 편이 낫다면 `session.js` + 위 4개
테스트 파일의 `loadBackyard` 경로를 함께 정리해야 하며, 그것은 이번 판정 밖이다.**

## 유지 — 이미 실행 불가였던 2D 하네스 (이번에 지우지 않음)

아래는 슬라이스 2·3에서 iframe 라우트(`iframe >> #world[data-ready=true]`)가 사라진
시점부터 **이미 실행 불가**였다. 지시서가 지목한 것은 "2D 수명 하네스"이므로 범위를
넓히지 않고 과거 슬라이스 증거의 출처로 남겼다. 상태는 README에 적었다.

| 파일 | 상태 |
|---|---|
| `scripts/verify-backyard/rpg-export.mjs` | 2D iframe E2E. `**/vendor/phaser.min.js` route abort 한 줄이 존재하지 않는 파일을 가리킨다(요청이 없으므로 무해) |
| `scripts/verify-backyard/rpg-s45.mjs`·`rpg-s678.mjs` | 2D iframe 슬라이스 E2E |
| `scripts/verify-backyard/rpg3d-s1.mjs` | 3D fixture 검사는 유효하나 **2D 비교 분기**(`#world` 대기)는 실행 불가 |
| `scripts/verify-backyard/index.html`·`server.py` | v0 sandbox iframe 하네스 |
| `scripts/verify-backyard/artifact.py` | 실행 가능하나 `baselineRawBytes`·`baselineZipBytes`가 v0 시절 값이라 증가율 필드는 참고값이다 |
