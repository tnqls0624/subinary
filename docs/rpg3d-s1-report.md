# 3D 슬라이스 1 구현 보고서

2026-09-08. **fixture 구현과 데스크톱 비교 증거 준비 완료. 시각 승인 확인 못 함. 대표 모바일 실기기 첫 프레임 및 모바일 성능 확인 못 함.** 사용자 승인이나 전체 기술 게이트 통과로 판정하지 않는다.

## 사용자에게 먼저 보여 줄 이미지

| 비교 | 파일 | 실제 장면 크기 |
|---|---|---|
| 기존 2D / 3D 세로 | [compare-360x800.png](evidence/rpg3d-s1/compare-360x800.png) | 각각 360×800, 비교 제목 48px 별도 |
| 기존 2D / 3D 가로 | [compare-800x360.png](evidence/rpg3d-s1/compare-800x360.png) | 각각 800×360, 비교 제목 48px 별도 |
| 조명 켜짐 / 없음 세로 | [lighting-360x800.png](evidence/rpg3d-s1/lighting-360x800.png) | 각각 360×800 |
| 조명 켜짐 / 없음 가로 | [lighting-800x360.png](evidence/rpg3d-s1/lighting-800x360.png) | 각각 800×360 |

원본은 같은 폴더의 `3d-360x800.png`, `3d-800x360.png`, 각 `-unlit.png`, `2d-360x800.png`, `2d-800x360.png`다. 실제 브라우저 스크린샷을 CSS 픽셀 원래 크기로 배치했다. 생성 이미지나 리터칭으로 결과를 보정하지 않았다.

2D는 기존 `index.html`·Phaser·`rpg-engine.js` 그대로 실행하고, **검증 서버에서만** bridge를 메모리 fixture로 대체했다. 두 화면 모두 `rules.required[2]`, 논리 `(240,304)` / 3D `(-8.5,h,-2.5)`에 캐릭터를 놓았다. 기존 2D의 HUD·주민·집·길·물은 원래 표시를 유지한다. 이번 3D에는 해당 콘텐츠가 없으며 원근·카메라 배율도 다르다. 화면 크기와 논리 위치를 맞춘 비교이지 콘텐츠나 투영까지 동일한 비교는 아니다.

## 구현 범위

진입 파일: [`apps/web/public/miniapps/backyard/rpg3d-fixture.html`](../apps/web/public/miniapps/backyard/rpg3d-fixture.html). 웹 서버의 `/miniapps/backyard/rpg3d-fixture.html`에서 부모 문서에 canvas 한 개를 직접 그린다. `?lighting=off`로 무조명 상태를 열거나 상단 버튼으로 비교한다. 고정 장면이라 최초 진입·회전·조명 변경·context 복원 때만 렌더링한다.

- **엔진:** Three.js r128 동봉, 603,445B, SHA-256 `9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2`. MIT 라이선스 원문을 `vendor/three-r128.LICENSE`에 동봉했다. 런타임 CDN 요청은 없다. 타입 선언은 개발 의존성 `@types/three` **0.128.0**으로 고정했다.
- **지형:** 기존 규칙의 32×24 단위, 33×25 정점, 1,536삼각형. 완만한 높이맵과 잔디 3톤 vertex color, smooth normal, Lambert 재질이다. `paths`·`water`·`house` 마스크는 높이 평탄화에만 사용한다. 별도 2단위 경계 띠는 실제 경계 정점 높이에 연결한다. 캐릭터와 나무는 렌더 삼각형과 같은 대각선의 barycentric 보간 높이에 접지한다.
- **나무:** `rules.trees`에서 읽은 12개 좌표. 8면 원기둥 줄기 12개와 12×8 구 수관 36개를 두 InstancedMesh로 묶었다. 위치는 변경하지 않고 수관 크기만 변주했다. r128의 인스턴스 경계 제약 때문에 고정 12그루는 frustum culling을 끄고 함께 제출한다.
- **조명:** 반구광 0.75, 방향광 0.9, 설계 팔레트와 방향, PCFSoftShadowMap 1024², 20×20 그림자 영역, bias −0.0002 / normalBias 0.02. `outputEncoding=sRGBEncoding`, `NoToneMapping`; 재질·광원·안개 팔레트는 선형 색으로 변환한다. WebGL clear 배경은 r128의 clear-color 경로에 맞게 sRGB 값을 사용한다.
- **캐릭터:** 한 명, 설계 시작 키 1.35 / 머리 지름 0.66 / 몸 0.48 / 다리 0.23 / 팔 0.30. 머리카락은 머리 표면보다 약간 바깥에 있다. 원기둥+위아래 반구를 합친 몸, 2×1 DataTexture `[140,255]`, nearest 샘플링, mipmap 없음, 툰 재질. 머리·몸·귀에 법선 0.014단위 팽창 BackSide hull을 적용했다. CapsuleGeometry·화면 후처리를 쓰지 않는다.
- **하늘:** 16×8 분할 하늘 반구에 하향 시야용 아래쪽 치마를 연결하고 카메라 중심에 놓았다. 아래 `#E7EAD0` / 위 `#99CBDA` vertex gradient, Basic·BackSide·depthWrite=false, 안개는 `#DCE4C8`, 25~55단위다. 현재 하향 시야에서는 하늘의 하단 색이 주로 보인다.
- **조명 없음의 의미:** 동일 geometry·색·vertex/instance color·카메라에서 Lambert/Toon만 Basic 재질로 교체하고 두 광원과 그림자를 끈다. 완전한 검은 화면을 만드는 실험이 아니라 조명 기여를 제거한 재질색 비교다. 하늘·안개·외곽선은 같다.
- **오류/정리:** 엔진 누락·버전 불일치·WebGL 부팅 실패 안내와 재시도, context loss 안내·restore 재렌더, pagehide 시 geometry/material/texture/shadow render target/renderer 및 이벤트 정리.

