# 구현 보고 — 3D 슬라이스 9: 2D를 걷어내고 OTA를 실측했다 (2026-09-08)

> 지시서: [`rpg3d-s9-brief.md`](rpg3d-s9-brief.md) · 설계서: [`redesign-backyard-3d.md`](redesign-backyard-3d.md)
> 증거: `docs/evidence/rpg3d-s9/` · **커밋하지 않았다. 배포하지 않았다.**

## 한 줄 요약

**21개 파일(raw 9,727,481B)을 지웠고, 같은 배포 방식으로 만든 OTA ZIP이
1,784,810B → 1,405,713B(−379,097B)로 줄었다.** 2D 시절 마지막 배포 1,570,734B와
비교해도 **−165,021B(−10.51%)**이므로 설계서 §10의 "예상 OTA 절감 없음" 실패
조건은 발동하지 않는다. 3D가 쓴 5키를 배포 codec 원본이 그대로 왕복한다.

## 1. 무엇을 지웠나 — 파일별 판정

전체 판정 표와 근거는 [`deletion-decisions.md`](evidence/rpg3d-s9/deletion-decisions.md)에 있다.
여기엔 결론만 적는다. **참조 조사는 문서·과거 증거 JSON의 언급을 참조로 세지 않았다** —
그것은 기록이며 코드가 부르는 것이 아니다.

### 배포물에 실리던 8개 (raw 1,443,505B)

`vendor/phaser.min.js`(1,375,976B) · `vendor/PHASER-LICENSE.md` ·
`backyard/rpg-engine.js`(42,411B) · `renderer.js` · `input.js` · `app.js` ·
`style.css` · `rpg-style.css`

### 배포물에 실리지 않던 13개 (raw 8,283,976B)

`types/phaser/{phaser.d.ts(7.7MB),matter.d.ts,README.md}` ·
`components/miniapp/backyard-viewport.tsx` · 테스트 3개 ·
`scripts/verify-backyard/{rpg2d-legacy.html,rpg-lifecycle.mjs,rpg-lifecycle.js,rpg-host-lifecycle.mjs,lifecycle.js,export.mjs}`

### 지시서가 지목한 세 판정의 답

- **`rpg-input.js`는 3D가 쓴다.** `backyard-game.tsx`의 `loadEngine` 목록에 있고,
  실제 라우트 네트워크 기록에도 `/miniapps/backyard/rpg-input.js` 요청이 남는다.
  `input.js`(v0 2D)와 **다른 파일**이며 그쪽만 지웠다.
- **`balance.js`·`rules.js`·`codec.js`는 남는다.** `rpg-codec.js:76`의
  `BackyardCodec.createCodec().deserializeGarden(raw)`가 garden 이주에 쓰고,
  `codec.js:12-13`이 다시 `BackyardRules`·`BackyardBalance`를 부른다. 셋 다
  `loadEngine` 목록에 있다.
- **`index.html`(호환 페이지)은 남긴다.** 슬라이스 2·3이 334B 리다이렉트 stub으로
  바꿔 놨고 스크립트·CSS가 0이다. `rpg3d-s567.mjs`가 실루엣 판을 그릴 빈 호스트
  페이지로 쓰고 `artifact.py`가 entry로 파싱한다.

### `session.js`는 남겼다 — 판정이 갈린 유일한 파일

**런타임에 로드되지 않는다.** `loadEngine` 목록에 없고, 유일한 런타임 소비자였던
`app.js`를 이번에 지웠다. 실제 라우트 네트워크 기록에도 `session.js` 요청이 없다.
그래도 남긴 이유는 지시서가 "session 테스트는 남는다"를 명시했고, 그 테스트
91개(`game-backyard-{session,integration,codec}.test.ts`·`game-backyard.test.ts`)가
`loadBackyard()`로 **balance·rules·codec·session 배포 원본 4개를 VM에서 함께 실행**하기
때문이다. 지우면 91개가 전부 죽는다. ZIP 기여는 약 2.9KB다.

