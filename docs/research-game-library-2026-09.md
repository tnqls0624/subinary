# 웹 게임 라이브러리 선정 조사

조사일: 2026-09-05. 대상: 가계부 앱의 격리된 iframe에서 실행하는 배치·수집·성장 중심 생활 시뮬레이션. 지시서: `docs/research-game-library-brief.md`.

## 결론

**추천은 Phaser 4.2.1, 차선은 Excalibur 0.32.0이다.** Phaser는 단일 스크립트 배포, 타일맵, 터치 드래그, 애니메이션과 씬을 함께 제공하므로 게임의 핵심인 배치와 성장 규칙에 집중하기 좋다. Excalibur는 더 작은 배포물에 격자·아이소메트릭 기능을 제공하지만, Tiled 파일을 이용하면 별도 플러그인을 관리해야 한다. 아래 추천은 문서·배포물 조사에 따른 판단이며, 실제 Capacitor WebView와 지정 sandbox에서의 실행은 **확인 못 함**이다.

모든 후보의 저장은 게임 상태만 담은 JSON을 부모에게 보내는 방식으로 설계할 수 있다. 가장 먼저 검증할 항목은 엔진 성능보다 **불투명 출처인 iframe에서 정적 이미지와 JSON을 읽는 경로**다. 같은 앱에 포함한 파일도 sandbox 내부에서는 일반적인 동일 출처 자산으로 간주할 수 없다. [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [MDN CORS 이미지](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image)

## 조사 방법과 수치의 의미

- 후보는 필수 5개로 한정했다. 공식 문서, GitHub 릴리스·커밋·공개 댓글, npm의 `latest` 태그, 해당 버전의 jsDelivr 배포물을 조회했다.
- 라이브러리를 설치하거나 게임·측정 프로그램을 작성하지 않았다. 배포 파일을 `/tmp`에 내려받아 실행하지 않고 바이트 수와 압축 크기만 측정했다.
- gzip은 **원본 배포 파일을 macOS의 `gzip -9 -n -c`로 압축한 결과**다. HTTP 응답의 압축률이나 Bundlephobia의 번들링 결과가 아니다. 파일명·버전·SHA-256을 아래에 남겨 재현할 수 있게 했다.
- 단위는 B와 KiB(1,024 B). 에셋, 게임 로직, 별도 플러그인, 소스맵은 제외했다. 앱 설치 용량·압축 전 파싱 비용·GPU 메모리와 gzip 크기는 서로 다르다.
- 유지보수 평가는 최신 기본 브랜치 커밋과 공개 댓글 표본을 근거로 했다. 전체 커밋 빈도 통계, 평균 이슈 응답 시간과 해결 SLA는 **확인 못 함**이다.

## 1. 안정 버전·배포·라이선스

| 후보 | 확인한 최신 안정 버전 | 마지막 안정 릴리스 | 브라우저 단일 파일 | 원본 B | gzip B / KiB | 라이선스 |
|---|---|---|---|---:|---:|---|
| Phaser | 4.2.1 | 2026-07-09 | UMD, `dist/phaser.min.js` | 1,375,976 | 352,441 / 344.2 | MIT |
| PixiJS | 8.20.1 | 2026-08-26 | IIFE, `dist/pixi.min.js` | 818,871 | 230,745 / 225.3 | MIT |
| KAPLAY | 3001.0.19 | 2025-06-15 | IIFE, `dist/kaplay.js` (이미 축소된 파일) | 189,085 | 69,732 / 68.1 | MIT |
| Excalibur | 0.32.0 | 2025-12-23 | UMD, `build/dist/excalibur.min.js` | 573,827 | 147,212 / 143.8 | BSD-2-Clause |
| melonJS | 20.3.0 | 2026-08-31 | **현재 npm 배포에 UMD/IIFE 없음**. ESM `build/index.js` 제공 | 2,137,907 | 516,190 / 504.1 | MIT |

버전·날짜 출처:

- Phaser: [공식 4.2.1 다운로드·릴리스 날짜](https://phaser.io/download/release/v4.2.1), [npm latest](https://registry.npmjs.org/phaser/latest).
- PixiJS: [공식 릴리스](https://github.com/pixijs/pixijs/releases/tag/v8.20.1), [npm latest](https://registry.npmjs.org/pixi.js/latest).
- KAPLAY: [안정 릴리스](https://github.com/kaplayjs/kaplay/releases/tag/3001.0.19), [npm latest](https://registry.npmjs.org/kaplay/latest). GitHub Releases의 Latest는 `4000.0.0-alpha.27.1`(2026-05-12)로 표시되지만 **알파이므로 안정 후보에서 제외**했다. [전체 릴리스](https://github.com/kaplayjs/kaplay/releases)
- Excalibur: [공식 릴리스](https://github.com/excaliburjs/Excalibur/releases/tag/v0.32.0), [npm latest](https://registry.npmjs.org/excalibur/latest).
- melonJS: [공식 릴리스](https://github.com/melonjs/melonJS/releases/tag/v20.3.0), [npm latest](https://registry.npmjs.org/melonjs/latest). 배포 파일 목록에서 실행 가능한 `.js`는 `build/index.js` 한 개를 확인했다. [20.3.0 전체 파일 목록](https://data.jsdelivr.com/v1/package/npm/melonjs@20.3.0/flat)

라이선스는 각 npm 메타데이터의 `license`를 확인했다. 게임 이미지·폰트·음악·추가 플러그인의 라이선스까지 포함하는 의미는 아니다.

### 크기 측정에 사용한 실제 CDN 파일

| 후보 | 버전 고정 URL | 원본 SHA-256 |
|---|---|---|
| Phaser | [phaser.min.js](https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.min.js) | `66348b1b5141e49b7d5ebbe688cddcb502eab1cb00f21c538686a5b2c5abe4de` |
| PixiJS | [pixi.min.js](https://cdn.jsdelivr.net/npm/pixi.js@8.20.1/dist/pixi.min.js) | `9948591083793305468d73915a3ea85032dcf8e32eee7a1328585050d7a14d53` |
| KAPLAY | [kaplay.js](https://cdn.jsdelivr.net/npm/kaplay@3001.0.19/dist/kaplay.js) | `88a946eafc4161f83505449d830b87c7bc15822bb0dae8ce03b2437506ef4a4b` |
| Excalibur | [excalibur.min.js](https://cdn.jsdelivr.net/npm/excalibur@0.32.0/build/dist/excalibur.min.js) | `fda7652d4b3f6abd00326874518186459f1889ac285568667c985f0e354319d5` |
| melonJS | [index.js](https://cdn.jsdelivr.net/npm/melonjs@20.3.0/build/index.js) | `6bd00b46d45d845b924e6160784a67db1d045197f2cea66b295cc447b807a4c2` |

melonJS는 비축소 ESM 배포물이라 다른 후보의 축소 파일과 동일한 최적화 수준은 아니다. **직접 배포할 수 있는 제공 파일** 기준으로 비교했으며, 별도 minify·tree-shaking 후 크기는 **확인 못 함**이다. 오래된 melonJS의 경량 크기 홍보를 최신판 수치로 대체하지 않았다.

## 2. 유지보수 관찰

날짜는 GitHub API의 UTC 날짜다. 표의 댓글은 저장소 최근 댓글 10개에서 사람의 응답을 골랐다. PR 댓글과 이슈 댓글은 구분했으며, 한 사례로 응답 속도를 일반화하지 않았다.

| 후보 | 기본 브랜치 최신 커밋 | 이슈 응답 근거 | 해석 |
|---|---|---|---|
| Phaser | [2026-08-21, 4.3 changelog 준비](https://github.com/phaserjs/phaser/commit/02d8931b626d9764c133cbb3fbf99966c03c757c) | [2026-06-29, photonstorm의 타입 질문 답변](https://github.com/phaserjs/phaser/issues/7325#issuecomment-4837193541); 8월 PR에서도 기여자 토론 확인 | 릴리스와 개발 지속. 최근 표본의 핵심 유지보수자 이슈 응답은 다른 후보보다 오래됐으며 빠른 응답 보장은 못 함 |
| PixiJS | [2026-09-03, renderer loader 개선](https://github.com/pixijs/pixijs/commit/d3a17517b3e2cac837df1239f9d1923d4ca12a21) | [2026-09-01, Zyie의 수정 버전 안내](https://github.com/pixijs/pixijs/issues/11247#issuecomment-5499480170) | 최근 안정 릴리스와 기능 작업·응답 모두 확인, 활발 |
| KAPLAY | [2026-09-02, PR 템플릿 정리](https://github.com/kaplayjs/kaplay/commit/999e055a6c8c4358568457881805a8d9ba1f1ef2) | [2026-09-05, lajbel 응답](https://github.com/kaplayjs/kaplay/issues/421#issuecomment-5551830916), [9월 2일 PR 응답](https://github.com/kaplayjs/kaplay/pull/1121#issuecomment-5511695410) | 프로젝트는 활동 중이나 안정판 공백이 김. 최신 커밋은 기능 구현이 아닌 관리 작업임 |
| Excalibur | [2026-09-03, v1 폐기 예정 API 정리](https://github.com/excaliburjs/Excalibur/commit/3510366a4c1b2874b424b0babaf0ebe59a9d8e2e) | [2026-09-03, eonarheim의 구현 완료 안내](https://github.com/excaliburjs/Excalibur/issues/3084#issuecomment-5518712018) | 안정판 간격은 길지만 개발·응답은 활동 중. 앞으로의 메이저 전환 비용 고려 |
| melonJS | [2026-09-05, 거리 안개 수정](https://github.com/melonjs/melonJS/commit/23f524a612001e4becd50d9f14bf6676c594c8ca) | [2026-09-05, obiot의 level.load 분석](https://github.com/melonjs/melonJS/issues/1646#issuecomment-5550177981) | 최근 안정 릴리스·수정·상세 응답 모두 확인, 활발 |

## 3. 실행 환경 통과 조건

| 후보 | 별도 문서·부모 DOM 비접근 | localStorage 없는 JSON 저장 | 정적 배포·SSR 불필요 | 빌드 없는 사용 | 모바일 터치 | 판정 |
|---|---|---|---|---|---|---|
| Phaser | 자체 canvas 사용 구조 가능 | 자체 상태 DTO와 부모 저장 브리지 | 가능 | UMD 파일 참조 | 통합 pointer·drag | 조건부 적합 |
| PixiJS | 자체 canvas 사용 구조 가능 | 자체 상태 DTO와 부모 저장 브리지 | 가능 | IIFE 파일 참조 | pointer·touch | 조건부 적합 |
| KAPLAY | 자체 canvas 사용 구조 가능 | 저장 helper 대신 자체 브리지 | 가능 | IIFE 파일 참조 | touch API | 조건부 적합 |
| Excalibur | 자체 canvas 사용 구조 가능 | Actor 대신 자체 상태 DTO | 가능 | UMD 파일 참조 | mouse/touch pointer | 조건부 적합 |
| melonJS | 자체 canvas 사용 구조 가능 | 내장 save 대신 자체 브리지 | 가능 | ESM 직접 import는 가능하나 CORS 필수 | pointer/touch | 조건부 적합, 배포 복잡도 불리 |

여기서 적합은 **필수적으로 부모 DOM·쿠키·서버 저장소가 필요한 엔진이라는 근거를 찾지 못했고 요구 구조로 설계할 수 있다**는 문서상 판단이다. 해당 버전을 실제 sandbox에서 부팅한 보증은 아니다. UMD/IIFE는 선호 조건이므로 ESM이라는 이유만으로 melonJS를 필수 제약 탈락 처리하지 않았다. 필수 제약을 충족할 수 없음이 확인된 후보는 이번 조사에서 없으며, 현장 검증 실패 시 해당 후보·배포 경로를 탈락시켜야 한다.

### 모든 후보에 적용되는 자산·저장 경계

1. `allow-same-origin` 없는 sandbox는 불투명 출처다. localStorage·부모 DOM을 사용하지 않고 `postMessage`로만 통신한다. 자식의 메시지 출처가 `"null"`일 수 있으므로 부모가 그 문자열만으로 메시지를 신뢰해서는 안 된다. [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
2. 일반 script 파일을 로드할 수 있다고 해서 이미지의 WebGL 업로드나 fetch/XHR JSON, ESM import까지 성공하는 것은 아니다. 웹 배포에서는 공개 정적 자산에 적절한 CORS를 설정하고, 앱 오프라인 배포에서는 파일 제공 방식에 의존하지 않는 인라인 데이터·data URL 또는 부모가 보내는 자산 데이터 경로를 마련한다. **부모가 만든 blob URL만 전달하면 해결된다고 가정하지 않는다.** 로더가 중간에 다시 외부 URL을 읽지 않아야 한다. [MDN CORS 이미지](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image)
3. 권장 최소 경로는 엔진 UMD를 버전 고정해 앱 정적 자산으로 동봉하고, 지도·아이템 정의는 일반 JS 데이터, 초기 그림은 canvas 생성 텍스처로 구성하는 것이다. 외부 이미지가 필요해지면 자식 안에서 복원할 수 있는 데이터로 전달하거나 인라인화한다. 이는 제안 구조이며 현 WebView에서의 지원 여부는 **확인 못 함**이다.
4. 부모→불투명 출처 자식 응답에는 정확한 일반 origin을 지정할 수 없어 `targetOrigin: "*"`가 필요할 수 있다. 부모는 정확한 iframe의 `contentWindow`로만 송신하고, 수신 시 `event.source`·세션 식별자·메시지 종류·스키마·revision을 검증한다. 자식도 `event.source === parent`와 정해진 세션을 확인한다. 자식→부모에는 부모의 알려진 origin을 사용한다. [MDN postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
5. gzip 파일 크기는 앱의 실제 다운로드·설치 용량이 아니다. 생산 배포는 런타임 CDN 의존 없이 동봉하는 편이 오프라인 요구에 맞다. 웹 정적 호스팅의 응답 헤더와 Capacitor의 로컬 파일 scheme은 서로 별도로 검증해야 한다.

## 4. 기능과 세이브 비교

### Phaser

- **지도·배치:** orthogonal·isometric·staggered·hexagonal 타일맵과 Tiled 연계가 있다. 그리드 좌표 처리에 활용할 수 있지만 가구 footprint, 점유 검사, 회전, 구매 규칙, 길찾기와 동적 물체 앞뒤 정렬은 게임 로직이다. 타일맵 지원을 완성된 건설 시스템으로 해석하면 안 된다. [타일맵 방향 API](https://docs.phaser.io/api-documentation/constant/tilemaps), [공식 아이소메트릭 예제](https://phaser.io/examples/v3/category/tilemap/isometric)
- **표현·씬:** Sprite, 전역 Animation Manager, Scene, 카메라와 Tween을 제공한다. 실내/상점/지도 전환과 HUD 씬 분리가 가능하다. [Scenes](https://docs.phaser.io/phaser/concepts/scenes)
- **터치:** pointer 통합과 drag/drop 지원. 핀치 줌·장기 누름의 게임용 인식 규칙은 별도 구현 또는 플러그인이 필요하다. [Input](https://docs.phaser.io/phaser/concepts/input)
- **세이브:** Registry/Data Manager는 메모리 데이터 관리다. 인벤토리·배치·성장 시각을 별도 plain object로 유지하면 JSON 추출이 쉽다. Scene·Sprite 전체의 자동 저장을 기대하지 않는다. [Data Manager](https://docs.phaser.io/phaser/concepts/data-manager)
- **비용:** 일반 JS와 UMD로 추가 빌드 불필요. 불필요 기능 제거를 위한 커스텀 엔진 번들은 별도 빌드·버전 유지 비용이 생긴다. API 문서 일부는 4.1/3.x 설명이므로 4.2.1의 렌더러 차이는 실제 확인해야 한다.

### PixiJS

- **지도·배치:** 핵심은 렌더러다. `TilingSprite`는 반복 무늬이며 게임 타일맵이 아니다. 타일맵은 [별도 `@pixi/tilemap`](https://github.com/pixijs-userland/tilemap) 또는 직접 구성해야 하고, 아이소메트릭 좌표 변환·점유·깊이 정렬·Tiled 입력도 프로젝트가 책임진다.
- **표현·씬:** Sprite·애니메이션 표현과 Container 기반 scene graph를 제공한다. scene graph는 장면 로딩/전환/저장 수명주기를 갖춘 게임 Scene Manager와 다르다. [Sprite](https://pixijs.com/8.x/guides/components/scene-objects/sprite), [Scene graph](https://pixijs.com/8.x/guides/concepts/scene-graph)
- **터치:** pointer/touch/tap/cancel 및 전역 이동 이벤트 지원. 게임용 드래그 상태와 핀치·스와이프 인식은 자체 구현하거나 추가 라이브러리를 사용한다. [Events](https://pixijs.com/8.x/guides/components/events)
- **세이브:** 엔진의 게임 상태가 없으므로 자체 데이터 모델→JSON 경계는 명료하다. 반대로 씬·시간·경제·오디오 등 조립할 시스템이 많다.
- **비용:** IIFE 직접 사용 가능. 최적화된 모듈 선택이나 추가 생태계 조립에는 번들러가 유리하지만 필수는 아니다. 표의 gzip에 타일맵·사운드·제스처 도구가 포함되지 않았다.

### KAPLAY

- **지도·배치:** `addLevel`의 문자 격자와 컴포넌트 조합으로 작은 방을 만들기 쉽다. 안정판 핵심의 범용 Tiled importer·완성된 아이소메트릭 맵 렌더러는 **확인 못 함**이며 추천 근거에 포함하지 않았다. [안정판 API 목차](https://kaplayjs.com/docs/api/)
- **표현·씬:** sprite·애니메이션·컴포넌트·`scene`/`go` 지원. 씬 전환 때 객체가 소멸하므로 영속 게임 상태를 씬 객체 밖에서 관리해야 한다. [Scenes](https://kaplayjs.com/docs/guides/scenes/)
- **터치:** `onTouchStart` 등 API가 있으며, 안정판 3001.0.19는 터치 좌표 변환 수정을 포함한다. 핀치·가구 회전 제스처는 자체 구현 대상으로 본다. [안정판 API](https://kaplayjs.com/docs/api/), [릴리스 수정사항](https://github.com/kaplayjs/kaplay/releases/tag/3001.0.19)
- **세이브:** 자체 plain object를 JSON으로 보내면 간단하다. `getData`/`setData` 같은 저장 API에 sandbox 영속성을 맡기지 않는다. 일반 객체와 함수·컴포넌트가 섞인 GameObj는 구분해야 한다.
- **비용:** 빌드 없는 가장 작은 배포물. 그러나 안정판과 v4000 알파 문서/API를 섞으면 마이그레이션 부담이 커진다. 작은 탑다운 방 프로토타입에는 적절하지만 본 조사 장르의 지도 제작 도구를 더 많이 직접 만들게 된다.

### Excalibur

- **지도·배치:** 코어 `TileMap`과 `IsometricMap` 지원, tile↔world 좌표 변환과 아이소메트릭 정렬용 컴포넌트를 제공한다. 점유·가구 footprint와 경제 규칙은 직접 작성한다. [TileMap](https://excaliburjs.com/api/class/TileMap/), [IsometricMap](https://excaliburjs.com/api/class/IsometricMap/), [아이소메트릭 안내](https://excaliburjs.com/docs/isometric)
- **Tiled:** 공식 별도 플러그인은 orthogonal/isometric을 렌더링하지만 hexagonal/isometric staggered는 지원하지 않는다. 코어만의 단일 스크립트 구성과 플러그인 포함 구성을 구분해야 한다. 플러그인의 현 CDN 단일 파일과 추가 gzip은 **확인 못 함**이다. [Tiled plugin](https://excaliburjs.com/docs/tiled-plugin/)
- **표현·씬:** Engine→Scene→Actor 구조, SpriteSheet·Animation 지원. [기본 구조](https://excaliburjs.com/docs/getting-started/)
- **터치:** mouse/touch pointer와 여러 접점 지원. 가구 드래그·핀치 등의 게임용 제스처 규칙은 별도로 설계한다. [Mouse and Touch](https://excaliburjs.com/docs/pointers/)
- **세이브:** Actor/ECS를 통째로 직렬화하지 않고 안정 ID, 타일 위치, 아이템 종류, 성장 완료 시각만 JSON에 담는다. TypeScript 지향이라 도메인 모델 타입을 유지하기 좋지만 런타임은 일반 JS로도 사용 가능하다.
- **비용:** UMD로 추가 빌드 불필요. TypeScript 또는 Tiled plugin 기반 템플릿을 택하면 컴파일·번들링·정적 에셋 경로 관리를 추가한다.

### melonJS

- **지도·배치:** Tiled orthogonal·isometric·hexagonal 지원과 여러 레이어를 제공하므로 지도 기능 자체는 장르에 잘 맞는다. 가구 점유·인벤토리·성장 규칙은 별도 구현이다. [공식 기능 소개](https://melonjs.org/)
- **표현·씬:** Sprite·애니메이션·상태/씬 관리와 카메라·오디오를 포함한다. mouse/touch 입력도 제공한다. 완성된 핀치·생활 시뮬레이션 편집 제스처는 **확인 못 함**이다. [공식 저장소](https://github.com/melonjs/melonJS)
- **세이브:** 게임 도메인 객체→JSON을 직접 유지한다. 내장 브라우저 저장 기능에 의존하지 않는다. 지도 정의 파일을 읽는 기능은 플레이어의 배치·시간·경제를 저장하는 기능과 다르다.
- **비용:** 20.3.0은 ESM 단일 파일이므로 CORS 가능한 URL에서 빌드 없이 import할 수 있다. 그러나 앱 로컬 정적 경로의 opaque-origin ESM 로딩이 막히면 인라인 모듈 구성 또는 별도 IIFE 번들링이 필요하다. 현재 원본은 비축소 2.14 MB이며, minify·tree-shaking·번들러 설정과 산출물 검증 비용을 추가해야 용량을 줄일 수 있다. [배포 메타데이터](https://cdn.jsdelivr.net/npm/melonjs@20.3.0/package.json)

공통적으로 **완전한 엔진 객체 그래프의 JSON 왕복 저장은 확인 못 함**이다. 이번 장르에서는 이를 요구하지 않는 편이 유리하다. 저장할 데이터는 화폐·아이템·좌표·방향·개체 ID·시각이고, 스프라이트/텍스처/이벤트는 로드 시 그 데이터에서 재생성하면 된다. 이 부분은 라이브러리 기능 주장이 아닌 제안 설계다.

## 5. 실제 장르 사례

| 후보 | 확인한 사례 | 이 과제에 주는 증거와 한계 |
|---|---|---|
| Phaser | [Weeds & Wires 공식 소개](https://phaser.io/news/2026/06/weeds-wires-card-based-farming-sim-8-at-gamedev-js-jam-2026), [제작자 게임 페이지](https://happybats.itch.io/weeds-and-wires) | 카드 배치→생산→수확→판매 농장 시뮬레이션이며 제작자가 Phaser 사용 명시. 장르 루프와 드래그 배치의 실제 사례. 동물의 숲식 공간·지정 sandbox·최신 버전 검증 사례는 아님 |
| PixiJS | [공식 Showcase의 LEGO City Adventures Build and Protect](https://pixijs.com/showcase) | 건설 테마 인접 사례의 PixiJS 사용 확인. 정확한 경제·생활 시뮬레이션 범위, 개발 버전, 모바일 sandbox 실행은 **확인 못 함** |
| KAPLAY | **확인 못 함** | 공식 문서/API와 게임 관련 검색 범위에서 기술 선택까지 입증되는 타이쿤·생활 시뮬레이션 사례를 확보하지 못함 |
| Excalibur | [공식 Showcase의 Excali-Farm](https://excaliburjs.com/showcase/) | 공식적으로 Tiled plugin을 사용한 작은 농장 게임이라고 소개. 해당 장르의 실행 사례는 있으나 상용 대규모 운영·현재 버전·지정 sandbox 호환 증거는 아님 |
| melonJS | **확인 못 함** | 지도 기능과 타일맵 데모를 실제 생활 시뮬레이션 출시 사례로 대신 기재하지 않음 |

## 6. 추천과 포기하는 것

### 추천: Phaser 4.2.1

선택 기준은 **지도·터치 배치·장면 전환을 처음부터 조립할 양을 줄이는 것**이다. 내장 타일맵과 드래그, 씬·카메라·애니메이션이 있고, 일반 JS/UMD로 별도 게임 빌드 없이 정적 문서에 넣을 수 있다. 실제 농장 자원 생산 게임의 기술 선택도 확인됐다. 복잡한 전투 물리는 켜지 않고 점유 격자를 중심으로 만들면 된다.

포기하는 것은 최소 용량이다. 측정 gzip 약 344.2 KiB는 Excalibur보다 약 200.4 KiB 크고 KAPLAY보다 훨씬 크다. 물리를 꺼도 기성 배포 파일 자체가 작아지는 것은 아니다. 또한 Phaser 4의 새 렌더러에 대해 이전 버전 사례를 모바일 성능 보증으로 사용할 수 없다. 완성된 저장·가구 배치·성장 경제·길찾기 시스템도 제공받지 못한다.

### 차선: Excalibur 0.32.0

**앱 동봉 크기를 더 줄이면서 게임 엔진과 아이소메트릭 기능을 유지해야 한다면** 차선이다. 코어 gzip 약 143.8 KiB, UMD, 내장 TileMap/IsometricMap, Actor/Scene 구조가 있고 농장 게임 사례도 있다. 작은 맵을 plain JS 배열로 정의하면 초기에는 Tiled plugin 없이 시작할 수 있다.

포기하는 것은 Phaser의 통합 타일맵 가져오기·드래그 기능과 더 풍부한 장르 관련 자료를 한꺼번에 사용하는 편의다. Tiled를 도입하면 플러그인의 버전·추가 용량·빌드 경로를 따로 검증해야 한다. 안정 릴리스는 2025-12 이후 공백이 있으며 최신 개발 브랜치의 기능을 0.32.0에 있다고 가정해서는 안 된다.

PixiJS는 좋은 렌더러지만 이 과제에서 절약한 엔진 용량에 비해 씬·맵·제스처를 조립할 일이 늘어난다. KAPLAY는 작은 프로토타입에 강하지만 안정판 공백과 지도 도구 확인 부족 때문에 1·2순위에서 제외했다. melonJS는 지도 기능이 풍부하지만 최신 배포 방식·용량이 빌드 없는 격리 미니앱에 불리하다. 이는 필수 제약 위반 판정이 아닌 목적 적합성 비교다.

## 7. Phaser로 만드는 최소 구조 스케치

아래는 향후 구현을 위한 구성 제안이며 실제 파일·코드는 만들지 않았다. 동물의 숲의 3D 외관을 재현하는 범위가 아니라 2D 또는 2.5D 공간 꾸미기와 시간 기반 성장을 대상으로 한다.

### 파일 구성

| 정적 산출물 내 경로 | 역할 |
|---|---|
| `miniapps/garden/index.html` | iframe 별도 문서, canvas, 문서 안 UI 스타일, 일반 스크립트 로딩 |
| `miniapps/garden/vendor/phaser-4.2.1.min.js` | 버전 고정 엔진 동봉 |
| `miniapps/garden/game.js` | 작은 Boot/Room 씬, 터치 입력, 화면 갱신; 초기에는 하나로 유지 |
| `miniapps/garden/state.js` | 게임 상태·점유 격자·성장 시각·아이템 정의, 순수 JS 데이터 |
| `miniapps/garden/bridge.js` | 준비/복원/저장/ACK 메시지, revision과 재시도 |
| `miniapps/garden/assets.js` | 초기엔 생략 가능. 필요한 경우 인라인 atlas 데이터·그림 데이터 |
| `miniapps/garden/THIRD-PARTY-NOTICES.txt` | 엔진과 실제 사용 에셋의 라이선스 고지 |

Next.js export 산출물에 정적 디렉터리를 포함시키는 구성이다. 부모의 React 컴포넌트 트리에 게임 canvas를 직접 넣거나 서버 라우트를 추가할 필요는 없다. 실제 앱의 public 경로와 배포 설정 적용은 이번 조사에서 수행하지 않았다. 초기 HTML에 위 게임 스크립트를 합치는 것도 가능하지만, 가독성을 위해 정적 파일 여러 개로 나누어도 **빌드 없이 실행**이라는 조건은 유지된다.

### 게임 루프와 시간

1. Boot에서 부모와 세션 handshake를 하고 저장 스냅샷을 요청한다. 응답 전에는 빈 상태를 기존 저장 위에 쓰지 않는다.
2. 버전·스키마를 검증해 화폐, 인벤토리, 배치 좌표, 방향, 성장 완료 시각을 복원한다. 그 데이터에서 Room 씬의 시각 객체를 생성한다.
3. Phaser의 Scene update는 입력·애니메이션·표시를 갱신한다. 경제 계산은 매 프레임 누적하지 않고 완료 시각과 현재 시각으로 판단한다. 잠깐 백그라운드에 다녀와도 성장 결과를 복구하기 쉽다.
4. 배치 확정 시 점유·경계·보유 수량을 검증한 후 데이터 변경→화면 반영→저장 요청 순서로 처리한다. 아이소메트릭을 선택해도 논리 좌표는 행/열로 유지한다.
5. 숨김 상태에서는 렌더링을 쉬고, 복귀 때 경과 시간을 다시 계산한다. 음수 경과 시간과 과도한 오프라인 보상 상한은 명시적으로 처리한다. 서버 권위 시각이 없으므로 단말 시계 조작 방지는 보장하지 않는다.

### 저장 지점과 JSON 범위

- **즉시 저장 요청:** 가구 배치·이동·회수 확정, 구매·판매, 수확, 지역 전환. 드래그 중간 프레임은 저장하지 않는다.
- **보조 저장:** 변경이 남아 있을 때만 짧은 debounce와 주기적 스냅샷, 부모의 앱 숨김/미니앱 종료 알림. 종료 이벤트 하나에만 의존하지 않는다.
- **부모 ACK:** 부모가 실제 영속 저장을 끝내면 revision을 ACK한다. ACK 전에는 미저장 상태로 두고 최신 스냅샷을 재전송한다. 중복 요청은 같은 revision으로 멱등 처리하고 오래된 저장이 최신 상태를 덮지 못하게 한다.
- **스냅샷:** schemaVersion, sessionId, revision, savedAt, coins, inventory, placements(안정 ID·종류·행·열·방향), crops(plantedAt·readyAt·수확 상태). 이벤트 핸들러·엔진 인스턴스·텍스처·DOM은 포함하지 않는다.
- **복원 실패:** 알 수 없는 스키마·손상 데이터·부모 응답 실패를 구분해 표시한다. 기존 스냅샷을 자동 초기화해 덮지 않는다.

### 첫 번째로 만들 가장 작은 플레이 가능한 조각

**6×6 방 하나에서 화분을 놓고, 30초 후 수확하여 의자를 구매·배치하고, 닫았다 열어도 유지되는 루프**를 제안한다. 이 크기·시간·아이템 수는 제품 제안이며 조사 수치가 아니다.

- 시작 자원, 화분 1종, 장식 의자 1종, 수확 자원 1종만 둔다.
- 화분 선택→빈 타일 탭으로 배치, 다시 선택→다른 칸 탭으로 이동한다. 정밀 드래그 없이도 모바일에서 완결되게 한다.
- 성장 진행 표시→수확→의자 구매→배치가 한 번 이어지면 핵심 재미를 볼 수 있다.
- 초기 그림은 생성 텍스처를 사용해 외부 이미지/CORS 변수부터 줄인다. 다음 단계에서 실제 동물·가구 atlas를 넣는다.
- 첫 버전에 NPC 대화·이동 AI·퀘스트·낚시·다중 지역을 넣지 않아도 공간 꾸미기·시간·수집·성장의 연결을 확인할 수 있다.

### 구현 단계에서 필요한 실제 통과 시험

이번에는 실행하지 않았다. 다음 단계의 검증 범위다.

| 범주 | 검증 |
|---|---|
| 정상 경로 | iOS/Android 실제 WebView의 정확한 sandbox에서 부팅, 터치 배치·성장·수확·부모 저장·재진입 복원 |
| 경계 | 지도 가장자리·겹친 가구 거부, 회전/리사이즈, 배치 중 터치 취소, 숨김 후 복귀, 단말 시각 역행 |
| 오류 | 부모 초기화 지연, ACK 유실·중복·역순, 손상 JSON·알 수 없는 버전, 자산/CORS 실패, WebGL context 손실 |
| 배포 | 인터넷 없는 앱 시작, 동봉된 엔진/자산 경로, 부모 DOM·localStorage 접근 없이 전체 루프 완주 |

## 확인 한계

실기기 FPS·메모리·부팅 시간, Capacitor 플랫폼별 자산 scheme과 CSP, 모든 내부 저장소 접근의 소스 감사, 최신 버전별 장르 사례, 전체 이슈 응답 통계는 **확인 못 함**이다. 이들을 추정 수치로 채우지 않았다. 이용 가능한 도구에 Memory·context7·sequential-thinking MCP가 없어 프로젝트 과거 학습 로드와 Memory 기록은 수행하지 못했으며, 공식 웹 문서와 실제 배포물로 사실을 확인했다. 이 문서는 기술 채택을 확정하는 ADR이 아니라 조사·추천 보고서다.