제품 이미지 파일은 0개다. 보고용 PNG는 `docs/evidence/`에만 있다. 기존 2D 엔진·규칙·codec·session은 보존했다. 게임 라우트 이동, 저장 연결, 걷기, 주민·채집·낚시·도감·가구, 운영 스택 변경, 빌드·배포는 하지 않았다.

## 기술 검증 결과

| 항목 | 결과 / 증거 |
|---|---|
| JS 구문 검사 | 새 제품 JS 2개·검증 스크립트·동봉 엔진 `node --check` 통과; [artifact-results.json](evidence/rpg3d-s1/artifact-results.json) |
| DOM 타입 검사 | `tsc -p tsconfig.miniapps-dom.json` 통과; [로그](evidence/rpg3d-s1/dom-typecheck.log) |
| 규칙 타입 검사 | `tsc -p tsconfig.miniapps-rules.json` 통과; [로그](evidence/rpg3d-s1/rules-typecheck.log) |
| 웹 타입 검사 | `pnpm --filter @family/web typecheck` 통과; [로그](evidence/rpg3d-s1/web-typecheck.log) |
| 새 지형 테스트 | 5개 통과: 실제 나무 좌표·경계·경사·삼각형 보간·마스크 평탄화·비정상 입력; [로그](evidence/rpg3d-s1/terrain-tests.log) |
| 기존 2D 회귀 포함 | `vitest run game-backyard`: **14파일 / 190테스트 통과**(새 5개 포함); [로그](evidence/rpg3d-s1/backyard-tests.log) |
| 기존 2D 실제 호스트 수명 | 위 회귀 테스트가 실행한 20회 진입/이탈 증거를 [2d-host-lifecycle.json](evidence/rpg3d-s1/2d-host-lifecycle.json)에 복사했다. 이전 증거 파일의 실행별 변경은 원래대로 복구했다. 이는 3D 수명 검증이 아니다. |
| 브라우저 | Chromium 149.0.7827.55, 360×800 / 800×360, canvas 1 / iframe 0, 12그루 / 825정점, 조명 버튼·회전·픽셀 예산·context loss/restore·버전 불일치 오류 UI 통과; [browser-results.json](evidence/rpg3d-s1/browser-results.json) |
| 네트워크·저장 | 3D 페이지는 로컬 HTML/CSS/JS GET 6개만 요청. bridge/session/codec/Phaser/이미지/CDN 요청 없음. Storage 읽기/쓰기 및 fetch를 오류로 바꿔도 부팅·조명 변경·회전 성공. 정상 장면 JS/콘솔 오류 0. |
| 첫 렌더 제출량 | 두 크기 모두 그림자 포함 **37 calls / 25,776삼각형**. `renderer.info.autoReset=false`로 한 render 호출 전체를 계수. 정지 후 재사용 프레임이나 완성 게임 최대 상태의 값이 아니다. |
| 대표 모바일 첫 프레임 | **확인 못 함**. `adb devices -l`에 연결 기기가 없고 booted iOS simulator도 없다. 에뮬레이션은 아래에 별도로 기록. |
| 사용자 시각 승인 | **확인 못 함**. 자체 점수·통과 판정 없음. |