지시서의 두 문장("v0 잔존 … session.js … 필요한 것만 남겨라" / "session 테스트는
남는다")이 충돌하며, 동시에 만족시키는 유일한 읽기가 "파일을 남긴다"였다.
**런타임 dead code를 배포물에서 빼는 편이 낫다면 `session.js` + 그 4개 테스트의
`loadBackyard` 경로를 함께 정리해야 하고, 그것은 이번 판정 밖이다 — 코디네이터 결정.**

### 2D 롤백 경로를 왜 소스에 남기지 않았나

설계서 §10은 롤백을 두 경로로 갈랐다. **첫째** 개발 중 가설 실패 시 "전체 화면 셸은
살리고 마지막 정상 RPG 2D의 순수 규칙·codec·session과 Phaser 표현을 전체 화면에
연결하는 복귀 후보". **둘째** 출시 후 장애의 "이전 정상 OTA/웹 배포물로 되돌리기".

첫 경로는 `122c1ab`에서 **사용자 시각 승인이 나면서 닫혔다** — 3D가 2D보다 낫다는
판정을 받은 뒤에는 2D 표현으로 되돌릴 개발 중 사유가 없다. 둘째 경로는 배포물이
담당한다. `deploy-ota-bundle.sh`는 번들을 버전별 파일로 볼륨에 쌓고 manifest만
갈아끼우며, 새 번들이 부팅에 실패하면 `appReadyTimeout` + `notifyAppReady`로
**10초 뒤 이전 번들로 자동 롤백**한다. 즉 되돌릴 대상은 소스의 2D 파일이 아니라
이미 볼륨에 있는 이전 zip이다. 그래서 소스에 2D를 남길 이유가 없다.

**남은 확인 못 함**: 설계서 §10은 "그 배포물 ID·해시·실제 롤백 실행 가능 여부"를
슬라이스 9의 필수 확인 항목으로 지목했다. 이번에 **확인 못 함**이다 — 운영 스택에
쓰지 말라는 지시를 따라 `docker exec`으로 `/v1/ota/manifest`나 볼륨의 번들 목록을
조회하지 않았다. 코디네이터가 배포 시점에 확인해야 한다.

`it.skip`으로 슬라이스 8에 이관돼 있던 2D 호스트 수명 시험은 **대상(`iframe >>
#world[data-ready=true]`·`rpg-engine.js`)이 사라지므로 지웠다.** 같은 파일의 통과 쪽
시험이 기록하던 **Phaser 4.2.1 리스너 +40**(destroy가 `visibilitychange`·`wheel`을
정리하지 않는 upstream 결함) 발견은 [`rpg-s91011-report.md`](rpg-s91011-report.md)에
측정값·근거 링크와 함께 문서로 남아 있다. 지운 것은 하네스이고 발견은 남는다.

## 2. OTA 실측 — 이 슬라이스의 본체

측정 방법은 `deploy-ota-bundle.sh`와 **같다**: `( cd apps/web/out && zip -qr <path> . )`,
Info-ZIP 3.0(Apple) 기본 압축. 세 빌드 모두 `NEXT_PUBLIC_API_URL=https://app.subinary.cloud`
고정. 원시 데이터는 [`ota-before.json`](evidence/rpg3d-s9/ota-before.json) ·
[`ota-before-repeat.json`](evidence/rpg3d-s9/ota-before-repeat.json) ·
[`ota-after.json`](evidence/rpg3d-s9/ota-after.json)(엔트리별 raw·compress_size),
분해는 [`zip-decomposition.txt`](evidence/rpg3d-s9/zip-decomposition.txt)다.

| 빌드 | 파일 | raw | ZIP |
|---|---:|---:|---:|
| 제거 **전**(Phaser+Three 둘 다) | 343 | 6,293,652B | **1,784,810B** |
| 같은 소스 재빌드(노이즈 측정) | 343 | 6,293,652B | 1,784,406B |
| 제거 **후**(Three만) | 335 | 4,848,781B | **1,405,713B** |

- **제거 전→후 ZIP −379,097B (−21.24%)**, raw −1,444,871B
- **빌드 노이즈 −404B** — 같은 소스를 두 번 빌드하면 raw는 바이트까지 같은데 ZIP이
  404B 흔들린다. Next `buildId`가 빌드마다 바뀌어 청크 디렉터리 이름과 `__next`
  프리페치 txt 안의 문자열이 달라지기 때문이다. 측정한 감소량은 이 노이즈의
  **938배**이므로 결론이 노이즈에 좌우되지 않는다.
- 2D 시절 마지막 배포 **1,570,734B 대비 −165,021B (−10.51%)**. 설계서 §10의 실패
  조건("동일 배포 방식 ZIP이 1,570,734B보다 큼")은 발동하지 않는다.

### 예상 205,394B와 실제의 차이

설계서 §1은 **ZIP 엔진 압축분 차이 205,394B 감소**를 예상했다. 실측:

| 항목 | raw | ZIP 압축분 |
|---|---:|---:|
| Phaser + 라이선스 (빠짐) | 1,377,096B | 355,149B |
| Three + 라이선스 (들어옴) | 604,526B | 149,817B |
| **엔진 단독 차** | 772,570B | **205,332B** |

**설계 예상 205,394B, 실측 205,332B — 차이 62B(0.03%).** 설계서의 메모리 `zipfile`
level 6 추정이 실제 Info-ZIP과 사실상 일치했다.

그런데 두 개의 다른 질문이 있고 답이 다르다.

**(가) 제거 전→후 −379,097B는 왜 예상보다 큰가.** 이번에 빠진 것이 Phaser만이
아니기 때문이다. Three는 이미 "전" 빌드에 들어 있었으므로 이 비교에서 상쇄가 아니다.

| 빠진 것 | ZIP |
|---|---:|
| Phaser + 라이선스 | −355,149B |
| 2D 게임 코드 6개(rpg-engine·renderer·input·app·style·rpg-style) | −21,989B |
| 전역 CSS 청크 축소 | −234B |
| buildId 문자열 변화(176개 프리페치 txt) | −262B |
| `rpg3d-world.js` 머리주석 정정 | +21B |
| ZIP 컨테이너 오버헤드(엔트리 343→335) | −1,484B |
| **합계** | **−379,097B** |

**(나) 2D 배포 1,570,734B → 1,405,713B가 −165,021B로 예상 205,394B보다 40,373B
적은 이유.** 여기서는 Three와 3D 게임 코드가 상쇄로 들어온다.

| 항목 | ZIP |
|---|---:|
| Phaser + 라이선스 + 2D 게임 코드 6개 (빠짐) | −377,138B |
| Three + 라이선스 (들어옴) | +149,817B |
| 3D 게임 코드 8개(rpg3d-models·scene·world·controller·terrain·fixture 3종) | +32,913B |
| 잔차 — 웹 앱 청크·CSS·프리페치·컨테이너 차 | +29,387B |
| **합계** | **−165,021B** |

잔차 +29,387B는 위 세 항목을 실측 합계에서 뺀 **차감값**이다. 2D 배포물을 오늘
툴체인으로 재빌드하지 못했으므로(아래) 그 안에서 웹 청크와 CSS를 따로 가르지는
못했다.

지시서가 예고한 "게임 코드가 늘었으니 상쇄가 있다"가 그대로 나타났다 —
**2D 게임 코드 21,989B가 빠지고 3D 게임 코드 32,913B가 들어와 순증 10,924B**이며,
여기에 웹 앱 청크 증가(전체 화면 HUD·패널·꾸미기 편집기가 `backyard-game.tsx`로
들어왔다)가 얹혀 40,373B의 차이를 만든다.

**기능을 빼거나 CDN으로 옮겨 수치를 낮추지 않았다.** 실제 라우트 네트워크 기록이
같은 origin 34건 + 격리된 운영 API 9건 전부이며 CDN·외부 에셋 요청은 0이다(아래 §3).

### 곁가지로 나온 것 — Tailwind가 Phaser를 스캔하고 있었다

전역 CSS 청크가 66,553B → 65,166B로 줄었다. 사라진 유틸리티 15개는
`.container`·`.grayscale`·`.italic`·`.zoom-in` 같은 **남은 소스 어디에서도 쓰지 않는
것들**이었다. 전부 삭제한 `types/phaser/phaser.d.ts`(7.7MB)와 `phaser.min.js` 안에
문자열로 존재한다 — Tailwind v4의 클래스 후보 스캔이 이 두 파일을 훑어 죽은 CSS
1,387B를 방출하고 있었다. 근거:
[`tailwind-dead-css.txt`](evidence/rpg3d-s9/tailwind-dead-css.txt).

### 확인 못 함 — 2D 배포물 재빌드

1,570,734B는 **다른 날·다른 시점에 측정된 값**이다. 오늘의 툴체인으로 그 트리를 다시
빌드해 비교하려고 `cee9bfa^`(=`bee676d`) worktree를 만들었으나 Turbopack이 프로젝트
루트 밖을 가리키는 `node_modules` 심볼릭 링크를 거부했고, worktree 안에서 별도
`pnpm install`을 하는 것은 공유 store·락파일을 건드릴 위험이 있어 중단했다.
그래서 **2D 배포물의 오늘 툴체인 재측정은 확인 못 함**이다. 다만 오늘 측정한 노이즈
±404B에 비해 마진이 165,021B(408배)이므로 §10 판정 자체는 툴체인 드리프트로 뒤집히지
않는다. 두 커밋 사이의 의존성 변화는 devDependency `@types/three` 하나뿐(런타임 영향
없음)임을 `git diff`로 확인했다.

## 3. 전체 회귀

| 게이트 | 결과 | 로그 |
|---|---|---|
| `@family/shared test` | **16 files · 189 passed** | [shared-tests.txt](evidence/rpg3d-s9/shared-tests.txt) |
| 관련 web vitest | **15 files · 245 passed · 0 skipped** (기준선 18 files · 259 passed · 1 skipped) | [tests-after.txt](evidence/rpg3d-s9/tests-after.txt) |
| **전체** web vitest | **33 files · 450 passed** — 실패 0 | [all-web-tests.txt](evidence/rpg3d-s9/all-web-tests.txt) |
| `turbo run build --filter=./packages/* --force` | **9/9 성공, Cached 0/9** (FULL TURBO 아님) | [packages-build.txt](evidence/rpg3d-s9/packages-build.txt) |
| `@family/web typecheck` | 통과 | [web-typecheck.txt](evidence/rpg3d-s9/web-typecheck.txt) |
| `tsc -p tsconfig.miniapps-rules.json` | 통과 | [rules-types.txt](evidence/rpg3d-s9/rules-types.txt) |
| `tsc -p tsconfig.miniapps-dom.json` | 통과 (`types/phaser/phaser.d.ts`를 include에서 제거) | [dom-types.txt](evidence/rpg3d-s9/dom-types.txt) |
| `build:mobile` | 통과(정적 export 335 파일) | [build-mobile.txt](evidence/rpg3d-s9/build-mobile.txt) |
| `node scripts/verify-backyard/rpg3d-s567.mjs` | **통과 — 검사 16건, 콘솔·페이지 오류 0** (Phaser 삭제 후 재실행) | [rpg3d-s567-e2e.txt](evidence/rpg3d-s9/rpg3d-s567-e2e.txt) |

`rpg3d-s567.mjs`는 실행하면 `docs/evidence/rpg3d-s567/`의 스크린샷과 `results.json`을
다시 쓴다. 그것은 **직전 슬라이스의 커밋된 증거**이므로 재실행 뒤 `git checkout`으로
되돌렸다. 이번 통과 사실은 stdout 로그로 남긴다.
| `node scripts/verify-backyard/rpg3d-s9.mjs` (신규) | **통과 — 검사 6건** | [rpg3d-s9-stdout.txt](evidence/rpg3d-s9/rpg3d-s9-stdout.txt) · [results.json](evidence/rpg3d-s9/results.json) |

### 테스트 수 차이 14개는 전부 삭제한 3개 파일의 것이다

**기존 테스트 실패는 0이다.** 259 → 245는 회귀가 아니라 삭제다. 실행 전
[per-file 기준선](evidence/rpg3d-s9/tests-before.txt)을 남기고 대조했다.

| 사라진 파일 | 통과 | 스킵 |
|---|---:|---:|
| `game-backyard-input.test.ts` | 9 | 0 |
| `game-backyard-lifecycle.test.ts` | 4 | 0 |
| `game-backyard-rpg-lifecycle.test.ts` | 1 | 1 |
| 합계 | **14** | **1** |

259 − 14 = 245, 스킵 1 − 1 = 0. **남은 15개 파일의 통과 수는 기준선과 한 건도
다르지 않다.** 전체 web은 33 files · 450 passed · 실패 0이다 — 삭제 **전** 전체 web
수치는 측정하지 않았으므로(관련 범위만 per-file 기준선을 남겼다) 464라는 값을
실측으로 쓰지 않는다.

### `out` 검증 — 새 하네스 `rpg3d-s9.mjs`

기존 `rpg3d-s567.mjs`는 `/v1/**` 요청만 기록하므로 "CDN 요청 0 · 이미지 에셋 0 ·
Phaser 동봉 0"을 판정할 수 없다. 그래서 [`rpg3d-s9.mjs`](../scripts/verify-backyard/rpg3d-s9.mjs)를
새로 만들어 요청을 **전부** 기록한다.

| 검사 | 실측 |
|---|---|
| `out` entry | `index.html` · `play/index.html` · `play/app/index.html` 존재 |
| public ↔ out 바이트 일치 | `miniapps/` **20개 파일 목록·바이트·SHA-256 양방향 일치**. out에만 있는 파일 0 |
| **Phaser 동봉 0** | 파일명 0건 + `out` 335개 파일 전체 내용에서 `phaser.min.js`·`Phaser.Game`·`Phaser.Scene`·`Phaser.VERSION` **0건** |
| **이미지 에셋 0** | `miniapps/`에 png/jpg/webp/svg/hdr/ktx2/glb/gltf/오디오 **0개**. 실제 라우트에서도 image·media·font 리소스 요청 **0건** |
| **CDN 요청 0** | 총 43건 = 같은 origin 34건(document 1·stylesheet 2·script 31) + 운영 API 9건. **API 9건은 전부 Playwright route가 가로채 로컬에서 fulfill**했고(운영 서버로 나가지 않음), 그 밖의 외부 요청 0. 실패 요청 0 |
| 로드된 게임 스크립트 11개 | `three-r128.min.js` · `balance` · `rules` · `codec` · `rpg-rules` · `rpg-codec` · `rpg-session` · `rpg3d-terrain` · `rpg3d-controller` · `rpg3d-models` · `rpg3d-world` · `rpg3d-scene` · `rpg-input` — **`session.js` 요청 없음**(런타임 dead 확인) |

정적 export가 빌드 시 `NEXT_PUBLIC_API_URL`을 인라인하므로 `/v1/**`만 같은 origin이
아니다. 그 9건이 **전부** fixture에 가로채였음을 route 기록과 request 기록의 집합
비교로 단언한다 — 하나라도 빠지면 운영으로 나갔다는 뜻이므로 실패로 처리한다.

## 4. 저장 호환 — 롤백의 근거

설계서 §10: "v2/mapVersion 1을 그대로 쓰므로 2D가 같은 저장을 읽을 수 있다는 것이
복귀 설계의 근거이고, **실제 왕복 fixture로 확인해야 한다.**"

`rpg3d-s9.mjs`가 실제 라우트에서 3D를 걷게 해 5키를 PUT받고, 그 값을 **배포 codec
원본**(`balance`→`rules`→`codec`→`rpg-rules`→`rpg-codec`를 Node VM에서 실행)으로 다시
읽는다. `rpg-codec.js`는 2D가 쓰던 것과 같은 파일이며 **이번 삭제에서 한 줄도
바꾸지 않았다** — 그래서 이 왕복이 §10의 근거다.

| 확인 | 실측 |
|---|---|
| 3D가 쓴 키 | `rpg_meta`·`rpg_world`·`rpg_collection`·`rpg_residents`·`rpg_player` — codec의 `keys`와 정확히 일치 |
| PUT 순서 | world → collection → residents → player → meta. **`rpg_meta`가 마지막** |
| 왕복 | 5키 전부 `decode` → `ok`, 다시 `decode` → `ok`, `JSON.stringify` 원본과 **바이트 일치** |
| `mapVersion` | `rpg_meta.mapVersion=1`, `rpg_player.mapVersion=1` |
| DTO 버전 | 5키 전부 `v=2` |
| 좌표 범위 | 저장 `x=121`(0~511) · `y=302`(0~383). 화면 논리 좌표는 `x=241.6 y=604.8`(1024×768)이며 **저장은 절반 해상도 정수**라는 기존 계약 그대로. 걷는 시간이 프레임에 좌우되므로 x는 회차마다 1 정도 달라진다(두 회차 120·121) — 검사는 값이 아니라 **범위와 "초기값이 아님"**을 단언한다 |
| 초기값 아님 | `initial().rpg_player`와 다른 좌표 — 실제로 걷고 저장한 값이다 |
| garden 무변형 | v1 garden raw를 `migrate()`에 넣어 `ok`를 받은 뒤 **입력 객체의 `JSON.stringify`가 호출 전과 동일**. `migrated=true`·`mapVersion=1` |
| 역마이그레이션 없음 | codec `keys`에 `garden` 없음, 3D가 쓴 키에 `garden` 없음 — **garden·rpg 5키를 지우거나 역마이그레이션하지 않았다** |

원시 값은 [results.json](evidence/rpg3d-s9/results.json)의 `saveCompat`에 있다.

**한계**: 이 왕복이 증명하는 것은 "2D가 쓰던 codec이 3D의 저장을 읽는다"다. 2D
**표현**을 실제로 붙여 화면에 그려 본 것이 아니다(그 표현은 소스에서 제거됐고,
복귀 경로는 이전 배포물 되돌리기다 — §1). 실제 API·DB 왕복도 이번 범위가 아니며
격리 fixture다.

## 5. 확인 못 함

- **실기기는 이번이 아니다.** 위 모든 브라우저 측정은 macOS 데스크톱 Chromium
  149.0.7827.55다. 슬라이스 8의 실기기 p95/p99·20회 진입 수명·context loss는
  **확인 못 함**이며 사람이 기기를 들고 해야 한다.
- **이전 정상 배포물의 ID·해시·실제 롤백 실행 가능 여부 — 확인 못 함.** 설계서
  §10이 슬라이스 9 필수 항목으로 지목했지만 운영 스택 조회가 금지돼 있어 하지
  않았다. 코디네이터가 배포 시점에 `/v1/ota/manifest`와 `ota-bundles` 볼륨의 번들
  목록으로 확인해야 한다.
- **2D 배포물의 오늘 툴체인 재측정 — 확인 못 함**(§2 마지막 단락의 이유).
- **시각 승인은 이번에 다시 받지 않았다.** `122c1ab`의 승인을 그대로 인용한다.
- 삭제한 2D iframe 하네스가 재현하던 과거 슬라이스 증거는 **다시 만들 수 없다.**
  이미 실행 불가였던 하네스(`rpg-export.mjs`·`rpg-s45.mjs`·`rpg-s678.mjs`·
  `rpg3d-s1.mjs`의 2D 비교 분기·`index.html`+`server.py`)는 이번에 지우지 않고
  상태만 README에 적었다.

## 6. 남은 결정 — 코디네이터

1. **`session.js`를 배포물에서 뺄지.** 런타임 dead이지만 91개 테스트가 배포 원본을
   VM에서 읽는다. 빼려면 `game-backyard-{session,integration,codec}.test.ts`·
   `game-backyard.test.ts`의 `loadBackyard` 경로를 함께 정리해야 한다(§1).
2. **이미 실행 불가인 2D E2E 하네스 5개를 지울지.** 이번에는 지시서가 지목한 "2D
   수명 하네스"만 지웠다(§5).
3. `artifact.py`의 `baselineRawBytes`/`baselineZipBytes`가 v0 시절 값이다. 이번 실측
   값(4,848,781 / 1,405,713)으로 갱신할지.
4. 슬라이스 5·6·7이 남긴 시각 결정 2건(수관 가림이 줄기만 남기는 문제, 화면 상단이
   비는 구도)은 이번에 손대지 않았다.

## 7. 변경 파일

```
삭제 (21)
  apps/web/public/miniapps/vendor/phaser.min.js
  apps/web/public/miniapps/vendor/PHASER-LICENSE.md
  apps/web/public/miniapps/backyard/{rpg-engine.js,renderer.js,input.js,app.js,style.css,rpg-style.css}
  apps/web/types/phaser/{phaser.d.ts,matter.d.ts,README.md}
  apps/web/src/components/miniapp/backyard-viewport.tsx
  apps/web/src/lib/{game-backyard-input,game-backyard-lifecycle,game-backyard-rpg-lifecycle}.test.ts
  scripts/verify-backyard/{rpg2d-legacy.html,rpg-lifecycle.mjs,rpg-lifecycle.js,rpg-host-lifecycle.mjs,lifecycle.js,export.mjs}

수정 (3)
  apps/web/tsconfig.miniapps-dom.json          — include 에서 types/phaser/phaser.d.ts 제거
  apps/web/public/miniapps/backyard/rpg3d-world.js — 머리주석의 rpg-engine.js 언급을 "삭제된"으로 정정
  scripts/verify-backyard/README.md            — 삭제한 하네스 절을 현재 3D 재현 절차로 교체

추가 (2 + 증거)
  scripts/verify-backyard/rpg3d-s9.mjs
  docs/rpg3d-s9-report.md
  docs/evidence/rpg3d-s9/
```

**커밋하지 않았다.** 기준 커밋은 `b5040f6`이다. 배포·운영 스택 변경도 없다.