지형 초기 테스트에서 평탄화 전환의 인접 높이 차 0.12896이 한도 0.12를 넘었다. 전환 폭을 2→3단위로 늘리고 모든 정점·인접 간선 테스트를 통과했다. 첫 시각 검증에서는 하늘 아래 검은 영역과 머리카락/몸 외곽선의 면 겹침을 수정했다. r128 타입 패키지의 shadow.map은 빈 RenderTarget 인터페이스로 선언되어 있어 실제 `instanceof WebGLRenderTarget` 검사 후 해제 목록에 등록한다. `any`·타입 검사 무시는 추가하지 않았다.

## 첫 프레임 참고 계측 — 실기기 성능 아님

기준은 navigation time origin부터 최초 shader 컴파일·render 제출 후 **다음 RAF**까지다. GPU 완료·디스플레이 표시 완료 시간이 아니다. 브라우저 HTTP 캐시는 매 실행 비웠지만 GPU/드라이버 shader 캐시까지 초기화한 콜드 부팅이라고 주장하지 않는다. 로컬 HTTP 서버와 데스크톱 GPU를 사용했다.

| 환경 | 1회 | 2회 | 3회 |
|---|---:|---:|---:|
| Pixel 5 화면/UA 에뮬레이션, Chromium, CPU 4배 제한 | 197.10ms | 143.10ms | 129.90ms |
| iPhone 13 화면/UA 에뮬레이션, **Chromium**, CPU 4배 제한 | 198.40ms | 141.00ms | 135.40ms |

일반 데스크톱 360×800 첫 프레임은 186.10ms / 최초 render CPU 구간 74.40ms, 800×360은 95.40ms / 54.20ms다. iPhone 에뮬레이션 결과는 WKWebView 결과가 아니다. 대표 Android·iPhone 첫 프레임, 10분 지속 성능, GPU 시간·GPU 메모리, 앱 WebView 실행은 **확인 못 함**이다. 전체 기술 게이트 및 모바일 합격을 선언하지 않는다.

## §10 항목별 관찰 — 승인 아님

| 항목 | 직접 캡처에서 관찰한 것 | 남아 있는 판단 |
|---|---|---|
| 둥근 형태 | 수관 세 덩어리의 부피와 큰 머리·짧은 팔다리가 보인다. 조명을 끄면 수관은 큰 단색 실루엣으로 바뀐다. 수관 결합 경계와 분할 면, 가로 화면의 직선 지형 외곽은 여전히 눈에 띈다. | 사용자가 이 형태를 선호하는지 확인 못 함. |
| 부드러운 접지 | 발 아래에서 오른쪽으로 이어지는 그림자가 있으며 조명을 끄면 사라진다. 실제 삼각형 높이에 발을 놓았다. PCFSoft 가장자리 완화는 보이지만 넓게 퍼지는 스튜디오 그림자와 같지 않고 나무 그림자는 비교적 또렷하다. | 원하는 부드러움과 조명의 기여가 충분한지 사용자 판단 필요. ‘느낌의 8할’이라는 비율을 입증했다고 쓰지 않는다. |
| 캐릭터 가독성 | 양쪽 크기에서 머리·몸·발의 구분과 올리브 외곽선이 보인다. 기준 키 투영은 화면 높이 **13.53%**, 중심 **56.71%**다. 가로에서는 약 49 CSS px 높이여서 눈 등 세부는 작다. | 작은 화면에서 충분히 명확하고 매력적인지 확인 못 함. |
| 기존 2D 대비 선호 | 동일 화면 크기·논리 위치의 비교 이미지를 제공했다. 3D에서는 캐릭터가 더 크게 보이고, 2D에서는 기존 콘텐츠와 넓은 지도를 더 많이 볼 수 있다. | **3D 선호 확인 못 함.** |

설계서 문장 그대로 적용한다: **“시각 평가는 실제 사용자의 판단이며 작성자의 자체 점수만으로 승인됐다고 쓰지 않는다.”** 코디네이터는 비교 이미지를 사용자에게 전달하고 시각 승인을 확인해야 한다. 실패하면 §10의 조명·팔레트·비율 보정 최대 1일 및 재판정 규칙을 따른다. 이 보고서로 슬라이스 2 이후 진행이나 출하가 승인된 것은 아니다.

## 재현·결정 기록

```sh
# 이미지와 브라우저 증거 재생성: 로컬 임시 서버는 스크립트가 종료 시 정리한다.
node scripts/verify-backyard/rpg3d-s1.mjs > docs/evidence/rpg3d-s1/browser-run.log 2>&1
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json
pnpm --filter @family/web typecheck
pnpm --filter @family/web exec vitest run game-backyard > docs/evidence/rpg3d-s1/backyard-tests.log 2>&1
# 직접 보기: 별도 터미널에서 실행 후 /miniapps/backyard/rpg3d-fixture.html 방문
python3 -m http.server 4318 --bind 127.0.0.1 --directory apps/web/public
```

브라우저 스크립트는 기존 검증 스크립트와 같은 Playwright 설치 위치를 사용하며 `PLAYWRIGHT_MODULE`로 경로를 지정할 수 있다.

**ADR-S1-01:** 슬라이스 경계를 지키기 위해 별도 정적 fixture 진입점을 두고 기존 앱 라우트와 저장 그래프를 유지한다. 지도는 `rpg-rules.js`, 시각 높이와 좌표 변환은 순수 `rpg3d-terrain.js`, Three 자원·DOM 수명은 `rpg3d-fixture.js`가 맡는다. 저장 변환 API나 이동 controller를 미리 만들지 않는다.

Memory·context7·sequential-thinking MCP는 사용 가능한 도구 목록에서 찾지 못했다. 과거 학습 로드, Memory ADR·학습 등록은 **확인 못 함**이며 이 문서에 대체 기록했다. r128 API는 [WebGLRenderer 원문](https://raw.githubusercontent.com/mrdoob/three.js/r128/src/renderers/WebGLRenderer.js), [geometry 목록](https://raw.githubusercontent.com/mrdoob/three.js/r128/src/geometries/Geometries.js), [툰 조명 셰이더](https://raw.githubusercontent.com/mrdoob/three.js/r128/src/renderers/shaders/ShaderChunk/lights_toon_pars_fragment.glsl.js)와 고정 타입 선언을 확인했다. Task Master 태스크가 아닌 Orca에서 배정한 구현 작업이다.

반복 방지 기록: 높이의 전체 범위와 인접 경사 제한은 따로 검사한다; 렌더러의 버전과 타입 패키지 버전을 맞추고 런타임 검사를 유지한다; 구·캡슐 외곽선을 부품마다 중복하면 내부 검은 링이 생길 수 있다; clear 배경과 재질의 r128 색 처리 경로를 구분한다; 브라우저 캡처·모바일 에뮬레이션·실기기 성능·사용자 시각 승인을 서로 대체하지 않는다.

---

## 시각 승인 — 통과 (2026-09-08, 사용자 판정)

설계서 §10이 후속 슬라이스를 이 게이트로 막아 두었다. 워커는 스스로 판정하지 않고
**"시각 승인 확인 못 함"**으로 남겼고, 코디네이터가 비교 증거 두 장을 사용자에게 제시했다.

- `docs/evidence/rpg3d-s1/compare-360x800.png` — 같은 지도 위치의 2D / 3D
- `docs/evidence/rpg3d-s1/lighting-360x800.png` — 같은 기하에서 조명만 끈 것

**사용자 판정: "좋다 이어서 진행해".** 2D 대비 선호가 확인됐으므로 슬라이스 2 이후를 연다.

기록해 둘 것 — 조명 비교가 설계 근거를 눈으로 확인시켰다. 기하가 동일한데 그림자와
명암을 빼면 다시 납작해진다. "동물의 숲 느낌은 정교한 그림이 아니라 둥근 형태에 얹힌
부드러운 조명에서 온다"가 이 프로젝트에서 검증된 명제가 됐다. 이후 슬라이스에서
성능 때문에 품질을 낮출 때 **그림자를 가장 마지막에 버려야 하는 이유**가 이것이다.

여전히 미확인: 실기기 첫 프레임·지속 성능(슬라이스 8), 실제 OTA ZIP 절감(슬라이스 9).
